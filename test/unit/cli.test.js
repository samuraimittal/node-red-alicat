'use strict';

const assert = require('node:assert/strict');
const path = require('path');
const { execFileSync } = require('child_process');
const { parseCli, numberOption, choiceOption } = require('../../tools/cli');

const TOOLS = path.join(__dirname, '..', '..', 'tools');

/** Run a tool and return {code, out}. @param {string} tool @param {string[]} args */
function run(tool, args) {
    try {
        const out = execFileSync(process.execPath, [path.join(TOOLS, tool), ...args], { encoding: 'utf8', stdio: 'pipe', timeout: 10000 });
        return { code: 0, out };
    } catch (err) {
        const e = /** @type {any} */ (err);
        return { code: e.status, out: `${e.stdout}${e.stderr}` };
    }
}

describe('tools command line', () => {
    it('refuses unknown flags and flags without a value', () => {
        const options = /** @type {const} */ ({ port: { type: 'string' }, write: { type: 'boolean' } });
        assert.throws(() => parseCli(['--prot', '502'], options), /Unknown option '--prot'/);
        assert.throws(() => parseCli(['--port'], options), /--port/);
        assert.deepEqual(parseCli(['10.0.0.1', 'info', '--write'], options).positionals, ['10.0.0.1', 'info']);
    });

    it('checks numbers and choices instead of turning them into 1, true or NaN', () => {
        assert.equal(numberOption({}, 'port', { fallback: 502, min: 1, max: 65535 }), 502);
        assert.equal(numberOption({ port: '5020' }, 'port', { fallback: 502, min: 1, max: 65535 }), 5020);
        for (const bad of ['', 'abc', '0', '70000', '1.5']) {
            assert.throws(() => numberOption({ port: bad }, 'port', { fallback: 502, min: 1, max: 65535 }), /--port must be an integer from 1 to 65535/, bad);
        }
        assert.equal(numberOption({ hours: '0.5' }, 'hours', { fallback: 24, min: 0.01, max: 168, integer: false }), 0.5);
        assert.equal(choiceOption({ as: 'f32' }, 'as', 'u16', ['u16', 'f32']), 'f32');
        assert.throws(() => choiceOption({ as: 'f64' }, 'as', 'u16', ['u16', 'f32']), /--as must be one of u16, f32/);
    });

    it('the probe refuses a polling interval that would hammer the instrument, and needs an action', () => {
        const fast = run('alicat-probe.js', ['127.0.0.1', 'watch', '1200', '--interval', '1']);
        assert.equal(fast.code, 1);
        assert.match(fast.out, /--interval must be an integer from 20 to 60000/);
        const missing = run('alicat-probe.js', ['127.0.0.1']);
        assert.equal(missing.code, 1, 'a missing action is an error');
        assert.equal(run('alicat-probe.js', ['--help']).code, 0);
    });

    it('the simulator refuses unknown profiles and bare flags', () => {
        assert.match(run('alicat-sim.js', ['--profile', 'nope']).out, /--profile must be one of/);
        assert.match(run('alicat-sim.js', ['--port']).out, /--port/);
        assert.equal(run('alicat-sim.js', ['--list']).code, 0);
    });
});
