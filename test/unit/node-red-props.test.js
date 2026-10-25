'use strict';

const assert = require('node:assert/strict');
const { evaluate, propertyValue, toNumber, parseLabels } = require('../../lib/node-red/props');

describe('node-red/props', () => {
    it('parses numbers and numeric strings only', () => {
        assert.equal(toNumber('12.5', 'x'), 12.5);
        assert.equal(toNumber(3, 'x'), 3);
        for (const bad of ['', 'abc', null, undefined, NaN, {}]) {
            assert.throws(() => toNumber(bad, 'Setpoint'), /Setpoint must be a number/);
        }
        assert.throws(() => toNumber(NaN, 'Setpoint'), /got NaN/);
        assert.throws(() => toNumber(undefined, 'Setpoint'), /got nothing/);
    });

    it('an empty msg property means msg.payload; any other empty value is an error, never 0', () => {
        assert.equal(propertyValue('', 'msg', 'Setpoint'), 'payload');
        assert.equal(propertyValue(undefined, undefined, 'Setpoint'), 'payload');
        assert.equal(propertyValue('payload.sp', 'msg', 'Setpoint'), 'payload.sp');
        assert.equal(propertyValue('12', 'num', 'Setpoint'), '12');
        assert.throws(() => propertyValue('', 'num', 'Setpoint'), /Setpoint is empty/);
        assert.throws(() => propertyValue('', 'flow', 'Setpoint'), /Setpoint is empty/);
    });

    it('turns a property that throws while being read into EINVALIDARG', async () => {
        const RED = /** @type {any} */ ({ util: { evaluateNodeProperty: () => { throw new Error('Invalid property expression'); } } });
        await assert.rejects(evaluate(RED, /** @type {any} */ ({}), {}, 'payload..x', 'msg'),
            (err) => /** @type {any} */ (err).code === 'EINVALIDARG' && /Invalid property expression/.test(/** @type {any} */ (err).message));
    });

    it('parses unit labels', () => {
        assert.deepEqual(parseLabels('massFlow=SCCM, setpoint = SCCM;bad'), { massFlow: 'SCCM', setpoint: 'SCCM' });
        assert.deepEqual(parseLabels(undefined), {});
    });
});
