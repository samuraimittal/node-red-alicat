'use strict';

// Hardware-in-the-loop test of AlicatDevice. Skipped unless a host is set.
//
//   Gen-2 unit: $env:ALICAT_HIL_HOST      = '192.0.2.10'
//   Gen-1 unit: $env:ALICAT_HIL_GEN1_HOST = '192.0.2.11'   (layout: $env:ALICAT_HIL_GEN1_LAYOUT, default extended-7)
//
// Read-only by default: identification, live data, PID gains, mode query.
// $env:ALICAT_HIL_WRITE = '1' adds:
//   - valve hold closed → resume;
//   - setpoint 0 in mass-flow, gauge-pressure and valve-drive modes (valve stays closed);
//   - PID and gas rewritten with their current values;
//   - the original mode and setpoint restored at the end.
// Gen-1 can't report its mode, so its switching test also needs
//   $env:ALICAT_HIL_GEN1_MODE = 'massFlow' | 'valveDrive' | ...   (the unit's current mode, to restore it).
// Run on a bench unit with no process gas.

const assert = require('node:assert/strict');
const { AlicatClient } = require('../../lib/AlicatClient');
const { AlicatDevice } = require('../../lib/AlicatDevice');

const WRITE = process.env.ALICAT_HIL_WRITE === '1';
const MODES = ['massFlow', 'gaugePressure', 'valveDrive'];

/**
 * @param {string} title
 * @param {string | undefined} host
 * @param {Record<string, unknown>} deviceOptions
 * @param {string | null} knownMode
 */
function suite(title, host, deviceOptions, knownMode) {
    (host ? describe : describe.skip)(`${title} — ${host}`, function () {
        this.timeout(60000);
        /** @type {InstanceType<typeof AlicatClient>} */
        let client;
        /** @type {InstanceType<typeof AlicatDevice>} */
        let device;
        /** @type {Record<string, unknown>} */
        const report = {};

        before(async () => {
            client = new AlicatClient({ host: /** @type {string} */ (host) });
            device = new AlicatDevice(client, deviceOptions);
            client.start();
            await device.ready(15000);
        });

        after(async () => {
            device.close();
            await client.stop();
            console.log(`\n=== ${title} report ===\n${JSON.stringify(report, null, 2)}`);
        });

        it('identifies the device', () => {
            const id = /** @type {NonNullable<typeof device.identity>} */ (device.identity);
            report.identity = {
                generation: id.generation, firmware: id.firmware, serial: id.serial,
                controlledVariable: id.controlledVariable, setpointType: id.setpointType,
                readings: id.readings.map((r) => `${r.key}${r.units ? ` [${r.units}]` : ''}`)
            };
            assert.ok(['gen1', 'gen2'].includes(id.generation));
        });

        it('reads a live snapshot', async () => {
            const s = await device.readLive();
            report.snapshot = { values: s.values, gas: s.gas.symbol, status: s.status.active, units: s.units, rttMs: s.rttMs };
            assert.equal(s.quality, 'good');
        });

        it('reads PID gains', async () => {
            report.pid = await device.readPid();
        });

        it('queries the control mode (Gen-2 ≥10v19)', async function () {
            const id = /** @type {NonNullable<typeof device.identity>} */ (device.identity);
            if (id.generation !== 'gen2') this.skip();
            const r = await device.command('loopControlVariable', 65535);
            report.loopQuery = r.returnValue;
        });

        it('WRITE: valve hold closed, then resume, confirmed by the HLD bit', async function () {
            if (!WRITE) this.skip();
            const hold = await device.valve('holdClosed');
            const resume = await device.valve('resume');
            report.valve = { hold: hold.outcome, holdMs: hold.durationMs, resume: resume.outcome, resumeMs: resume.durationMs };
            assert.equal(hold.effect, true);
            assert.equal(resume.effect, true);
        });

        it('WRITE: PID and gas rewritten with their current values', async function () {
            if (!WRITE) this.skip();
            const pid = await device.readPid();
            const written = await device.writePid(/** @type {any} */ (pid));
            const snap = await device.readLive();
            const gas = await device.selectGas(snap.gas.number);
            report.rewrite = { pid: written.outcome, gas: gas.outcome };
            assert.equal(written.outcome, 'executed');
        });

        it('WRITE: setpoint 0 in mass-flow, gauge-pressure and valve-drive modes, then restore', async function () {
            const id = /** @type {NonNullable<typeof device.identity>} */ (device.identity);
            const original = id.controlledVariable || knownMode;
            if (!WRITE || !original) this.skip();
            const before = await device.readLive();
            const originalSetpoint = before.setpoint ?? 0;
            /** @type {Record<string, unknown>} */
            const results = {};
            try {
                for (const mode of MODES) {
                    const r = await device.setSetpoint(0, { variable: mode });
                    results[mode] = { actual: r.actual, units: r.units, outcome: r.outcome, mode: device.identity && device.identity.controlledVariable };
                    assert.equal(device.identity && device.identity.controlledVariable, mode);
                    assert.equal(r.actual, 0);
                }
            } finally {
                const restored = await device.setSetpoint(originalSetpoint, { variable: original, outOfRange: 'clamp' });
                results.restored = { mode: original, setpoint: restored.actual };
                report.modes = results;
            }
        });
    });
}

suite('Gen-2 device', process.env.ALICAT_HIL_HOST, {}, null);
suite('Gen-1 device', process.env.ALICAT_HIL_GEN1_HOST, {
    layout: process.env.ALICAT_HIL_GEN1_LAYOUT || 'extended-7',
    controlVariable: process.env.ALICAT_HIL_GEN1_MODE || 'unknown'
}, process.env.ALICAT_HIL_GEN1_MODE || null);
