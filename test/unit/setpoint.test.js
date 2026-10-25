'use strict';

const assert = require('node:assert/strict');
const { setpointTolerance, withinTolerance } = require('../../lib/alicat/setpoint');

describe('alicat/setpoint (read-back tolerance)', () => {
    it('allows half of the last decimal place, with a floor for undeclared decimals', () => {
        const near = (/** @type {number} */ a, /** @type {number} */ b) => assert.ok(Math.abs(a - b) < 1e-12, `${a} ≈ ${b}`);
        near(setpointTolerance({ decimals: 2 }, 50), 0.005);
        near(setpointTolerance({ decimals: null }, 50), 5e-5);
        near(setpointTolerance(null, 0), 1e-6);
        near(setpointTolerance(null, -2000), 2e-3);
    });

    it('compares against the float32 value actually written', () => {
        assert.equal(withinTolerance(Math.fround(0.1), 0.1, 1e-6), true);
        assert.equal(withinTolerance(10.004, 10, 0.005), true);
        assert.equal(withinTolerance(10.006, 10, 0.005), false);
        assert.equal(withinTolerance(null, 10, 1), false);
    });
});
