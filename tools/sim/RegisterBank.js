'use strict';

const { ILLEGAL_DATA_ADDRESS, ILLEGAL_DATA_VALUE } = require('../../lib/modbus/exceptions');
const codec = require('../../lib/alicat/codec');

/** Thrown by the bank; the server turns it into a Modbus exception reply. */
class ModbusException extends Error {
    /** @param {number} exceptionCode @param {string} message */
    constructor(exceptionCode, message) {
        super(message);
        this.exceptionCode = exceptionCode;
    }
}

/**
 * @typedef {{start: number, quantity: number, onWrite?: ((values: number[], start: number) => void) | undefined, store: boolean}} WriteGroup
 */

/**
 * Sparse 16-bit register store addressed by 1-based register NUMBER (as in the
 * Alicat manual). Reads of undefined registers raise ILLEGAL DATA ADDRESS, or
 * return `undefinedValue` (e.g. 0xFFFF) when configured — the manual allows both.
 * Multi-register write groups must be written as a whole, like the setpoint pair.
 */
class RegisterBank {
    /** @param {{undefinedValue?: number | null}} [options] */
    constructor(options = {}) {
        /** @type {Map<number, number>} */
        this._values = new Map();
        /** @type {Set<number>} */
        this._writable = new Set();
        /** @type {WriteGroup[]} */
        this._groups = [];
        /** @type {Set<number>} registers that exist for writing but raise exception 02 on read */
        this._writeOnly = new Set();
        this.undefinedValue = options.undefinedValue ?? null;
    }

    /**
     * @param {number} register
     * @param {number} [value]
     * @param {{writable?: boolean}} [options]
     */
    define(register, value = 0, options = {}) {
        this._values.set(register, value & 0xFFFF);
        if (options.writable) {
            this._writable.add(register);
        }
        return this;
    }

    /**
     * @param {number} start
     * @param {number} quantity
     * @param {{writable?: boolean, value?: number}} [options]
     */
    defineRange(start, quantity, options = {}) {
        for (let r = start; r < start + quantity; r++) {
            this.define(r, options.value ?? 0, options);
        }
        return this;
    }

    /**
     * Declare registers that must be written together (one FC16 frame), with an
     * optional handler run after the write.
     * - `store: false`: a write is captured by the handler but doesn't change what
     *   reads return. This is how Alicat command registers behave: you write a
     *   command and read back the echo.
     * - `readable: false`: write-only, so reads raise exception 02 (the 9v07
     *   setpoint register).
     * @param {number} start
     * @param {number} quantity
     * @param {(values: number[], start: number) => void} [onWrite]
     * @param {{store?: boolean, readable?: boolean}} [options]
     */
    group(start, quantity, onWrite, options = {}) {
        this.defineRange(start, quantity, { writable: true, value: this.has(start) ? this.get(start) : 0 });
        this._groups.push({ start, quantity, onWrite, store: options.store ?? true });
        if (options.readable === false) {
            for (let r = start; r < start + quantity; r++) this._writeOnly.add(r);
        }
        return this;
    }

    /**
     * Make reads of a register raise exception 02 (or answer again), e.g. a data
     * frame that shrinks under a connected client.
     * @param {number} register @param {boolean} readable
     */
    setReadable(register, readable) {
        if (readable) this._writeOnly.delete(register);
        else this._writeOnly.add(register);
        return this;
    }

    /** @param {number} register */
    has(register) {
        return this._values.has(register);
    }

    /** @param {number} register */
    get(register) {
        const value = this._values.get(register);
        if (value === undefined) {
            throw new Error(`Register ${register} is not defined`);
        }
        return value;
    }

    /** @param {number} register @param {number} value */
    set(register, value) {
        if (!this._values.has(register)) {
            throw new Error(`Register ${register} is not defined`);
        }
        this._values.set(register, value & 0xFFFF);
    }

    /** @param {number} register @param {number} bits */
    setU32(register, bits) {
        const [hi, lo] = codec.encodeU32(bits >>> 0);
        this.set(register, hi);
        this.set(register + 1, lo);
    }

    /** @param {number} register @param {number | null} value null → invalid (NaN) */
    setFloat(register, value) {
        this.setU32(register, value === null ? codec.INVALID_FLOAT_BITS : codec.bitsFromFloat(value));
    }

    /** @param {number} register @param {number | null} value null → invalid sentinel */
    setI32(register, value) {
        this.setU32(register, (value === null ? codec.INVALID_INT32 : value) >>> 0);
    }

    /** @param {number} register */
    getFloat(register) {
        return codec.f32([this.get(register), this.get(register + 1)], 0);
    }

    /**
     * @param {number} address 0-based PDU address
     * @param {number} quantity
     * @returns {number[]}
     */
    read(address, quantity) {
        const out = new Array(quantity);
        for (let i = 0; i < quantity; i++) {
            const register = address + 1 + i;
            const value = this._writeOnly.has(register) ? undefined : this._values.get(register);
            if (value === undefined) {
                if (this.undefinedValue === null) {
                    throw new ModbusException(ILLEGAL_DATA_ADDRESS, `Register ${register} is not defined`);
                }
                out[i] = this.undefinedValue;
            } else {
                out[i] = value;
            }
        }
        return out;
    }

    /**
     * @param {number} address 0-based PDU address
     * @param {number[]} values
     */
    write(address, values) {
        const first = address + 1;
        const last = first + values.length - 1;
        for (let r = first; r <= last; r++) {
            if (!this._writable.has(r)) {
                throw new ModbusException(ILLEGAL_DATA_ADDRESS, `Register ${r} is not writable`);
            }
        }
        const touched = this._groups.filter((g) => g.start <= last && g.start + g.quantity - 1 >= first);
        for (const g of touched) {
            if (g.start < first || g.start + g.quantity - 1 > last) {
                throw new ModbusException(ILLEGAL_DATA_VALUE,
                    `Registers ${g.start}–${g.start + g.quantity - 1} must be written together`);
            }
        }
        const captureOnly = new Set();
        for (const g of touched) {
            if (!g.store) for (let r = g.start; r < g.start + g.quantity; r++) captureOnly.add(r);
        }
        values.forEach((value, i) => {
            if (!captureOnly.has(first + i)) this._values.set(first + i, value & 0xFFFF);
        });
        for (const g of touched) {
            if (g.onWrite) {
                g.onWrite(values.slice(g.start - first, g.start - first + g.quantity), g.start);
            }
        }
    }
}

module.exports = { RegisterBank, ModbusException };
