'use strict';

const assert = require('node:assert/strict');
const { AlicatClient } = require('../../lib/AlicatClient');
const { AlicatDevice } = require('../../lib/AlicatDevice');
const { delay, until } = require('../helpers/wait');
const { rejectsCode } = require('../helpers/assert');
const deviceHelpers = require('../helpers/device');

const { teardown } = deviceHelpers;
/** Valve and gas effects get a little longer here than in the shared default. @type {typeof deviceHelpers.setup} */
const setup = (profile, deviceOptions = {}, simOptions = {}) => deviceHelpers.setup(profile, { effectTimeoutMs: 500, ...deviceOptions }, simOptions);

/** Commands the simulated device actually executed, without NOPs. @param {InstanceType<typeof import('../../tools/sim/AlicatSimulator').AlicatSimulator>} sim */
const executed = (sim) => sim.engine.log.filter((c) => c.id !== 0).map((c) => [c.id, c.arg, c.status]);

describe('AlicatDevice — Gen-2 replica of a 10v20 unit (valve-drive mode)', () => {
    /** @type {Awaited<ReturnType<typeof setup>>} */
    let ctx;
    beforeEach(async () => { ctx = await setup('10v20-bench'); });
    afterEach(async () => { await teardown(ctx); });

    it('identifies firmware, serial, control mode, and names readings by statistic type', async () => {
        const id = await ctx.device.ready();
        assert.equal(id.generation, 'gen2');
        assert.equal(id.firmware, '10v20.0');
        assert.equal(id.serial, 123456);
        assert.equal(id.controlledVariable, 'valveDrive');
        const keys = id.readings.map((r) => r.key);
        assert.deepEqual(keys, ['setpoint', 'valveDrive', 'gaugePressure', 'absolutePressure', 'barometricPressure',
            'temperature', 'volumetricFlow', 'massFlow']);
        const units = Object.fromEntries(id.readings.map((r) => [r.key, r.units]));
        assert.equal(units.massFlow, 'SCCM');
        assert.equal(units.volumetricFlow, 'LPM');
        assert.equal(units.gaugePressure, 'PSIG');
        assert.equal(units.absolutePressure, 'PSIA');
    });

    it('reads a decoded live snapshot', async () => {
        const snap = await ctx.device.readLive();
        assert.equal(snap.quality, 'good');
        assert.equal(snap.generation, 'gen2');
        assert.equal(snap.gas.symbol, 'Air');
        assert.equal(snap.controlledVariable, 'valveDrive');
        assert.equal(snap.units.setpoint, '%');
        assert.ok(Math.abs(/** @type {number} */ (snap.values.barometricPressure) - 14.8) < 1e-4);
        assert.equal(snap.status.flags.holding, false);
        assert.deepEqual(snap.alarms, { raw: 0, alarm1: false, alarm2: false });
    });

    it('hands out frozen snapshots, so one flow cannot change what another receives', async () => {
        const snap = await ctx.device.readLive();
        for (const part of [snap, snap.values, snap.status, snap.status.flags, snap.status.active, snap.units, snap.gas]) {
            assert.ok(Object.isFrozen(part));
        }
        assert.throws(() => { /** @type {any} */ (snap.status.flags).holding = true; }, TypeError);
    });

    it("reports each snapshot's own round trip, not the client's last one", async () => {
        await ctx.device.ready();
        const stats = ctx.client.stats.bind(ctx.client);
        ctx.client.stats = () => ({ ...stats(), rtt: { last: 9999, avg: 9999, max: 9999 } });
        const snap = await ctx.device.readLive();
        assert.ok(snap.rttMs !== null && snap.rttMs < 1000, `rttMs ${snap.rttMs}`);
    });

    it('writes a valve-drive setpoint, rejects or clamps out-of-range values', async () => {
        const r = await ctx.device.setSetpoint(50);
        assert.equal(r.actual, 50);
        assert.equal(r.outcome, 'executed');
        assert.equal(r.units, '%');
        await rejectsCode(ctx.device.setSetpoint(150), 'EINVALIDARG');
        const clamped = await ctx.device.setSetpoint(150, { outOfRange: 'clamp' });
        assert.equal(clamped.written, 100);
        assert.equal(clamped.clamped, true);
        await rejectsCode(ctx.device.setSetpoint(NaN), 'EINVALIDARG');
    });

    it('switches to mass-flow control bumplessly and writes the setpoint in SCCM', async () => {
        await ctx.device.setSetpoint(40);
        const r = await ctx.device.setSetpoint(500, { variable: 'massFlow' });
        assert.equal(r.actual, 500);
        assert.equal(r.units, 'SCCM');
        assert.equal(ctx.device.identity && ctx.device.identity.controlledVariable, 'massFlow');
        assert.equal(ctx.sim.model.controlVariable, 'massFlow');
        // hold current → loop variable (43, arg 0) → resume
        assert.deepEqual(executed(ctx.sim), [[6, 2, 0], [43, 0, 0], [6, 0, 0]]);
        assert.equal(ctx.sim.model.hold, null, 'resumed after the switch');
    });

    it('switches to gauge-pressure control directly when asked', async () => {
        const r = await ctx.device.setControlVariable('gaugePressure', { switchMode: 'direct', setpoint: 20 });
        assert.equal(r.outcome, 'executed');
        assert.equal(r.bumpless, false);
        assert.equal(r.setpoint && r.setpoint.actual, 20);
        assert.equal(r.setpoint && r.setpoint.units, 'PSIG');
        assert.deepEqual(executed(ctx.sim), [[43, 4, 0]]);
    });

    it('does not resume a valve that was already held before the switch', async () => {
        await ctx.device.valve('holdClosed');
        await ctx.device.setControlVariable('massFlow');
        assert.equal(ctx.sim.model.hold, 'closed');
        assert.deepEqual(executed(ctx.sim).map((c) => c[0]), [6, 43]);
    });

    it('never undoes an urgent valve command sent during a bumpless switch', async () => {
        /** @type {string[]} */
        const warnings = [];
        ctx.device.on('warning', (w) => warnings.push(w));
        await ctx.device.ready();
        const sw = ctx.device.setControlVariable('massFlow').catch((e) => e);
        // Once the switch's own hold (6,2) has run, make the device ignore the next command (the mode
        // switch), so the switch is reliably still in progress when the operator's hold arrives.
        await until(() => executed(ctx.sim).some(([id, arg]) => id === 6 && arg === 2));
        ctx.sim.engine.dropNextCommands = 1;
        const holdAt = ctx.sim.engine.log.findIndex((c) => c.id === 6 && c.arg === 2);
        await until(() => ctx.sim.engine.log.slice(holdAt + 1).some((c) => c.id === 0)); // the switch moved on
        const hold = await ctx.device.valve('holdClosed');
        const result = await sw;
        await delay(300); // a resume, had one been sent, would have run by now
        assert.equal(result.code, 'EPREEMPTED', 'the urgent hold interrupted the switch');
        assert.equal(hold.effect, true);
        assert.equal(ctx.sim.model.hold, 'closed', "the operator's hold stays");
        assert.ok(!executed(ctx.sim).some(([id, arg]) => id === 6 && arg === 0), 'no resume was sent');
        assert.ok(warnings.some((w) => /Not resuming the valve/.test(w)), warnings.join('\n'));
    });

    it('rejects unknown control variables', async () => {
        await rejectsCode(ctx.device.setControlVariable('humidity'), 'EINVALIDARG');
    });

    it('never takes an inherited object key for a valid name, so nothing reaches the device', async () => {
        await ctx.device.ready();
        for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
            await rejectsCode(ctx.device.setControlVariable(name), 'EINVALIDARG');
            await rejectsCode(ctx.device.setSetpoint(1, { variable: name }), 'EINVALIDARG');
            await rejectsCode(ctx.device.valve(/** @type {any} */ (name)), 'EINVALIDARG');
            await rejectsCode(ctx.device.command(name), 'EINVALIDARG');
            await rejectsCode(ctx.device.tare(/** @type {any} */ (name)), 'EINVALIDARG');
        }
        assert.deepEqual(executed(ctx.sim), [], 'no command was executed');
        assert.equal(ctx.sim.model.controlVariable, 'valveDrive', 'the control mode did not change');
    });

    it('valve commands are confirmed by the HLD / EXH status bits', async () => {
        const hold = await ctx.device.valve('holdClosed');
        assert.equal(hold.outcome, 'executed');
        assert.equal(hold.effect, true);
        assert.equal((await ctx.device.readLive()).status.flags.holding, true);
        const exhaust = await ctx.device.valve('exhaust');
        assert.equal(exhaust.effect, true);
        assert.equal((await ctx.device.readLive()).status.flags.exhausting, true);
        const resume = await ctx.device.valve('resume');
        assert.equal(resume.effect, true);
        await rejectsCode(ctx.device.valve(/** @type {any} */ ('open')), 'EINVALIDARG');
    });

    it('runs the same command twice in a row (NOP between repeats)', async () => {
        await ctx.device.valve('holdClosed');
        await ctx.device.valve('holdClosed');
        assert.deepEqual(executed(ctx.sim), [[6, 1, 0], [6, 1, 0]]);
    });

    it('reads and writes PID gains', async () => {
        assert.deepEqual(await ctx.device.readPid(), { p: 5000, d: 0, i: 250 });
        const r = await ctx.device.writePid({ p: 4000, i: 300 });
        assert.deepEqual(r, { p: 4000, d: 0, i: 300, outcome: 'executed' });
        await rejectsCode(ctx.device.writePid({ d: 70000 }), 'EINVALIDARG');
    });

    it('selects a gas by symbol or name and confirms it', async () => {
        const r = await ctx.device.selectGas('N2');
        assert.equal(r.outcome, 'executed');
        assert.equal(r.gas.name, 'Nitrogen');
        assert.equal((await ctx.device.selectGas('argon')).gas.number, 1);
        await rejectsCode(ctx.device.selectGas('unobtainium'), 'EINVALIDARG');
    });

    it('tares, resets totalizers and locks the display', async () => {
        assert.equal((await ctx.device.tare('flow')).outcome, 'executed');
        assert.equal((await ctx.device.resetTotalizer(2)).outcome, 'executed');
        assert.equal((await ctx.device.displayLock(true)).outcome, 'executed');
        assert.equal(ctx.sim.model.displayLocked, true);
        await rejectsCode(ctx.device.tare(/** @type {any} */ ('humidity')), 'EINVALIDARG');
    });

    it('reports a rejected command with ECOMMAND and outcome rejected', async () => {
        await assert.rejects(ctx.device.command({ id: 999, arg: 0 }), (err) => {
            const e = /** @type {any} */ (err);
            return e.code === 'ECOMMAND' && e.statusName === 'INVALID_ID' && e.outcome === 'rejected';
        });
        await rejectsCode(ctx.device.command({ id: 26, arg: 49374 }), 'EINVALIDARG'); // factory restore is blocked
    });

    it('a valve command replaced by a newer one before it was sent reports not-sent, not executed', async () => {
        const tare = ctx.device.command({ id: 33, arg: 400 }).catch((e) => e);
        await until(() => ctx.sim.engine.log.some((c) => c.id === 0) && ctx.sim.engine.running !== null, 2000);
        // Both arrive in the same tick: the first is still queued when the second replaces it.
        const [first, second] = await Promise.all([ctx.device.valve('holdClosed'), ctx.device.valve('holdCurrent')]);
        await tare;
        assert.equal(first.superseded, true);
        assert.equal(first.outcome, 'not-sent');
        assert.equal(first.effect, false, 'nothing to confirm for a command that was never sent');
        assert.equal(second.outcome, 'executed');
        assert.equal(ctx.sim.model.hold, 'current');
    });

    it('an urgent hold pre-empts a running command and is reported as queued behind it', async () => {
        const tare = ctx.device.command({ id: 33, arg: 400 }).catch((e) => e);
        await until(() => ctx.sim.engine.log.some((c) => c.id === 0) && ctx.sim.engine.running !== null, 2000);
        const hold = await ctx.device.valve('holdClosed');
        const tareResult = await tare;
        assert.equal(tareResult.code, 'EPREEMPTED');
        assert.equal(tareResult.outcome, 'unknown');
        assert.deepEqual(hold.queuedBehind && hold.queuedBehind.id, 33);
        assert.equal(hold.effect, true);
        assert.equal(ctx.sim.model.hold, 'closed');
    });

    it('one poll loop serves every subscriber, and quality drops to stale when the device goes silent', async () => {
        /** @type {any[]} */
        const fast = [];
        /** @type {any[]} */
        const slow = [];
        await ctx.device.ready();
        const before = ctx.sim.stats.requests;
        const unsubFast = ctx.device.subscribe('fast', { intervalMs: 100 }, (s) => fast.push(s));
        const unsubSlow = ctx.device.subscribe('slow', { intervalMs: 300 }, (s) => slow.push(s));
        await until(() => fast.length >= 6, 3000, 'six fast snapshots');
        const reads = ctx.sim.stats.requests - before;
        assert.ok(reads <= fast.length + 1, `${reads} wire reads for ${fast.length} fast snapshots: one read serves both`);
        // The 300 ms subscriber gets about every third 100 ms cycle (its first, then every ~300 ms).
        const third = fast.length / 3;
        assert.ok(slow.length >= Math.floor(third) - 1 && slow.length <= Math.ceil(third) + 1, `slow got ${slow.length} for ${fast.length} fast`);
        ctx.sim.faults.silent = true;
        await until(() => fast.some((s) => s.quality !== 'good'), 3000);
        const degraded = fast.filter((s) => s.quality !== 'good');
        assert.ok(['stale', 'offline'].includes(degraded[0].quality));
        assert.ok(degraded[0].ageMs > 0);
        assert.equal(degraded.filter((s) => s.quality === degraded[0].quality).length, 1, 'announced once');
        ctx.sim.faults.silent = false;
        unsubFast();
        unsubSlow();
    });
});

describe('AlicatDevice — Gen-1 replica of the 9v07 unit', () => {
    /** @type {Awaited<ReturnType<typeof setup>>} */
    let ctx;
    afterEach(async () => { if (ctx) await teardown(ctx); });

    it('needs a layout for its 7-slot frame and says which preset to use', async () => {
        ctx = await setup('9v07-bench');
        await assert.rejects(ctx.device.ready(), (err) => {
            const e = /** @type {any} */ (err);
            return e.code === 'EIDENTIFY' && /extended-7/.test(e.message);
        });
        assert.equal(ctx.device.state, 'FAILED');
    });

    it('identifies as Gen-1 with the extended-7 preset', async () => {
        ctx = await setup('9v07-bench', { layout: 'extended-7', unitLabels: { massFlow: 'SCCM', setpoint: 'SCCM' } });
        const id = await ctx.device.ready();
        assert.equal(id.generation, 'gen1');
        assert.equal(id.firmware, null);
        assert.equal(id.extendedCommands, false);
        assert.equal(id.setpointReadable, true);
        assert.equal(id.controlledVariable, null, 'Gen-1 cannot report its control mode');
        const snap = await ctx.device.readLive();
        assert.equal(snap.setpoint, 12.5);
        assert.equal(snap.alarms, null);
        assert.equal(snap.units.massFlow, 'SCCM');
        assert.ok(Math.abs(/** @type {number} */ (snap.values.barometricPressure) - 14.77) < 1e-4);
    });

    it('writes the write-only setpoint and verifies it through the data frame', async () => {
        ctx = await setup('9v07-bench', { layout: 'extended-7', controlVariable: 'massFlow' });
        const r = await ctx.device.setSetpoint(100);
        assert.equal(r.actual, 100);
        assert.equal(r.verified, true);
        assert.equal(r.outcome, 'executed');
    });

    it('reports a setpoint the device limited as not confirmed, not as clamped by the library', async () => {
        ctx = await setup('9v07-bench', { layout: 'extended-7', controlVariable: 'massFlow' }); // no range known on Gen-1
        const r = await ctx.device.setSetpoint(5000); // the device limits mass flow to ±2000
        assert.equal(r.actual, 2000);
        assert.equal(r.verified, false);
        assert.equal(r.clamped, false, 'the library did not limit it');
        assert.equal(r.outcome, 'unknown');
    });

    it('switches control variable with command 11 (valve drive = Appendix A code 45)', async () => {
        ctx = await setup('9v07-bench', { layout: 'extended-7' });
        const r = await ctx.device.setSetpoint(30, { variable: 'valveDrive' });
        assert.equal(r.actual, 30);
        assert.equal(ctx.sim.model.controlVariable, 'valveDrive');
        assert.equal(ctx.device.identity && ctx.device.identity.controlledVariable, 'valveDrive');
        assert.deepEqual(executed(ctx.sim), [[6, 2, 0], [11, 45, 0], [6, 0, 0]]);
        const back = await ctx.device.setControlVariable('massFlow');
        assert.equal(back.outcome, 'accepted', 'Gen-1 cannot read the mode back');
        assert.equal(back.previous, 'valveDrive');
    });

    it('reads PID gains over the limited interface', async () => {
        ctx = await setup('9v07-bench', { layout: 'extended-7' });
        assert.deepEqual(await ctx.device.readPid(), { p: 720, d: 610, i: 250 });
    });

    it('surfaces device refusals and extended-only commands correctly', async () => {
        ctx = await setup('9v07-bench', { layout: 'extended-7' });
        await assert.rejects(ctx.device.valve('exhaust'), (err) => /** @type {any} */ (err).statusName === 'UNSUPPORTED');
        // Hardware (9v07) answers an unsupported loop variable with 0x8002 = INVALID_ARGUMENT.
        await assert.rejects(ctx.device.setControlVariable('differentialPressure'), (err) => {
            const e = /** @type {any} */ (err);
            return e.statusName === 'INVALID_ARGUMENT' && e.outcome === 'rejected';
        });
        assert.equal(ctx.sim.model.hold, null, 'valve resumed after the refused switch');
        assert.deepEqual(executed(ctx.sim).filter((c) => c[0] === 11), [[11, 2, 3]], 'refused with status 3 = 0x8002 on the wire');
        await rejectsCode(ctx.device.resetTotalizer(2), 'EUNSUPPORTED');
        await rejectsCode(ctx.device.command('loopControlVariable', 65535), 'EUNSUPPORTED');
        await rejectsCode(ctx.device.command({ id: 33, arg: 70000 }), 'EINVALIDARG'); // needs the 32-bit interface
    });

    it('rejects a layout whose length does not match the device', async () => {
        ctx = await setup('9v07-bench', { layout: 'mfc' });
        await assert.rejects(ctx.device.ready(), (err) => /slots but the device reports 7/.test(/** @type {any} */ (err).message));
    });
});

describe('AlicatDevice — identification safety', () => {
    /** @type {Awaited<ReturnType<typeof setup>> | null} */
    let ctx = null;
    afterEach(async () => { if (ctx) await teardown(ctx); ctx = null; });

    it('refuses mapMode modern on a Gen-1 device instead of misreading it', async () => {
        ctx = await setup('9v07-bench', { mapMode: 'modern', layout: 'extended-7' });
        await assert.rejects(ctx.device.ready(), (err) => /** @type {any} */ (err).code === 'EIDENTIFY');
    });

    it('survives a dropped reply during identification (retry, no fall-through)', async () => {
        ctx = await setup('10v20-bench');
        ctx.sim.faults.dropResponses = 1;
        const id = await ctx.device.ready(5000);
        assert.equal(id.generation, 'gen2');
    });

    it('validates its options', () => {
        const client = new AlicatClient({ host: '127.0.0.1', port: 1 });
        assert.throws(() => new AlicatDevice(client, { layout: ['massFlow', 'flux'] }), /Unknown reading "flux"/);
        assert.throws(() => new AlicatDevice(client, { controlVariable: 'humidity' }), /Unknown control variable/);
    });
});
