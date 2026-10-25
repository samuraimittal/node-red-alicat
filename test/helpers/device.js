'use strict';

const { AlicatClient } = require('../../lib/AlicatClient');
const { AlicatDevice } = require('../../lib/AlicatDevice');
const { AlicatSimulator } = require('../../tools/sim/AlicatSimulator');

/** Client timings for tests against a simulator: fast timeouts and retries, no heartbeat or pacing. */
const CLIENT = Object.freeze({ requestTimeoutMs: 300, backoffInitialMs: 40, backoffMaxMs: 200, heartbeatMs: 0, interFrameDelayMs: 0, lateReplyGraceMs: 20 });
/** Command-lane timings for a simulator whose device cycle is 20 ms. */
const LANE = Object.freeze({ nopSettleMs: 60, pollIntervalMs: 20 });

/**
 * A simulator, a started client on it and a device, with fast test timings.
 * @param {string} profile
 * @param {import('../../lib/AlicatDevice').DeviceOptions} [deviceOptions]
 * @param {Record<string, unknown>} [simOptions]
 */
async function setup(profile, deviceOptions = {}, simOptions = {}) {
    const sim = await new AlicatSimulator({ profile, commandCycleMs: 20, tauMs: 20, maxConnections: 2, ...simOptions }).start();
    const client = new AlicatClient({ host: '127.0.0.1', port: sim.port, ...CLIENT });
    const device = new AlicatDevice(client, { lane: LANE, effectTimeoutMs: 400, identifyRetryMs: 100, ...deviceOptions });
    client.start();
    return { sim, client, device };
}

/** Close what setup() opened. @param {Awaited<ReturnType<typeof setup>> | null} ctx */
async function teardown(ctx) {
    if (!ctx) return;
    ctx.device.close();
    await ctx.client.stop();
    await ctx.sim.stop();
}

module.exports = { CLIENT, LANE, setup, teardown };
