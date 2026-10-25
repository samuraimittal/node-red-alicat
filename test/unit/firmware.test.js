'use strict';

const assert = require('node:assert/strict');
const firmware = require('../../lib/alicat/firmware');

describe('alicat/firmware', () => {
    it('parses Alicat version strings', () => {
        assert.deepEqual(firmware.parse('10v20.0'), { major: 10, minor: 20, custom: 0, text: '10v20.0' });
        assert.deepEqual(firmware.parse('8v24'), { major: 8, minor: 24, custom: 0, text: '8v24.0' });
        assert.equal(firmware.parse(' 6V17.1 ').text, '6v17.1');
        assert.throws(() => firmware.parse('v10'), (err) => /** @type {any} */ (err).code === 'EINVALIDARG');
    });

    it('decodes registers 1090–1093', () => {
        assert.deepEqual(firmware.fromRegisters([10, 7, 0, 3]), { major: 10, minor: 7, custom: 0, internal: 3, text: '10v07.0' });
        assert.throws(() => firmware.fromRegisters([10, 7]), (err) => /** @type {any} */ (err).code === 'EINVALIDARG');
    });

    it('compares versions numerically', () => {
        assert.equal(firmware.compare('10v07.0', '9v99.0'), 1);
        assert.equal(firmware.compare('10v07.0', '10v07.0'), 0);
        assert.equal(firmware.compare('10v06.9', '10v07.0'), -1);
        assert.equal(firmware.compare('10v19.1', '10v19.0'), 1);
        assert.equal(firmware.atLeast(firmware.parse('10v19.0'), '10v07.0'), true);
    });

    it('gates features by minimum firmware', () => {
        assert.equal(firmware.supports('10v07.0', 'extendedCommands'), true);
        assert.equal(firmware.supports('10v06.0', 'extendedCommands'), false);
        assert.equal(firmware.supports('10v18.0', 'testRegisters'), false);
        assert.equal(firmware.supports('10v19.0', 'testRegisters'), true);
        assert.equal(firmware.supports('10v18.0', 'loopVariableQuery'), false);
        assert.equal(firmware.supports('10v20.0', 'totalizerSelect'), true);
        assert.equal(firmware.supports(null, 'standardReadings'), false);
        assert.throws(() => firmware.supports('10v20.0', /** @type {any} */ ('teleport')),
            (err) => /** @type {any} */ (err).code === 'EINVALIDARG');
    });

    it('requires positive evidence for Gen-2 firmware registers', () => {
        assert.equal(firmware.isPlausibleGen2([10, 20, 0, 0]), true);
        assert.equal(firmware.isPlausibleGen2([10, 7, 0, 0]), true);
        assert.equal(firmware.isPlausibleGen2([10, 6, 0, 0]), false); // below 10v07
        assert.equal(firmware.isPlausibleGen2([0xFFFF, 0xFFFF, 0xFFFF, 0xFFFF]), false);
        assert.equal(firmware.isPlausibleGen2([10, 20, 0xFFFF, 0]), false);
        assert.equal(firmware.isPlausibleGen2([0, 0, 0, 0]), false);
        assert.equal(firmware.isPlausibleGen2([31, 0, 0, 0]), false);
        assert.equal(firmware.isPlausibleGen2([10, 100, 0, 0]), false);
        assert.equal(firmware.isPlausibleGen2([10, 20]), false);
    });

    it('recognises the all-0xFFFF undefined pattern', () => {
        assert.equal(firmware.looksUndefined([0xFFFF, 0xFFFF, 0xFFFF, 0xFFFF]), true);
        assert.equal(firmware.looksUndefined([0xFFFF, 0xFFFF, 0xFFFF, 0]), false);
        assert.equal(firmware.looksUndefined([]), false);
    });
});
