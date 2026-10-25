'use strict';

const { AlicatError } = require('../errors');
const { StatusReporter, shortError } = require('./status');
const { settingsReader } = require('./settings');
const { alicatInfo, attachError } = require('./message');
const { evaluate } = require('./props');

/**
 * @typedef {import('./types').NodeRedRuntime} NodeRedRuntime
 * @typedef {import('./types').NodeRedNode} NodeRedNode
 * @typedef {import('./types').NodeConfig} NodeConfig
 * @typedef {import('./types').NodeMessage} NodeMessage
 * @typedef {import('./types').SendFn} SendFn
 * @typedef {import('./types').StatusObject} StatusObject
 * @typedef {import('./types').DeviceMeta} DeviceMeta
 * @typedef {import('./types').AlicatDeviceConfigNode} AlicatDeviceConfigNode
 * @typedef {import('./message').Op} Op
 * @typedef {import('./settings').SettingsReader} SettingsReader
 * @typedef {InstanceType<typeof import('../AlicatDevice').AlicatDevice>} Device
 * @typedef {InstanceType<typeof import('../AlicatClient').AlicatClient>} Client
 * @typedef {import('../AlicatDevice').Identity} Identity
 *
 * @typedef {{
 *   node: NodeRedNode,
 *   device: Device,
 *   client: Client,
 *   owner: symbol,
 *   status: InstanceType<typeof StatusReporter>,
 *   meta(): DeviceMeta,
 *   info(fields?: object): DeviceMeta & {op: Op},
 *   evaluate(msg: NodeMessage, value: string, type: string): Promise<unknown>,
 *   handleInput(statusPrefix: string | null, handler: (msg: NodeMessage, send: SendFn) => void | Promise<void>): void,
 *   onClose(cleanup: () => void | Promise<void>): void
 * }} DeviceNodeContext
 *   What a node's setup gets:
 *   - `owner`: per node INSTANCE (not node.id), so a late cleanup from an old
 *     instance after a redeploy can never cancel the new instance's work;
 *   - `info(fields)`: msg.alicat for a successful operation;
 *   - `handleInput`: the input pipeline (see defineDeviceNode);
 *   - `onClose`: the node's own cleanup, run before its requests are cancelled.
 */

/**
 * @param {AlicatDeviceConfigNode} config
 * @param {Identity | null} identity
 * @returns {DeviceMeta}
 */
function metaOf(config, identity) {
    return {
        device: config.name || `${config.host}:${config.port}`,
        host: config.host,
        port: config.port,
        unitId: config.unitId,
        generation: identity ? identity.generation : null,
        firmware: identity ? identity.firmware : null,
        serial: identity ? identity.serial : null
    };
}

/**
 * A node that can't work (no device, invalid settings): show why, log it once,
 * and fail every message with EINVALIDARG so a Catch node sees it.
 * @param {NodeRedNode} node @param {Op} op @param {DeviceMeta | null} meta
 * @param {StatusObject} status @param {string} message
 */
function failInputs(node, op, meta, status, message) {
    node.status(status);
    node.error(message);
    node.on('input', (msg, _send, done) => {
        const err = new AlicatError('EINVALIDARG', message, { outcome: 'not-sent' });
        attachError(msg, err, meta, op);
        done(err);
    });
}

/**
 * Register a node type that works through an alicat-device config node, with
 * the behaviour all of them share:
 * - Settings are read and checked first, so an invalid configuration never
 *   opens a connection.
 * - With no device or invalid settings, the node shows a red status, logs one
 *   error, and fails every input with EINVALIDARG.
 * - `ctx.handleInput(prefix, fn)` runs `fn(msg, send)` and then `done()`. On
 *   an error it replaces msg.alicat with the error, shows "prefix: reason"
 *   (when a prefix is given), and calls `done(err)`.
 * - One close handler, in a fixed order: the node's own cleanups (newest
 *   first), the status, this node's queued requests, then the device lease.
 *
 * @template S
 * @param {NodeRedRuntime} RED
 * @param {{type: string, op: Op, settings: (read: SettingsReader) => S, setup: (ctx: DeviceNodeContext, settings: S) => void}} spec
 */
function defineDeviceNode(RED, spec) {
    /** @this {NodeRedNode} @param {NodeConfig} config */
    function AlicatNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        const read = settingsReader(config);
        const settings = spec.settings(read);
        const deviceConfig = /** @type {AlicatDeviceConfigNode | null} */ (RED.nodes.getNode(String(config.device ?? '')));
        if (!deviceConfig) {
            failInputs(node, spec.op, null, { fill: 'red', shape: 'ring', text: 'no device' }, 'No alicat device is selected for this node');
            return;
        }
        const invalid = { fill: 'red', shape: 'dot', text: 'invalid config' };
        if (read.problems.length > 0) {
            failInputs(node, spec.op, metaOf(deviceConfig, null), invalid, `Invalid settings: ${read.problems.join('; ')}`);
            return;
        }
        /** @type {InstanceType<typeof import('../ConnectionRegistry').Lease>} */
        let lease;
        try {
            lease = deviceConfig.acquire(node);
        } catch (err) {
            failInputs(node, spec.op, metaOf(deviceConfig, null), invalid, /** @type {Error} */ (err).message);
            return;
        }
        const { device, client } = lease;
        const owner = Symbol(node.id);
        const status = new StatusReporter(node, client, device);
        /** @type {(() => void | Promise<void>)[]} */
        const cleanups = [];
        const meta = () => metaOf(deviceConfig, device.identity);

        /** @type {DeviceNodeContext} */
        const ctx = {
            node,
            device,
            client,
            owner,
            status,
            meta,
            info: (fields) => alicatInfo(meta(), spec.op, fields),
            evaluate: (msg, value, type) => evaluate(RED, node, msg, value, type),
            handleInput(statusPrefix, handler) {
                node.on('input', async (msg, send, done) => {
                    try {
                        await handler(msg, send);
                        done();
                    } catch (err) {
                        attachError(msg, err, meta(), spec.op);
                        if (statusPrefix) status.warn(`${statusPrefix}: ${shortError(err)}`);
                        done(err);
                    }
                });
            },
            onClose(cleanup) {
                cleanups.push(cleanup);
            }
        };

        node.on('close', async (_removed, done) => {
            try {
                for (const cleanup of [...cleanups].reverse()) {
                    try {
                        await cleanup();
                    } catch (err) {
                        node.warn(`Cleanup on close failed: ${/** @type {Error} */ (err).message}`);
                    }
                }
                status.close();
                device.cancelOwner(owner);
                deviceConfig.release(node);
            } finally {
                done();
            }
        });

        spec.setup(ctx, settings);
    }

    RED.nodes.registerType(spec.type, AlicatNode);
}

module.exports = { defineDeviceNode, metaOf };
