'use strict';

const helper = require('node-red-node-test-helper');
const { AlicatSimulator } = require('../../tools/sim/AlicatSimulator');
const { getRegistry } = require('../../lib/ConnectionRegistry');
const { until } = require('./wait');
const { LANE } = require('./device');

helper.init(require.resolve('node-red'));
// The simulators run a 20 ms device cycle (hardware: ~120 ms), so the command lane can be quick too.
getRegistry().deviceDefaults = { lane: LANE };

const NODES = [
    require('../../nodes/alicat-device'),
    require('../../nodes/alicat-read'),
    require('../../nodes/alicat-setpoint'),
    require('../../nodes/alicat-command'),
    require('../../nodes/alicat-pid'),
    require('../../nodes/alicat-status'),
    require('../../nodes/alicat-control')
];

/**
 * Start a simulator and return a config-node definition pointing at it.
 * @param {string} [profile]
 * @param {Record<string, unknown>} [config]
 * @param {Record<string, unknown>} [simOptions]
 */
async function startDevice(profile = '10v20-bench', config = {}, simOptions = {}) {
    const sim = await new AlicatSimulator({ profile, commandCycleMs: 20, tauMs: 20, maxConnections: 2, ...simOptions }).start();
    const device = {
        id: 'dev1', type: 'alicat-device', name: 'Test MFC', host: '127.0.0.1', port: sim.port, unitId: 1,
        requestTimeout: 500, interFrameDelay: 0, heartbeat: 0, ...config
    };
    return { sim, device };
}

/** Collect messages arriving at a helper node. @param {import('node-red-node-test-helper').TestNode} node */
function collect(node) {
    /** @type {any[]} */
    const messages = [];
    node.on('input', (/** @type {any} */ msg) => messages.push(msg));
    return messages;
}

/** Unload flows and close every connection the registry still holds. */
async function cleanup() {
    await helper.unload();
    await getRegistry().closeAll();
}

/**
 * Wait until no device is busy with anything but polling: every command lane
 * empty and nothing urgent or control queued or in flight, for a few checks
 * in a row (message delivery between nodes is asynchronous).
 * @param {number} [timeoutMs]
 */
async function quiet(timeoutMs = 8000) {
    const registry = getRegistry();
    const busy = () => registry.list().some((e) => {
        const live = registry.find(e.host, e.port);
        if (!live) return false;
        const { depth } = live.client.stats();
        return live.device.lane.depth > 0 || depth[0] > 0 || depth[1] > 0;
    });
    let calm = 0;
    await until(() => {
        calm = busy() ? 0 : calm + 1;
        return calm >= 6;
    }, timeoutMs, 'quiet devices');
}

module.exports = { helper, NODES, startDevice, until, quiet, collect, cleanup };
