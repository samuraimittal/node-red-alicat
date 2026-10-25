'use strict';

/**
 * Characterisation of the command lane: for each scenario, the exact writes to
 * the command registers and the fields of the result or error. These pin the
 * handshake measured on hardware (NOP first, settle, command, poll), so moving
 * the lane's code around cannot change what reaches the device.
 */

const assert = require('node:assert/strict');
const { AlicatClient } = require('../../lib/AlicatClient');
const { CommandLane } = require('../../lib/CommandLane');
const { Priority } = require('../../lib/PriorityQueue');
const { AlicatSimulator } = require('../../tools/sim/AlicatSimulator');
const { REG } = require('../../lib/alicat/registers');
const { until } = require('../helpers/wait');
const { CLIENT, LANE } = require('../helpers/device');

/** Register names in the recorded writes. @type {Map<number, string>} */
const NAMES = new Map([[REG.EXT_COMMAND_ID, 'ext'], [REG.LIMITED_COMMAND_ID, 'lim'], [REG.SETPOINT, 'sp']]);

/**
 * The fields that matter of a result or an error.
 * @param {unknown} value
 */
function summary(value) {
    const v = /** @type {Record<string, unknown>} */ (value);
    const keys = value instanceof Error
        ? ['code', 'outcome', 'command', 'status', 'statusName']
        : ['outcome', 'interface', 'status', 'statusName', 'returnValue', 'queuedBehind', 'superseded'];
    return Object.fromEntries(keys.filter((k) => v[k] !== undefined).map((k) => [k, v[k]]));
}

/** @param {string} profile */
async function bench(profile) {
    const sim = await new AlicatSimulator({ profile, commandCycleMs: 20, tauMs: 20, maxConnections: 2 }).start();
    const client = new AlicatClient({ host: '127.0.0.1', port: sim.port, ...CLIENT });
    client.start();
    await until(() => client.isOnline);
    /** @type {string[]} */
    const writes = [];
    sim.server.on('request', (/** @type {{fc: number, address: number, values?: number[]}} */ r) => {
        const name = NAMES.get(r.address + 1);
        if (r.fc === 16 && name && r.values) writes.push(`${name} ${r.values.join(',')}`);
    });
    const extended = profile !== '9v07-bench';
    const lane = new CommandLane({ client, unitId: 1, useExtended: () => extended, ...LANE });
    return { sim, client, lane, writes };
}

describe('CommandLane characterisation (writes and results)', function () {
    this.timeout(10000);
    /** @type {Awaited<ReturnType<typeof bench>>} */
    let b;

    afterEach(async () => {
        b.lane.close();
        await b.client.stop();
        await b.sim.stop();
    });

    /** Another master starts a timed command (id 33 runs for `ms` on the simulator). @param {number} ms */
    async function foreign(ms) {
        await b.client.writeRegisters(1, REG.EXT_COMMAND_ID, [0, 33, 0, ms]);
        await until(() => b.sim.engine.running !== null);
    }

    it('extended: a NOP, then the command', async () => {
        b = await bench('10v20-bench');
        const r = await b.lane.run({ id: 7, arg: 1 });
        assert.deepEqual(b.writes, ['ext 0,0,0,0', 'ext 0,7,0,1']);
        assert.deepEqual(summary(r), { outcome: 'executed', interface: 'extended', status: 0, statusName: 'SUCCESS', returnValue: null, queuedBehind: null });
    });

    it('limited: the same over the 16-bit registers', async () => {
        b = await bench('9v07-bench');
        const r = await b.lane.run({ id: 7, arg: 1 });
        assert.deepEqual(b.writes, ['lim 0,0', 'lim 7,1']);
        assert.deepEqual(summary(r), { outcome: 'executed', interface: 'limited', status: 0, statusName: 'SUCCESS', returnValue: null, queuedBehind: null });
    });

    it('repeat: a NOP before each of two identical commands', async () => {
        b = await bench('10v20-bench');
        await b.lane.run({ id: 7, arg: 1 });
        await b.lane.run({ id: 7, arg: 1 });
        assert.deepEqual(b.writes, ['ext 0,0,0,0', 'ext 0,7,0,1', 'ext 0,0,0,0', 'ext 0,7,0,1']);
    });

    it('foreign command: waits it out, then NOP and command', async () => {
        b = await bench('10v20-bench');
        await foreign(150);
        const r = await b.lane.run({ id: 7, arg: 1 });
        assert.deepEqual(b.writes, ['ext 0,33,0,150', 'ext 0,0,0,0', 'ext 0,7,0,1']);
        assert.deepEqual(summary(r).queuedBehind, null);
    });

    it('urgent behind a foreign command: no waiting, NOP and command, reported as queued behind it', async () => {
        b = await bench('10v20-bench');
        await foreign(150);
        const r = await b.lane.run({ id: 6, arg: 1, priority: Priority.URGENT });
        assert.deepEqual(b.writes, ['ext 0,33,0,150', 'ext 0,0,0,0', 'ext 0,6,0,1']);
        assert.deepEqual(summary(r), { outcome: 'executed', interface: 'extended', status: 0, statusName: 'SUCCESS', returnValue: null, queuedBehind: { id: 33, arg: 150 } });
    });

    it('dropped, repeat-safe: sent again after a NOP', async () => {
        b = await bench('10v20-bench');
        b.sim.engine.dropNextCommands = 1;
        const r = await b.lane.run({ id: 7, arg: 1, retryIfDropped: true });
        assert.deepEqual(b.writes, ['ext 0,0,0,0', 'ext 0,7,0,1', 'ext 0,0,0,0', 'ext 0,7,0,1']);
        assert.equal(summary(r).outcome, 'executed');
    });

    it('dropped, not repeat-safe: never resent, ends unknown', async () => {
        b = await bench('10v20-bench');
        b.sim.engine.dropNextCommands = 1;
        const err = await b.lane.run({ id: 4, arg: 2, timeoutMs: 1500 }).catch((e) => e);
        assert.deepEqual(b.writes, ['ext 0,0,0,0', 'ext 0,4,0,2']);
        assert.deepEqual(summary(err), { code: 'ETIMEDOUT', outcome: 'unknown', command: 4 });
    });

    it('rejected: ECOMMAND with the device status', async () => {
        b = await bench('10v20-bench');
        const err = await b.lane.run({ id: 999, arg: 0 }).catch((e) => e);
        assert.deepEqual(b.writes, ['ext 0,0,0,0', 'ext 0,999,0,0']);
        assert.deepEqual(summary(err), { code: 'ECOMMAND', outcome: 'rejected', command: 999, status: 2, statusName: 'INVALID_ID' });
    });

    it('limited, rejected: the device status from the 0x8000 result', async () => {
        b = await bench('9v07-bench');
        const err = await b.lane.run({ id: 999, arg: 0 }).catch((e) => e);
        assert.deepEqual(b.writes, ['lim 0,0', 'lim 999,0']);
        assert.deepEqual(summary(err), { code: 'ECOMMAND', outcome: 'rejected', command: 999, status: 2, statusName: 'INVALID_ID' });
    });

    it('pre-empted: a running command gives way to an urgent one', async () => {
        b = await bench('10v20-bench');
        const slow = b.lane.run({ id: 33, arg: 400 }).catch((e) => e);
        await until(() => b.sim.engine.running !== null);
        const urgent = await b.lane.run({ id: 6, arg: 1, priority: Priority.URGENT });
        assert.deepEqual(summary(await slow), { code: 'EPREEMPTED', outcome: 'unknown', command: 33 });
        assert.deepEqual(b.writes, ['ext 0,0,0,0', 'ext 0,33,0,400', 'ext 0,0,0,0', 'ext 0,6,0,1']);
        assert.deepEqual(summary(urgent).queuedBehind, { id: 33, arg: 400 });
    });

    it('timeout and cancel: both may have reached the device, so unknown', async () => {
        b = await bench('10v20-bench');
        const late = await b.lane.run({ id: 33, arg: 1000, timeoutMs: 300 }).catch((e) => e);
        assert.deepEqual(summary(late), { code: 'ETIMEDOUT', outcome: 'unknown', command: 33 });
        await until(() => b.sim.engine.running === null, 2000);
        const owner = Symbol('node');
        const cancelled = b.lane.run({ id: 33, arg: 400, owner }).catch((e) => e);
        await until(() => b.sim.engine.running !== null);
        b.lane.cancelOwner(owner);
        assert.deepEqual(summary(await cancelled), { code: 'ECANCELED', outcome: 'unknown', command: 33 });
        assert.deepEqual(b.writes, ['ext 0,0,0,0', 'ext 0,33,0,1000', 'ext 0,0,0,0', 'ext 0,33,0,400']);
    });
});
