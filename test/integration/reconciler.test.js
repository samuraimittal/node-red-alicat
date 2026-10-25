'use strict';

const assert = require('node:assert/strict');
const { AlicatClient } = require('../../lib/AlicatClient');
const { AlicatDevice } = require('../../lib/AlicatDevice');
const { Reconciler } = require('../../lib/Reconciler');
const { AlicatSimulator } = require('../../tools/sim/AlicatSimulator');
const { REG } = require('../../lib/alicat/registers');
const codec = require('../../lib/alicat/codec');
const { delay, until } = require('../helpers/wait');
const { CLIENT, LANE } = require('../helpers/device');

describe('Reconciler (maintain desired state)', function () {
    this.timeout(15000);
    /** @type {InstanceType<typeof AlicatSimulator>} */
    let sim;
    /** @type {InstanceType<typeof AlicatClient>} */
    let client;
    /** @type {InstanceType<typeof AlicatDevice>} */
    let device;
    /** @type {InstanceType<typeof Reconciler>} */
    let rec;
    /** @type {any[]} */
    let events;

    /** @param {string} profile @param {Record<string, unknown>} [recOptions] @param {Record<string, unknown>} [deviceOptions] */
    async function setup(profile, recOptions = {}, deviceOptions = {}) {
        sim = await new AlicatSimulator({ profile, commandCycleMs: 20, tauMs: 20, maxConnections: 2 }).start();
        client = new AlicatClient({ host: '127.0.0.1', port: sim.port, ...CLIENT });
        device = new AlicatDevice(client, { lane: LANE, effectTimeoutMs: 400, ...deviceOptions });
        client.start();
        await device.ready();
        rec = new Reconciler(device, { intervalMs: 100, correctionMs: 100, maxCorrectionMs: 400, ...recOptions });
        events = [];
        rec.on('event', (e) => events.push(e));
    }

    const seen = (/** @type {string} */ name) => events.filter((e) => e.event === name);

    afterEach(async () => {
        rec.close();
        device.close();
        await client.stop();
        await sim.stop();
    });

    it('converges on setpoint, mode and valve, correcting the mode first', async () => {
        await setup('10v20-bench');
        rec.set({ variable: 'massFlow', setpoint: 500, valve: 'auto' });
        await until(() => seen('converged').length === 1);
        assert.equal(sim.model.controlVariable, 'massFlow');
        assert.equal(sim.model.state.setpoint, 500);
        assert.equal(seen('correcting')[0].dimension, 'variable');
        assert.deepEqual(seen('converged')[0].actual, { setpoint: 500, variable: 'massFlow', valve: 'auto' });
    });

    it('treats a float32 read-back as reached (0.1 is stored as 0.10000000149)', async () => {
        await setup('10v20-bench');
        rec.set({ setpoint: 0.1 });
        await until(() => seen('converged').length === 1);
        await delay(500);
        assert.equal(seen('correcting').length, 1, 'no endless rewrites');
    });

    it('reverts an external change, reporting it as drift', async () => {
        await setup('10v20-bench');
        rec.set({ setpoint: 40 });
        await until(() => seen('converged').length === 1);
        await client.writeRegisters(1, REG.SETPOINT, codec.encodeF32(10)); // someone else changes it
        await until(() => seen('drift').length === 1);
        await until(() => seen('converged').length === 2);
        assert.equal(sim.model.state.setpoint, 40);
    });

    it('adopts an external change when configured to', async () => {
        await setup('10v20-bench', { onExternalChange: 'adopt' });
        rec.set({ setpoint: 40 });
        await until(() => seen('converged').length === 1);
        await client.writeRegisters(1, REG.SETPOINT, codec.encodeF32(10));
        await until(() => seen('drift').length === 1);
        await delay(500);
        assert.equal(sim.model.state.setpoint, 10, 'left as the other master set it');
        assert.equal(rec.desired.setpoint, undefined);
    });

    it('resumes maintaining a dimension that report mode stopped, when it is asked for again', async () => {
        await setup('10v20-bench', { onExternalChange: 'report' });
        rec.set({ setpoint: 40 });
        await until(() => seen('converged').length === 1);
        await client.writeRegisters(1, REG.SETPOINT, codec.encodeF32(10));
        await until(() => seen('drift').length === 1);
        rec.set({ setpoint: 40 }); // the same value again
        await until(() => seen('converged').length === 2);
        assert.equal(sim.model.state.setpoint, 40);
    });

    it('keeps working when an event listener throws, and reports it as a warning', async () => {
        await setup('10v20-bench');
        /** @type {string[]} */
        const warnings = [];
        rec.on('warning', (w) => warnings.push(w));
        let thrown = false;
        rec.on('event', (e) => {
            if (e.event === 'correcting' && !thrown) {
                thrown = true;
                throw new Error('listener bug');
            }
        });
        rec.set({ setpoint: 30 });
        await until(() => seen('converged').length === 1);
        assert.equal(sim.model.state.setpoint, 30);
        assert.ok(warnings.some((w) => /listener bug/.test(w)), warnings.join('\n'));
    });

    it('sends nothing after close, even when a correction was running', async () => {
        await setup('10v20-bench', { maxAttempts: 1 });
        rec.set({ setpoint: 25 });
        await until(() => seen('correcting').length === 1);
        sim.faults.silent = true; // the running correction times out after close and would report 'failed'
        const before = events.length;
        rec.close();
        await delay(600);
        assert.equal(events.length, before, 'no events after close');
        assert.throws(() => rec.set({ setpoint: 1 }), (e) => /** @type {any} */ (e).code === 'ECLOSED');
    });

    it('only reports an external change when configured to', async () => {
        await setup('10v20-bench', { onExternalChange: 'report' });
        rec.set({ setpoint: 40 });
        await until(() => seen('converged').length === 1);
        await client.writeRegisters(1, REG.SETPOINT, codec.encodeF32(10));
        await until(() => seen('drift').length === 1);
        await delay(500);
        assert.equal(sim.model.state.setpoint, 10);
        assert.equal(rec.desired.setpoint, 40, 'still desired, just not enforced');
    });

    it('reports failed after the configured attempts when the device keeps refusing', async () => {
        await setup('9v07-bench', { maxAttempts: 2 }, { layout: 'extended-7' });
        rec.set({ variable: 'differentialPressure' }); // 9v07 refuses this (INVALID_ARGUMENT)
        await until(() => seen('failed').length === 1, 8000);
        const failed = seen('failed')[0];
        assert.equal(failed.dimension, 'variable');
        assert.equal(failed.attempts, 2);
        assert.match(failed.error.message, /INVALID_ARGUMENT/);
    });

    it('never acts on stale data: waits while the device is silent, then catches up', async () => {
        await setup('10v20-bench');
        rec.set({ setpoint: 20 });
        await until(() => seen('converged').length === 1);
        /** @type {number[]} registers written; a silent simulator still records requests, it just doesn't answer */
        const writes = [];
        sim.server.on('request', (/** @type {{fc: number, address: number}} */ r) => { if (r.fc === 16) writes.push(r.address + 1); });
        sim.faults.silent = true;
        await until(() => seen('waiting').length >= 1, 5000);
        rec.set({ setpoint: 30 }); // a new target while the data is stale
        await delay(500); // five check intervals
        assert.equal(writes.length, 0, `nothing is written on stale data (wrote ${writes.join(', ')})`);
        sim.faults.silent = false;
        await until(() => seen('converged').length === 2, 8000);
        assert.ok(writes.includes(REG.SETPOINT), 'the new setpoint is written once the data is fresh');
        assert.ok(Math.abs(/** @type {number} */ (sim.model.state.setpoint) - 30) < 1e-3);
    });

    it('refuses a desired setpoint outside the device range, and bad input', async () => {
        await setup('10v20-bench');
        assert.throws(() => rec.set({ setpoint: 150 }), /outside the device range/);
        assert.throws(() => rec.set({ valve: /** @type {any} */ ('open') }), /valve must be one of/);
        assert.throws(() => rec.set({ variable: 'humidity' }), /Unknown control variable/);
        assert.throws(() => rec.set({ setpoint: NaN }), /finite number/);
        assert.throws(() => new Reconciler(device, { onExternalChange: /** @type {any} */ ('panic') }), /onExternalChange/);
    });

    it('holds the valve as desired and releases without touching the device', async () => {
        await setup('10v20-bench');
        rec.set({ valve: 'hold-closed' });
        await until(() => seen('converged').length === 1);
        assert.equal(sim.model.hold, 'closed');
        rec.release();
        assert.equal(seen('released').length, 1);
        await delay(300);
        assert.equal(sim.model.hold, 'closed', 'release leaves the device as it is');
        assert.equal(rec.active, false);
    });
});
