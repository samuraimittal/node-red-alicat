'use strict';

const assert = require('node:assert/strict');
const { BOUNDS, settingsReader } = require('../../lib/node-red/settings');

describe('node-red/settings', () => {
    const GAP = { min: 0, max: 1000, default: 20, integer: true };

    it('keeps a configured 0, uses the default when empty, and reports every bad value', () => {
        const read = settingsReader({ zero: '0', empty: '', big: '5000', frac: '1.5', num: 7, junk: 'x' });
        assert.equal(read.number('zero', GAP, 'Gap'), 0);
        assert.equal(read.number('empty', GAP, 'Gap'), 20);
        assert.equal(read.number('missing', GAP, 'Gap'), 20);
        assert.equal(read.number('num', GAP, 'Gap'), 7);
        assert.equal(read.number('big', GAP, 'Gap'), 20);
        assert.equal(read.number('frac', GAP, 'Gap'), 20);
        assert.equal(read.number('junk', GAP, 'Gap'), 20);
        assert.deepEqual(read.problems, [
            'Gap must be an integer 0–1000 (got "5000")',
            'Gap must be an integer 0–1000 (got "1.5")',
            'Gap must be an integer 0–1000 (got "x")'
        ]);
    });

    it('accepts fractions where the bounds allow them, and optional numbers may be empty', () => {
        const read = settingsReader({ periodic: '0.5', tolerance: '', negative: '-1', small: '0.01' });
        assert.equal(read.number('periodic', BOUNDS.status.periodic, 'Periodic'), 0.5);
        assert.equal(read.optionalNumber('tolerance', 0, 'Tolerance'), null);
        assert.equal(read.optionalNumber('small', 0, 'Tolerance'), 0.01);
        assert.equal(read.optionalNumber('negative', 0, 'Tolerance'), null);
        assert.deepEqual(read.problems, ['Tolerance must be empty or a number ≥ 0 (got "-1")']);
    });

    it('takes known choices, defaults absent ones, and reports unknown ones instead of guessing', () => {
        const read = settingsReader({ mode: 'direct', odd: 'sideways' });
        const modes = /** @type {const} */ (['bumpless', 'direct']);
        assert.equal(read.choice('mode', modes, 'bumpless', 'Mode'), 'direct');
        assert.equal(read.choice('missing', modes, 'bumpless', 'Mode'), 'bumpless');
        assert.equal(read.choice('odd', modes, 'bumpless', 'Mode'), 'bumpless');
        assert.deepEqual(read.problems, ['Mode must be one of bumpless, direct (got "sideways")']);
    });

    it('reads text and checkboxes, telling a missing field from a cleared one', () => {
        const read = settingsReader({ name: 'x', blank: '', number: 5, on: true, onText: 'true', off: false });
        assert.equal(read.text('name'), 'x');
        assert.equal(read.text('blank', 'def'), 'def');
        assert.equal(read.text('number'), '5');
        assert.equal(read.optionalText('missing'), undefined);
        assert.equal(read.optionalText('blank'), '');
        assert.equal(read.flag('on', false), true);
        assert.equal(read.flag('onText', false), true);
        assert.equal(read.flag('off', true), false);
        assert.equal(read.flag('missing', true), true);
        assert.deepEqual(read.problems, []);
    });

    it('has a default inside every range', () => {
        for (const [group, table] of Object.entries(BOUNDS)) {
            for (const [key, b] of Object.entries(table)) {
                assert.ok(b.min <= b.default && b.default <= b.max, `${group}.${key}`);
            }
        }
    });
});
