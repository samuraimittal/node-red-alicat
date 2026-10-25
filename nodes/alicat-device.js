'use strict';

const { getRegistry } = require('../lib/ConnectionRegistry');
const { registerAdminApi } = require('../lib/node-red/admin-api');
const { BOUNDS, settingsReader } = require('../lib/node-red/settings');
const { parseLabels } = require('../lib/node-red/props');
const legacy = require('../lib/alicat/profiles/legacy');
const statistics = require('../lib/alicat/statistics');
const { MAP_MODES } = require('../lib/AlicatDevice');

/**
 * @typedef {import('../lib/node-red/types').NodeRedNode} NodeRedNode
 * @typedef {import('../lib/node-red/types').NodeConfig} NodeConfig
 * @typedef {import('../lib/node-red/types').AlicatDeviceConfigNode} AlicatDeviceConfigNode
 * @typedef {InstanceType<typeof import('../lib/ConnectionRegistry').Lease>} Lease
 */

/** @param {import('../lib/node-red/types').NodeRedRuntime} RED */
module.exports = function (RED) {
    const registry = getRegistry();
    registry.attach(RED.events);
    registerAdminApi(RED, registry);

    /**
     * The config node: one instrument's address and settings. It holds the
     * device's connection lease for as long as it exists.
     * @this {NodeRedNode}
     * @param {NodeConfig} config
     */
    function AlicatDeviceNode(config) {
        RED.nodes.createNode(this, config);
        const node = /** @type {AlicatDeviceConfigNode} */ (this);
        const read = settingsReader(config);
        const limits = BOUNDS.device;
        const problems = read.problems;

        node.name = read.text('name');
        node.host = read.text('host').trim();
        if (!node.host) problems.push('host is required');
        node.port = read.number('port', limits.port, 'Port');
        node.unitId = read.number('unitId', limits.unitId, 'Unit ID');

        /** @type {import('../lib/AlicatClient').ClientSettingsUpdate} */
        const clientOptions = {
            requestTimeoutMs: read.number('requestTimeout', limits.requestTimeout, 'Request timeout'),
            connectTimeoutMs: read.number('connectTimeout', limits.connectTimeout, 'Connect timeout'),
            interFrameDelayMs: read.number('interFrameDelay', limits.interFrameDelay, 'Request gap'),
            heartbeatMs: read.number('heartbeat', limits.heartbeat, 'Heartbeat'),
            backoffMaxMs: read.number('backoffMax', limits.backoffMax, 'Max retry delay'),
            maxQueueDepth: read.number('maxQueue', limits.maxQueue, 'Queue depth')
        };
        if (read.flag('trace', false)) {
            clientOptions.trace = (dir, data) => node.log(`${dir} ${data.toString('hex')}`);
        }

        const layoutChoice = read.text('layout', 'auto');
        /** @type {string | string[] | null} */
        const layout = layoutChoice === 'custom'
            ? read.text('customLayout').split(',').map((s) => s.trim()).filter(Boolean)
            : layoutChoice === 'auto' ? null : layoutChoice;
        const controlVariable = read.text('controlVariable', 'unknown');
        try {
            if (layout) legacy.validateLayout(layout);
            if (controlVariable !== 'unknown') statistics.controlVariable(controlVariable);
        } catch (err) {
            problems.push(/** @type {Error} */ (err).message);
        }
        /** @type {import('../lib/AlicatDevice').DeviceSettingsUpdate} */
        const deviceOptions = {
            mapMode: read.choice('mapMode', MAP_MODES, 'auto', 'Register map'),
            deviceType: read.choice('deviceType', legacy.DEVICE_TYPES, 'auto', 'Device type'),
            layout,
            controlVariable,
            unitLabels: parseLabels(config.unitLabels)
        };
        node.problems = problems;
        if (problems.length > 0) {
            node.error(`Invalid Alicat device configuration: ${problems.join('; ')}`);
        }

        /** @type {Lease | null} */
        let lease = null;
        const onLog = (/** @type {{level: string, message: string}} */ l) => (l.level === 'warn' ? node.warn(l.message) : node.log(l.message));
        const onWarning = (/** @type {string} */ w) => node.warn(w);

        /**
         * Take the connection lease on the first user, so an unused config
         * node never occupies the device's connection.
         */
        node.acquire = () => {
            if (problems.length > 0) {
                throw new Error(`Invalid Alicat device configuration: ${problems.join('; ')}`);
            }
            if (!lease) {
                lease = registry.acquire({
                    host: node.host, port: node.port, unitId: node.unitId, owner: node.id, clientOptions, deviceOptions, onWarning
                });
                lease.client.on('log', onLog);
                lease.client.on('warning', onWarning);
                lease.device.on('warning', onWarning);
            }
            return lease;
        };

        /** The lease lives as long as this config node; users releasing it changes nothing. */
        node.release = () => {};

        node.on('close', (_removed, done) => {
            if (lease) {
                lease.client.removeListener('log', onLog);
                lease.client.removeListener('warning', onWarning);
                lease.device.removeListener('warning', onWarning);
                lease.release();
                lease = null;
            }
            done();
        });
    }

    RED.nodes.registerType('alicat-device', AlicatDeviceNode);
};
