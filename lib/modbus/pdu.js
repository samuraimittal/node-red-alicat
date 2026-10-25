'use strict';

const { AlicatError } = require('../errors');
const { exceptionName } = require('./exceptions');

// Alicat over Modbus TCP: FC04 for every read (FC03 is RTU-only), FC16 for every write (no FC06).
const FC_READ_INPUT_REGISTERS = 0x04;
const FC_WRITE_MULTIPLE_REGISTERS = 0x10;
const EXCEPTION_FLAG = 0x80;

const MAX_READ_QUANTITY = 125;
const MAX_WRITE_QUANTITY = 123;

const MBAP_HEADER_LENGTH = 7;
// The MBAP length field counts the unit ID plus the PDU; a PDU is at most 253 bytes.
const MIN_MBAP_LENGTH = 2;
const MAX_MBAP_LENGTH = 254;

/**
 * Requests and responses, keyed on the function code.
 * @typedef {{fc: 4, address: number, quantity: number, pdu: Buffer}} ReadRequest
 * @typedef {{fc: 16, address: number, quantity: number, values: number[], pdu: Buffer}} WriteRequest
 * @typedef {ReadRequest | WriteRequest} Request
 * @typedef {{fc: 4, registers: number[]}} ReadResponse
 * @typedef {{fc: 16, address: number, quantity: number}} WriteResponse
 * @typedef {ReadResponse | WriteResponse} Response
 * @typedef {{txnId: number, unitId: number, pdu: Buffer}} Frame
 */

/**
 * @param {unknown} value
 * @param {number} min
 * @param {number} max
 * @param {string} name
 */
function assertInt(value, min, max, name) {
    if (!Number.isInteger(value) || /** @type {number} */ (value) < min || /** @type {number} */ (value) > max) {
        throw new AlicatError('EINVALIDARG', `${name} must be an integer ${min}–${max}, got ${String(value)}`);
    }
}

/**
 * @param {number} address 0-based PDU address
 * @param {number} quantity
 * @returns {ReadRequest}
 */
function buildReadInputRegisters(address, quantity) {
    assertInt(quantity, 1, MAX_READ_QUANTITY, 'quantity');
    assertInt(address, 0, 0x10000 - quantity, 'address');
    const pdu = Buffer.alloc(5);
    pdu[0] = FC_READ_INPUT_REGISTERS;
    pdu.writeUInt16BE(address, 1);
    pdu.writeUInt16BE(quantity, 3);
    return { fc: FC_READ_INPUT_REGISTERS, address, quantity, pdu };
}

/**
 * @param {number} address 0-based PDU address
 * @param {number[]} values 16-bit register values
 * @returns {WriteRequest}
 */
function buildWriteMultipleRegisters(address, values) {
    if (!Array.isArray(values)) {
        throw new AlicatError('EINVALIDARG', 'values must be an array of 16-bit integers');
    }
    const quantity = values.length;
    assertInt(quantity, 1, MAX_WRITE_QUANTITY, 'quantity');
    assertInt(address, 0, 0x10000 - quantity, 'address');
    const pdu = Buffer.alloc(6 + quantity * 2);
    pdu[0] = FC_WRITE_MULTIPLE_REGISTERS;
    pdu.writeUInt16BE(address, 1);
    pdu.writeUInt16BE(quantity, 3);
    pdu[5] = quantity * 2;
    values.forEach((value, i) => {
        assertInt(value, 0, 0xFFFF, `values[${i}]`);
        pdu.writeUInt16BE(value, 6 + i * 2);
    });
    return { fc: FC_WRITE_MULTIPLE_REGISTERS, address, quantity, values: values.slice(), pdu };
}

/**
 * Whether a response PDU belongs to a request with function code `fc`
 * (either the normal reply or its exception reply).
 * @param {number} fc
 * @param {Buffer} pdu
 */
function matchesFunction(fc, pdu) {
    return pdu.length > 0 && (pdu[0] === fc || pdu[0] === (fc | EXCEPTION_FLAG));
}

/**
 * @overload
 * @param {ReadRequest} request
 * @param {Buffer} pdu
 * @returns {ReadResponse}
 */
/**
 * @overload
 * @param {WriteRequest} request
 * @param {Buffer} pdu
 * @returns {WriteResponse}
 */
/**
 * @overload
 * @param {Request} request
 * @param {Buffer} pdu
 * @returns {Response}
 */
/**
 * Validate and decode a response PDU against its request.
 * @param {Request} request
 * @param {Buffer} pdu
 * @returns {Response}
 */
function decodeResponse(request, pdu) {
    if (pdu.length < 1) {
        throw new AlicatError('EFRAMING', 'Empty response PDU');
    }
    if (pdu[0] === (request.fc | EXCEPTION_FLAG)) {
        if (pdu.length !== 2) {
            throw new AlicatError('EFRAMING', `Exception response has length ${pdu.length}, expected 2`);
        }
        const exceptionCode = pdu.readUInt8(1);
        const name = exceptionName(exceptionCode);
        throw new AlicatError('EMODBUS', `Modbus exception ${exceptionCode} (${name})`, {
            exceptionCode,
            exceptionName: name,
            fc: request.fc,
            address: request.address
        });
    }
    if (pdu[0] !== request.fc) {
        throw new AlicatError('EFRAMING', `Response function code ${pdu[0]} does not match request ${request.fc}`);
    }
    if (request.fc === FC_READ_INPUT_REGISTERS) {
        const byteCount = pdu[1];
        if (pdu.length < 2 || byteCount !== request.quantity * 2 || pdu.length !== 2 + byteCount) {
            throw new AlicatError('EFRAMING',
                `FC04 response carries ${pdu.length < 2 ? 0 : byteCount} bytes, expected ${request.quantity * 2}`);
        }
        const registers = new Array(request.quantity);
        for (let i = 0; i < request.quantity; i++) {
            registers[i] = pdu.readUInt16BE(2 + i * 2);
        }
        return { fc: request.fc, registers };
    }
    if (request.fc === FC_WRITE_MULTIPLE_REGISTERS) {
        if (pdu.length !== 5) {
            throw new AlicatError('EFRAMING', `FC16 response has length ${pdu.length}, expected 5`);
        }
        const address = pdu.readUInt16BE(1);
        const quantity = pdu.readUInt16BE(3);
        if (address !== request.address || quantity !== request.quantity) {
            throw new AlicatError('EFRAMING',
                `FC16 echo ${address}/${quantity} does not match request ${request.address}/${request.quantity}`);
        }
        return { fc: request.fc, address, quantity };
    }
    // Only reachable from untyped callers: a typed Request is always FC04 or FC16.
    throw new AlicatError('EINVALIDARG', `Unsupported function code ${/** @type {{fc: number}} */ (request).fc}`);
}

/**
 * @param {number} txnId
 * @param {number} unitId
 * @param {Buffer} pdu
 */
function encodeFrame(txnId, unitId, pdu) {
    assertInt(txnId, 0, 0xFFFF, 'txnId');
    assertInt(unitId, 0, 0xFF, 'unitId');
    if (pdu.length < 1 || pdu.length > MAX_MBAP_LENGTH - 1) {
        throw new AlicatError('EINVALIDARG', `PDU length ${pdu.length} out of range`);
    }
    const frame = Buffer.alloc(MBAP_HEADER_LENGTH + pdu.length);
    frame.writeUInt16BE(txnId, 0);
    frame.writeUInt16BE(0, 2);
    frame.writeUInt16BE(pdu.length + 1, 4);
    frame[6] = unitId;
    pdu.copy(frame, MBAP_HEADER_LENGTH);
    return frame;
}

/**
 * Reassembles MBAP frames from an arbitrary chunking of a TCP byte stream.
 * A header that cannot be valid Modbus TCP throws EFRAMING: a TCP stream cannot
 * be resynchronised, so the caller must drop the connection.
 */
class FrameParser {
    constructor() {
        /** @type {Buffer} */
        this._buffer = Buffer.alloc(0);
    }

    /**
     * @param {Buffer} chunk
     * @returns {Frame[]}
     */
    push(chunk) {
        this._buffer = this._buffer.length === 0 ? chunk : Buffer.concat([this._buffer, chunk]);
        /** @type {Frame[]} */
        const frames = [];
        while (this._buffer.length >= MBAP_HEADER_LENGTH) {
            const protocolId = this._buffer.readUInt16BE(2);
            const length = this._buffer.readUInt16BE(4);
            if (protocolId !== 0) {
                this._buffer = Buffer.alloc(0);
                throw new AlicatError('EFRAMING', `MBAP protocol identifier ${protocolId}, expected 0`);
            }
            if (length < MIN_MBAP_LENGTH || length > MAX_MBAP_LENGTH) {
                this._buffer = Buffer.alloc(0);
                throw new AlicatError('EFRAMING', `MBAP length ${length} out of range ${MIN_MBAP_LENGTH}–${MAX_MBAP_LENGTH}`);
            }
            const total = MBAP_HEADER_LENGTH - 1 + length;
            if (this._buffer.length < total) {
                break;
            }
            frames.push({
                txnId: this._buffer.readUInt16BE(0),
                unitId: this._buffer.readUInt8(6),
                pdu: Buffer.from(this._buffer.subarray(MBAP_HEADER_LENGTH, total))
            });
            this._buffer = this._buffer.subarray(total);
        }
        return frames;
    }

    get pendingBytes() {
        return this._buffer.length;
    }
}

module.exports = {
    FC_READ_INPUT_REGISTERS,
    FC_WRITE_MULTIPLE_REGISTERS,
    EXCEPTION_FLAG,
    MAX_READ_QUANTITY,
    MAX_WRITE_QUANTITY,
    MBAP_HEADER_LENGTH,
    MAX_MBAP_LENGTH,
    buildReadInputRegisters,
    buildWriteMultipleRegisters,
    matchesFunction,
    decodeResponse,
    encodeFrame,
    FrameParser
};
