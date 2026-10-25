'use strict';

const assert = require('node:assert/strict');
const path = require('path');
const { execFile } = require('child_process');
const { AlicatSimulator } = require('../../tools/sim/AlicatSimulator');
const { REG } = require('../../lib/alicat/registers');
const { until } = require('../helpers/wait');

const PROBE = path.join(__dirname, '..', '..', 'tools', 'alicat-probe.js');

/**
 * Run the probe CLI (a real child process) and collect its output.
 * @param {string[]} args
 * @returns {Promise<{code: number, out: string}>}
 */
function probe(args) {
    return new Promise((resolve) => {
        execFile(process.execPath, [PROBE, ...args], { timeout: 20000 }, (err, stdout, stderr) => {
            resolve({ code: err ? Number(err.code) : 0, out: `${stdout}${stderr}` });
        });
    });
}

describe('alicat-probe CLI (against a simulator)', function () {
    this.timeout(30000);
    /** @type {InstanceType<typeof AlicatSimulator>} */
    let sim;
    /** @type {string[]} */
    let at;

    before(async () => {
        sim = await new AlicatSimulator({ profile: '10v20-bench', maxConnections: 1, serial: 123456 }).start();
        at = ['--port', String(sim.port)];
    });
    after(async () => { await sim.stop(); });

    it('identifies the instrument', async () => {
        const { code, out } = await probe(['127.0.0.1', 'info', ...at]);
        assert.equal(code, 0, out);
        assert.match(out, /Gen-2 \(firmware 10v20\.0/);
        assert.match(out, /Word order : ABCD/);
        assert.match(out, /Serial {5}: 123456/);
        assert.match(out, /slot 1 \(reg 1203\): [-\d.]+/);
    });

    it('finds where a Gen-1 data frame ends', async () => {
        const gen1 = await new AlicatSimulator({ profile: '9v07-bench', maxConnections: 1 }).start();
        try {
            const { code, out } = await probe(['127.0.0.1', 'info', '--port', String(gen1.port)]);
            assert.equal(code, 0, out);
            assert.match(out, /Generation : Gen-1 likely \(1090–1093 → Modbus exception 2/);
            assert.match(out, /Data frame : 7 slot\(s\) before Modbus exception 2/);
        } finally {
            await gen1.stop();
        }
    });

    it('reads, watches and decodes registers and status bits', async () => {
        const read = await probe(['127.0.0.1', 'read', String(REG.OPT_READING_BASE), '2', '--as', 'f32', ...at]);
        assert.equal(read.code, 0, read.out);
        assert.match(read.out, /^1203…1204: [-\d.]+\s*$/m);
        const watch = await probe(['127.0.0.1', 'watch', String(REG.OPT_GAS), '--interval', '50', '--duration', '160', ...at]);
        assert.ok(watch.out.trim().split('\n').length >= 3, watch.out);
        const status = await probe(['127.0.0.1', 'status', ...at]);
        assert.match(status.out, /Status: 0x00000000 \(no bits set\)/);
    });

    it('writes only with --write, and runs a command with the NOP handshake', async () => {
        const refused = await probe(['127.0.0.1', 'write', '1010', '0', '0', ...at]);
        assert.equal(refused.code, 1);
        assert.match(refused.out, /Re-run with --write/);
        const command = await probe(['127.0.0.1', 'command', '7', '1', '--write', '--extended', '--duration', '400', ...at]);
        assert.equal(command.code, 0, command.out);
        assert.match(command.out, /wrote NOP \(0, 0\)[\s\S]*wrote command \(7, 1\) on the extended interface/);
        // The device samples its command registers every ~120 ms; on a busy machine that can fall after the probe exits.
        await until(() => sim.model.displayLocked === true, 2000, 'the command to run on the device');
        const blocked = await probe(['127.0.0.1', 'command', '26', '0', '--write', '--extended', ...at]);
        assert.match(blocked.out, /blocked by this library/, 'factory restore stays blocked');
    });

    it('refuses bad options and unknown actions before connecting, and bad arguments with a clear message', async () => {
        for (const [args, message] of /** @type {[string[], RegExp][]} */ ([
            // Nothing listens on port 1: these must fail before any connection attempt.
            [['127.0.0.1', 'teleport', '--port', '1'], /Unknown action "teleport"/],
            [['127.0.0.1', 'info', '--port', '0'], /--port must be an integer from 1 to 65535/],
            [['127.0.0.1', 'info', '--bogus'], /Unknown option '--bogus'/],
            [['127.0.0.1', 'read', '--port', String(sim.port)], /register must be an integer from 1 to 65536/],
            [['127.0.0.1', 'read', '1203', '200', '--port', String(sim.port)], /count must be an integer from 1 to 125/]
        ])) {
            const { code, out } = await probe(args);
            assert.equal(code, 1, `${args.join(' ')}: ${out}`);
            assert.match(out, message);
        }
        const usage = await probe([]);
        assert.equal(usage.code, 1);
        assert.match(usage.out, /npm run probe -- <host> info/);
    });
});
