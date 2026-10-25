'use strict';

const assert = require('node:assert/strict');
const registers = require('../../lib/alicat/registers');
const { MAX_READ_QUANTITY } = require('../../lib/modbus/pdu');

const { REG, BLOCKS } = registers;

describe('alicat/registers', () => {
    it('converts 1-based register numbers to 0-based PDU addresses', () => {
        assert.equal(registers.toAddress(1), 0);
        assert.equal(registers.toAddress(REG.SETPOINT), 1009); // the production flow's setpoint address
        assert.equal(registers.toAddress(REG.LIMITED_COMMAND_ID), 999); // the production flow's command address
        for (const bad of [0, -1, 1.5, 0x10001, NaN]) {
            assert.throws(() => registers.toAddress(bad), (err) => /** @type {any} */ (err).code === 'EINVALIDARG');
        }
    });

    it('lays out the Gen-2 standard float block as in Rev 7', () => {
        assert.equal(registers.standardFloatRegister('setpoint'), 1350);
        assert.equal(registers.standardFloatRegister('pressure'), 1354);
        assert.equal(registers.standardFloatRegister('massFlow'), 1364);
        assert.equal(registers.standardFloatRegister('humidity'), 1370);
        assert.equal(registers.standardIntRegister('massFlow'), 1314);
        assert.deepEqual(BLOCKS.STD_FLOAT, { start: 1346, quantity: 26 });
    });

    it('lays out the standard info blocks at 1640 + 12·i', () => {
        assert.equal(registers.standardInfoRegister('setpoint'), 1640);
        assert.equal(registers.standardInfoRegister('massFlow'), 1724);
        assert.equal(registers.standardInfoRegister('humidity'), 1760);
        assert.equal(BLOCKS.STD_INFO.start + BLOCKS.STD_INFO.quantity - 1, 1771);
    });

    it('lays out optimized readings and their info blocks', () => {
        assert.equal(registers.optimizedReadingRegister(1), 1203);
        assert.equal(registers.optimizedReadingRegister(20), 1241);
        assert.equal(registers.optimizedInfoRegister(1), 1400);
        assert.equal(registers.optimizedInfoRegister(16), 1580);
        for (const bad of [0, 21, 1.5]) {
            assert.throws(() => registers.optimizedReadingRegister(bad), (err) => /** @type {any} */ (err).code === 'EINVALIDARG');
        }
    });

    it('rejects unknown standard reading names', () => {
        assert.throws(() => registers.standardFloatRegister('flux'), (err) => /** @type {any} */ (err).code === 'EINVALIDARG');
    });

    it('keeps every block within one request, except the info block which is chunked', () => {
        for (const [name, block] of Object.entries(BLOCKS)) {
            if (name === 'STD_INFO') {
                assert.ok(block.quantity > MAX_READ_QUANTITY);
            } else {
                assert.ok(block.quantity <= MAX_READ_QUANTITY, name);
            }
        }
    });
});
