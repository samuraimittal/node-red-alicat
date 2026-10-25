'use strict';

const { defineDeviceNode } = require('../lib/node-red/device-node');
const { BOUNDS } = require('../lib/node-red/settings');
const { formatValue } = require('../lib/node-red/status');
const { ContextPublisher } = require('../lib/ContextPublisher');

/**
 * @typedef {import('../lib/AlicatDevice').Snapshot} Snapshot
 * @typedef {import('../lib/node-red/types').NodeMessage} NodeMessage
 */

/** @param {import('../lib/node-red/types').NodeRedRuntime} RED */
module.exports = function (RED) {
    defineDeviceNode(RED, {
        type: 'alicat-read',
        op: 'read',
        settings: (read) => ({
            trigger: read.choice('trigger', /** @type {const} */ (['interval', 'input']), 'interval', 'Trigger'),
            intervalMs: read.number('interval', BOUNDS.read.interval, 'Interval'),
            dataset: read.choice('dataset', /** @type {const} */ (['live', 'identity']), 'live', 'Data'),
            output: read.choice('output', /** @type {const} */ (['object', 'value']), 'object', 'Output'),
            reading: read.text('reading', 'massFlow'),
            onlyOnChange: read.choice('emit', /** @type {const} */ (['always', 'change']), 'always', 'Send') === 'change',
            topic: read.text('topic'),
            contextKey: read.text('contextKey'),
            contextScope: read.choice('contextScope', /** @type {const} */ (['global', 'flow']), 'global', 'Context scope'),
            contextStore: read.text('contextStore')
        }),
        setup(ctx, settings) {
            const { node, device, owner, status } = ctx;
            const { output, reading, topic } = settings;

            /** @type {InstanceType<typeof ContextPublisher> | null} */
            let publisher = null;
            if (settings.contextKey) {
                const scope = settings.contextScope;
                try {
                    publisher = new ContextPublisher({
                        context: scope === 'flow' ? node.context().flow : node.context().global,
                        scope, key: settings.contextKey, owner: node.id,
                        ...(node.z ? { flowId: node.z } : {}),
                        ...(settings.contextStore ? { store: settings.contextStore } : {})
                    });
                } catch (err) {
                    node.warn(/** @type {Error} */ (err).message);
                }
            }

            /** @param {Snapshot} snap */
            const statusText = (snap) => {
                const key = output === 'value' ? reading
                    : (snap.values.massFlow !== undefined ? 'massFlow' : Object.keys(snap.values)[0]);
                return key === undefined ? '—' : formatValue(snap.values[key], snap.units[key]);
            };

            /** @param {Snapshot} snap @param {NodeMessage} msg */
            const build = (snap, msg) => {
                msg.payload = output === 'value' ? (snap.values[reading] ?? null) : { ...snap.values };
                msg.topic = topic || (output === 'value' ? reading : ctx.meta().device);
                msg.alicat = ctx.info({
                    ts: snap.ts,
                    quality: snap.quality,
                    ageMs: snap.ageMs,
                    rttMs: snap.rttMs,
                    units: snap.units,
                    setpoint: snap.setpoint,
                    controlledVariable: snap.controlledVariable,
                    gas: snap.gas,
                    status: snap.status,
                    alarms: snap.alarms,
                    ...(snap.error ? { error: snap.error } : {})
                });
                return msg;
            };

            /** @param {Snapshot} snap */
            const show = (snap) => {
                if (snap.quality === 'good') status.ready(statusText(snap));
                else if (snap.quality === 'stale') status.warn('stale data');
            };

            /** @type {string | null} */
            let lastPublishError = null;
            /**
             * Publish after the message is sent, so a context store that fails
             * (e.g. an async-only store) can't stop the flow's messages.
             * @param {Snapshot} snap
             */
            const publish = (snap) => {
                if (!publisher) return;
                try {
                    publisher.publish(snap, device.identity);
                    lastPublishError = null;
                } catch (err) {
                    const message = `Could not publish to context: ${/** @type {Error} */ (err).message}`;
                    if (message !== lastPublishError) node.warn(message);
                    lastPublishError = message;
                }
            };

            /** @type {string | null} */
            let lastSignature = null;
            /** "Only on change" applies to interval and input-triggered reads alike. @param {Snapshot} snap */
            const changed = (snap) => {
                const signature = JSON.stringify([snap.values, snap.quality, snap.status.raw, snap.gas.number]);
                if (settings.onlyOnChange && signature === lastSignature) return false;
                lastSignature = signature;
                return true;
            };

            if (settings.trigger === 'interval' && settings.dataset === 'live') {
                device.subscribe(owner, { intervalMs: settings.intervalMs }, (snap) => {
                    show(snap);
                    if (changed(snap)) node.send(build(snap, {}));
                    publish(snap);
                });
            }

            ctx.handleInput('read', async (msg, send) => {
                if (settings.dataset === 'identity') {
                    const identity = await device.ready();
                    msg.payload = JSON.parse(JSON.stringify(identity));
                    msg.topic = topic || msg.topic;
                    msg.alicat = ctx.info();
                    send(msg);
                    return;
                }
                const snap = await device.readLive({ owner });
                show(snap);
                if (changed(snap)) send(build(snap, msg));
                publish(snap);
            });

            ctx.onClose(() => {
                if (publisher) publisher.release();
            });
        }
    });
};
