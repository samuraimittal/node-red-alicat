'use strict';

const assert = require('node:assert/strict');
const pdu = require('../../lib/modbus/pdu');
const { exceptionName } = require('../../lib/modbus/exceptions');
const { throwsCode } = require('../helpers/assert');

describe('modbus/pdu', () => {
    describe('request builders', () => {
        it('encodes FC04 read input registers', () => {
            const req = pdu.buildReadInputRegisters(1345, 26);
            assert.equal(req.fc, 0x04);
            assert.deepEqual([...req.pdu], [0x04, 0x05, 0x41, 0x00, 0x1A]);
        });

        it('encodes FC16 write multiple registers', () => {
            const req = pdu.buildWriteMultipleRegisters(1009, [0x4148, 0x0000]);
            assert.deepEqual([...req.pdu], [0x10, 0x03, 0xF1, 0x00, 0x02, 0x04, 0x41, 0x48, 0x00, 0x00]);
            assert.equal(req.quantity, 2);
        });

        it('validates quantity, address and values', () => {
            throwsCode(() => pdu.buildReadInputRegisters(0, 0), 'EINVALIDARG');
            throwsCode(() => pdu.buildReadInputRegisters(0, 126), 'EINVALIDARG');
            throwsCode(() => pdu.buildReadInputRegisters(65535, 2), 'EINVALIDARG');
            throwsCode(() => pdu.buildReadInputRegisters(-1, 1), 'EINVALIDARG');
            throwsCode(() => pdu.buildWriteMultipleRegisters(0, []), 'EINVALIDARG');
            throwsCode(() => pdu.buildWriteMultipleRegisters(0, new Array(124).fill(0)), 'EINVALIDARG');
            throwsCode(() => pdu.buildWriteMultipleRegisters(0, [0x10000]), 'EINVALIDARG');
            throwsCode(() => pdu.buildWriteMultipleRegisters(0, [1.5]), 'EINVALIDARG');
            throwsCode(() => pdu.buildWriteMultipleRegisters(0, /** @type {any} */ ('x')), 'EINVALIDARG');
        });

        it('allows the largest legal requests', () => {
            assert.equal(pdu.buildReadInputRegisters(65535 - 124, 125).quantity, 125);
            assert.equal(pdu.buildWriteMultipleRegisters(0, new Array(123).fill(0xFFFF)).pdu.length, 252);
        });
    });

    describe('decodeResponse', () => {
        const read = pdu.buildReadInputRegisters(1089, 4);
        const write = pdu.buildWriteMultipleRegisters(1009, [1, 2]);

        it('decodes FC04 registers', () => {
            const res = pdu.decodeResponse(read, Buffer.from([0x04, 8, 0, 10, 0, 20, 0, 0, 0, 3]));
            assert.deepEqual(res, { fc: 4, registers: [10, 20, 0, 3] });
        });

        it('rejects FC04 replies with the wrong byte count', () => {
            throwsCode(() => pdu.decodeResponse(read, Buffer.from([0x04, 6, 0, 10, 0, 20, 0, 0])), 'EFRAMING');
            throwsCode(() => pdu.decodeResponse(read, Buffer.from([0x04, 8, 0, 10])), 'EFRAMING');
            throwsCode(() => pdu.decodeResponse(read, Buffer.from([0x04])), 'EFRAMING');
        });

        it('decodes and validates the FC16 echo', () => {
            assert.deepEqual(pdu.decodeResponse(write, Buffer.from([0x10, 0x03, 0xF1, 0, 2])),
                { fc: 16, address: 1009, quantity: 2 });
            throwsCode(() => pdu.decodeResponse(write, Buffer.from([0x10, 0x03, 0xF2, 0, 2])), 'EFRAMING');
            throwsCode(() => pdu.decodeResponse(write, Buffer.from([0x10, 0x03, 0xF1, 0])), 'EFRAMING');
        });

        it('turns exception replies into EMODBUS with code and name', () => {
            assert.throws(() => pdu.decodeResponse(read, Buffer.from([0x84, 0x02])), (err) => {
                const e = /** @type {any} */ (err);
                return e.code === 'EMODBUS' && e.exceptionCode === 2 && e.exceptionName === 'ILLEGAL_DATA_ADDRESS';
            });
            throwsCode(() => pdu.decodeResponse(read, Buffer.from([0x84, 0x02, 0x00])), 'EFRAMING');
        });

        it('rejects empty and mismatched function codes', () => {
            throwsCode(() => pdu.decodeResponse(read, Buffer.alloc(0)), 'EFRAMING');
            throwsCode(() => pdu.decodeResponse(read, Buffer.from([0x03, 2, 0, 0])), 'EFRAMING');
            throwsCode(() => pdu.decodeResponse(/** @type {any} */ ({ ...read, fc: 0x01 }), Buffer.from([0x01, 0])), 'EINVALIDARG');
        });

        it('matchesFunction accepts the normal and the exception reply', () => {
            assert.equal(pdu.matchesFunction(4, Buffer.from([0x04])), true);
            assert.equal(pdu.matchesFunction(4, Buffer.from([0x84])), true);
            assert.equal(pdu.matchesFunction(4, Buffer.from([0x10])), false);
            assert.equal(pdu.matchesFunction(4, Buffer.alloc(0)), false);
        });
    });

    describe('encodeFrame', () => {
        it('writes the MBAP header', () => {
            const frame = pdu.encodeFrame(0x1234, 1, Buffer.from([0x04, 0x04, 0x41, 0x00, 0x04]));
            assert.deepEqual([...frame.subarray(0, 7)], [0x12, 0x34, 0, 0, 0, 6, 1]);
        });

        it('validates its inputs', () => {
            throwsCode(() => pdu.encodeFrame(0x10000, 1, Buffer.from([4])), 'EINVALIDARG');
            throwsCode(() => pdu.encodeFrame(1, 256, Buffer.from([4])), 'EINVALIDARG');
            throwsCode(() => pdu.encodeFrame(1, 1, Buffer.alloc(0)), 'EINVALIDARG');
            throwsCode(() => pdu.encodeFrame(1, 1, Buffer.alloc(254)), 'EINVALIDARG');
        });
    });

    it('names exceptions, including unknown codes', () => {
        assert.equal(exceptionName(11), 'GATEWAY_TARGET_FAILED_TO_RESPOND');
        assert.equal(exceptionName(99), 'UNKNOWN_EXCEPTION_99');
    });
});
