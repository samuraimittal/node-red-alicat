'use strict';

const assert = require('node:assert/strict');
const { AlicatClient } = require('../../lib/AlicatClient');
const { AlicatDevice } = require('../../lib/AlicatDevice');
const { CommandLane } = require('../../lib/CommandLane');
const { Priority } = require('../../lib/PriorityQueue');
const { REG } = require('../../lib/alicat/registers');
const codec = require('../../lib/alicat/codec');
const { delay, until } = require('../helpers/wait');
const { rejectsCode } = require('../helpers/assert');
const { CLIENT, LANE, setup, teardown } = require('../helpers/device');

describe('CommandLane edge cases (10v20 bench replica)', () => {
    /** @type {Awaited<ReturnType<typeof setup>>} */
    let ctx;
    /** @type {InstanceType<typeof CommandLane>} */
    let lane;
    /** @type {string[]} */
    let warnings;

    beforeEach(async () => {
        ctx = await setup('10v20-bench');
        await ctx.device.ready();
        warnings = [];
        lane = new CommandLane({ client: ctx.client, unitId: 1, useExtended: () => true, maxDepth: 1, ...LANE, onWarning: (w) => warnings.push(w) });
    });

    afterEach(async () => {
        lane.close();
        await teardown(ctx);
    });

    it('refuses work beyond its depth', async () => {
        const first = lane.run({ id: 7, arg: 1 });
        const second = lane.run({ id: 7, arg: 0 });
        await rejectsCode(lane.run({ id: 7, arg: 1 }), 'EQUEUEFULL');
        await first;
        await second;
        assert.equal(lane.depth, 0);
    });

    it('a newer urgent command supersedes one that has not started', async () => {
        const blocker = lane.run({ id: 7, arg: 1, priority: Priority.URGENT });
        const queued = lane.run({ id: 6, arg: 1, priority: Priority.URGENT });
        const newer = lane.run({ id: 6, arg: 2, priority: Priority.URGENT });
        const superseded = await queued;
        assert.equal(superseded.outcome, 'not-sent');
        assert.equal(superseded.superseded, true);
        await blocker;
        assert.equal((await newer).outcome, 'executed');
        assert.equal(ctx.sim.model.hold, 'current');
    });

    it('cancelOwner rejects a queued job and stops an active one with ECANCELED', async () => {
        const owner = Symbol('node');
        const active = lane.run({ id: 7, arg: 1, owner }).catch((e) => e);
        await delay(5);
        lane.maxDepth = 5;
        const queued = lane.run({ id: 7, arg: 0, owner }).catch((e) => e);
        lane.cancelOwner(owner);
        assert.equal((await queued).code, 'ECANCELED');
        const err = await active;
        assert.equal(err.code, 'ECANCELED');
        assert.ok(['unknown', 'not-sent'].includes(err.outcome));
    });

    it('close() rejects queued work and stops the active job with ECLOSED', async () => {
        lane.maxDepth = 5;
        const active = lane.run({ id: 7, arg: 1 }).catch((e) => e);
        await delay(5);
        const queued = lane.run({ id: 7, arg: 0 }).catch((e) => e);
        lane.close();
        assert.equal((await queued).code, 'ECLOSED');
        assert.equal((await active).code, 'ECLOSED');
        await rejectsCode(lane.run({ id: 7, arg: 1 }), 'ECLOSED');
    });

    it('a CONTROL command waits for another master\'s running command to finish', async () => {
        // Another master starts a 300 ms timed tare on the extended interface.
        await ctx.client.writeRegisters(1, REG.EXT_COMMAND_ID, [0, 33, 0, 300]);
        await until(() => ctx.sim.engine.running !== null, 1000);
        const r = await lane.run({ id: 7, arg: 1 });
        assert.equal(r.outcome, 'executed');
        assert.equal(r.queuedBehind, null);
        const order = ctx.sim.engine.log.filter((c) => c.id !== 0).map((c) => c.id);
        assert.deepEqual(order, [33, 7]);
    });

    it('warns once when the echo shows a command it did not send, and times out with outcome unknown', async () => {
        // Another master overwrites our command (with "flash display") before the device samples it.
        ctx.sim.engine.rewriteWrite = (iface, words) => (iface === 'extended' && codec.u32(words, 0) === 7 ? [0, 20, 0, 0] : words);
        const err = await lane.run({ id: 7, arg: 1, timeoutMs: 600 }).catch((e) => e);
        assert.equal(err.code, 'ETIMEDOUT');
        assert.equal(err.outcome, 'unknown');
        assert.equal(warnings.length, 1);
        assert.match(warnings[0], /another master/);
    });

    it('encodes float and signed arguments on the 32-bit interface, and decodes float returns', async () => {
        /** @type {number[][]} */
        const writes = [];
        ctx.sim.server.on('request', (/** @type {{fc: number, address: number, values?: number[]}} */ r) => {
            if (r.fc === 16 && r.address + 1 === REG.EXT_COMMAND_ID && r.values) writes.push(r.values);
        });
        await assert.rejects(lane.run({ id: 65551, arg: 1.5, argType: 'f32' }), (e) => /** @type {any} */ (e).statusName === 'INVALID_ID');
        await assert.rejects(lane.run({ id: 65554, arg: -1, argType: 'i32' }), (e) => /** @type {any} */ (e).statusName === 'INVALID_ID');
        assert.ok(writes.some((w) => w[2] === 0x3FC0 && w[3] === 0), 'f32 1.5 = 0x3FC00000');
        assert.ok(writes.some((w) => w[2] === 0xFFFF && w[3] === 0xFFFF), 'i32 −1 = 0xFFFFFFFF');
        const r = await lane.run({ id: 14, arg: 0, returnType: 'f32' });
        assert.equal(r.returnValue, codec.floatFromBits(5000));
    });

    it('refuses arguments the 16-bit limited interface cannot carry', async () => {
        const limited = new CommandLane({ client: ctx.client, unitId: 1, useExtended: () => false, ...LANE });
        await assert.rejects(limited.run({ id: 70000, arg: 0 }), (e) => /** @type {any} */ (e).code === 'EINVALIDARG' && /** @type {any} */ (e).outcome === 'not-sent');
        await assert.rejects(limited.run({ id: 6, arg: -1 }), (e) => /** @type {any} */ (e).code === 'EINVALIDARG');
        limited.close();
    });
});

describe('AlicatDevice edge cases', () => {
    /** @type {Awaited<ReturnType<typeof setup>> | null} */
    let ctx = null;
    afterEach(async () => {
        await teardown(ctx);
        ctx = null;
    });

    it('an urgent hold-closed queued behind a running command writes setpoint 0 as fallback', async () => {
        ctx = await setup('10v20-bench');
        await ctx.device.setSetpoint(60);
        const warnings = /** @type {string[]} */ ([]);
        ctx.device.on('warning', (w) => warnings.push(w));
        const tare = ctx.device.command({ id: 33, arg: 400 }).catch((e) => e);
        await until(() => ctx !== null && ctx.sim.engine.running !== null, 2000);
        const hold = await ctx.device.valve('holdClosed', { fallbackSetpointZero: true });
        await tare;
        assert.equal(hold.fallback, 'setpoint-0');
        assert.equal(ctx.sim.model.state.setpoint, 0);
        assert.ok(warnings.some((w) => /queued behind running command 33/.test(w)));
    });

    it('two setpoints in a row: the second replaces the first if it had not been sent', async () => {
        ctx = await setup('10v20-bench');
        await ctx.device.ready();
        ctx.sim.faults.responseDelayMs = 30;
        const [a, b] = await Promise.all([ctx.device.setSetpoint(10), ctx.device.setSetpoint(20)]);
        assert.ok(a.superseded || a.actual === 10);
        assert.equal(b.actual, 20);
        assert.equal(ctx.sim.model.state.setpoint, 20);
    });

    it('re-identifies after a reconnect and flags a swapped instrument', async () => {
        ctx = await setup('10v20-bench');
        const first = await ctx.device.ready();
        const events = /** @type {any[]} */ ([]);
        ctx.device.on('identity', (e) => events.push(e));
        ctx.sim.bank.set(REG.SERIAL, 0);
        ctx.sim.bank.set(REG.SERIAL + 1, 4242);
        ctx.sim.server.dropConnections();
        await until(() => events.length > 0, 3000);
        assert.equal(events[0].changed, true);
        assert.equal(events[0].identity.serial, 4242);
        assert.notEqual(first.serial, 4242);
    });

    it('retries identification after a transient failure', async () => {
        ctx = await setup('10v20-bench', {}, {});
        ctx.sim.faults.silent = true;
        await delay(400);
        assert.notEqual(ctx.device.state, 'READY');
        ctx.sim.faults.silent = false;
        const id = await ctx.device.ready(5000);
        assert.equal(id.generation, 'gen2');
    });

    it('rejects implausible firmware registers instead of guessing a generation', async () => {
        ctx = await setup('10v20-bench');
        await ctx.device.ready();
        ctx.sim.bank.set(REG.FW_MAJOR, 3);
        await rejectsCode(ctx.device.identify(), 'EIDENTIFY');
        assert.equal(ctx.device.state, 'FAILED');
        await rejectsCode(ctx.device.ready(), 'EIDENTIFY');
    });

    it('rejects a Gen-1 device whose gas register is out of range', async () => {
        ctx = await setup('9v07-bench', { layout: 'extended-7' });
        ctx.sim.model.set({ gas: 999 });
        await rejectsCode(ctx.device.ready(), 'EIDENTIFY');
    });

    it('treats 0xFFFF firmware registers as Gen-1 and refuses an endless data frame', async () => {
        ctx = await setup('9v07-bench', { layout: 'extended-7' }, { undefinedValue: 0xFFFF });
        await assert.rejects(ctx.device.ready(), (e) => /slot count/.test(/** @type {any} */ (e).message));
    });

    it('re-identifies when the data frame shrinks under it', async () => {
        ctx = await setup('9v07-bench', { layout: 'extended-7', reidentifyMinMs: 0 });
        await ctx.device.ready();
        const trail = /** @type {string[]} */ ([]);
        ctx.device.on('state', (s) => trail.push(`${s}${ctx && ctx.device.lastError ? `:${/** @type {any} */ (ctx.device.lastError).code}` : ''}`));
        ctx.client.on('state', (s) => trail.push(`client:${s.state}`));
        // Slot 7 disappears (e.g. someone shortened the data frame on the front panel).
        ctx.sim.bank.setReadable(REG.OPT_READING_BASE + 12, false).setReadable(REG.OPT_READING_BASE + 13, false);
        await assert.rejects(ctx.device.readLive(), (e) => /** @type {any} */ (e).exceptionCode === 2);
        await until(() => ctx !== null && ctx.device.state === 'FAILED', 3000)
            .catch((e) => { throw new Error(`${e.message}; state ${ctx && ctx.device.state}; trail ${trail.join(' → ')}`); });
    });

    it('Gen-1 uses configured unit labels and setpoint limits for the declared mode', async () => {
        ctx = await setup('9v07-bench', {
            layout: 'extended-7', controlVariable: 'massFlow',
            unitLabels: { massFlow: 'SCCM' }, setpointLimits: { massFlow: { min: 0, max: 1000 } }
        });
        const snap = await ctx.device.readLive();
        assert.equal(snap.units.setpoint, 'SCCM', 'setpoint inherits the controlled variable label');
        await rejectsCode(ctx.device.setSetpoint(1500), 'EINVALIDARG');
        const r = await ctx.device.setSetpoint(1500, { outOfRange: 'clamp', verify: false });
        assert.equal(r.written, 1000);
        assert.equal(r.outcome, 'accepted');
    });

    it('offline: subscribers get one offline snapshot when the link drops', async () => {
        ctx = await setup('10v20-bench');
        const snaps = /** @type {any[]} */ ([]);
        ctx.device.subscribe('s', { intervalMs: 100 }, (s) => snaps.push(s));
        await until(() => snaps.length >= 2);
        const lastGood = snaps[snaps.length - 1];
        ctx.sim.faults.refuseConnections = true;
        ctx.sim.server.dropConnections();
        await until(() => snaps.some((s) => s.quality === 'offline'), 3000);
        await delay(400); // four more poll intervals with the device still gone
        const offline = snaps.filter((s) => s.quality !== 'good');
        assert.equal(offline.length, 1, 'announced once, never repeated as if it were new data');
        assert.equal(offline[0].quality, 'offline');
        assert.deepEqual(offline[0].values, lastGood.values, 'the last good values, marked offline');
        assert.equal(typeof offline[0].error.code, 'string', 'with the reason');
        ctx.sim.faults.refuseConnections = false;
    });

    it('ready() times out with ENOTCONNECTED when the device is unreachable, and fails after close', async () => {
        const client = new AlicatClient({ host: '127.0.0.1', port: 1, ...CLIENT });
        const device = new AlicatDevice(client);
        await rejectsCode(device.ready(100), 'ENOTCONNECTED');
        device.close();
        await rejectsCode(device.identify(), 'ECLOSED');
        device.close(); // idempotent
        await client.stop();
    });

    it('a pending ready() rejects with ECLOSED when the device is closed', async () => {
        const client = new AlicatClient({ host: '127.0.0.1', port: 1, ...CLIENT });
        const device = new AlicatDevice(client);
        const pending = device.ready(5000);
        device.close();
        await rejectsCode(pending, 'ECLOSED');
        await client.stop();
    });

    it('cancelOwner drops a subscriber and its queued work', async () => {
        ctx = await setup('10v20-bench');
        const owner = Symbol('read-node');
        let calls = 0;
        ctx.device.subscribe(owner, { intervalMs: 100 }, () => { calls++; });
        await until(() => calls >= 1);
        ctx.device.cancelOwner(owner);
        const after = calls;
        await delay(300);
        assert.ok(calls <= after + 1);
    });

    it('periodically refreshes Gen-2 metadata and reports a units change', async () => {
        ctx = await setup('10v20-bench', { refreshMs: 100 });
        await ctx.device.ready();
        const events = /** @type {any[]} */ ([]);
        ctx.device.on('identity', (e) => events.push(e));
        ctx.sim.bank.set(1724 + 10, 7); // mass-flow info units: SCCM → SLPM
        await until(() => events.some((e) => e.metadataChanged), 2000);
        const mass = ctx.device.identity && ctx.device.identity.readings.find((r) => r.key === 'massFlow');
        assert.equal(mass && mass.units, 'SLPM');
    });

    it('re-sends a repeat-safe command the device never picked up (as seen once on 9v07)', async () => {
        ctx = await setup('9v07-bench', { layout: 'extended-7', lane: { ...LANE, dropDetectMs: 300 } });
        await ctx.device.ready();
        const warnings = /** @type {string[]} */ ([]);
        ctx.device.on('warning', (w) => warnings.push(w));
        ctx.sim.engine.dropNextCommands = 1;
        const r = await ctx.device.selectGas('N2');
        assert.equal(r.outcome, 'executed');
        assert.equal(ctx.sim.model.state.gas, 8);
        assert.ok(warnings.some((w) => /not picked up by the device/.test(w)));
    });

    it('never re-sends a tare; a dropped tare ends with outcome unknown', async () => {
        ctx = await setup('9v07-bench', { layout: 'extended-7', lane: { ...LANE, dropDetectMs: 300 } });
        await ctx.device.ready();
        ctx.sim.engine.dropNextCommands = 1;
        const err = await ctx.device.command('tare', 2, { timeoutMs: 800 }).catch((e) => e);
        assert.equal(err.code, 'ETIMEDOUT');
        assert.equal(err.outcome, 'unknown');
        assert.equal(ctx.sim.engine.log.filter((c) => c.id === 4).length, 0);
    });

    it('rejects valve-drive control below firmware 8v24 and reports a failed resume', async () => {
        ctx = await setup('10v20-bench');
        const id = await ctx.device.ready();
        /** @type {any} */ (ctx.device).identity = { ...id, firmware: '8v20.0' };
        await rejectsCode(ctx.device.setControlVariable('valveDrive'), 'EUNSUPPORTED');
        /** @type {any} */ (ctx.device).identity = id;
        const warnings = /** @type {string[]} */ ([]);
        ctx.device.on('warning', (w) => warnings.push(w));
        ctx.sim.engine.commandHook = (cid, arg) => (cid === 6 && arg === 0 ? { status: 4 } : undefined); // the resume is refused
        await ctx.device.setControlVariable('massFlow');
        assert.ok(warnings.some((w) => /Could not resume the valve/.test(w)));
    });
});
