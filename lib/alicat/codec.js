'use strict';

const { AlicatError } = require('../errors');

// Alicat multi-register values are big-endian: high word in the lower register,
// most significant byte first (ABCD). Floats are IEEE-754 single precision.

/** Float readings an instrument does not have read as this quiet NaN. */
const INVALID_FLOAT_BITS = 0xFFFFFFFF;
/** Integer readings an instrument does not have read as this value. */
const INVALID_INT32 = -2147483648;
/** Registers 1088–1089 (≥10v19) always hold these bits, i.e. 1.234567 as float32. */
const FIXED_TEST_BITS = 0x3F9E064B;
const FIXED_TEST_FLOAT = 1.234567;

const scratch = new DataView(new ArrayBuffer(4));

/**
 * @param {readonly number[]} words
 * @param {number} index
 * @param {number} count
 */
function assertWords(words, index, count) {
    if (!Array.isArray(words) || !Number.isInteger(index) || index < 0 || index + count > words.length) {
        throw new AlicatError('EINVALIDARG', `Need ${count} register(s) at index ${index}, have ${Array.isArray(words) ? words.length : 0}`);
    }
}

/**
 * The register at `index`, checked: a reply shorter than expected is an error, never `undefined`.
 * @param {readonly number[]} words
 * @param {number} index
 */
function word(words, index) {
    assertWords(words, index, 1);
    return /** @type {number} */ (words[index]);
}

/**
 * @param {readonly number[]} words
 * @param {number} index
 */
function u16(words, index) {
    return word(words, index) & 0xFFFF;
}

/**
 * @param {readonly number[]} words
 * @param {number} index
 */
function u32(words, index) {
    return (((word(words, index) & 0xFFFF) << 16) | (word(words, index + 1) & 0xFFFF)) >>> 0;
}

/**
 * @param {number[]} words
 * @param {number} index
 */
function i32(words, index) {
    return u32(words, index) | 0;
}

/** @param {number} bits */
function floatFromBits(bits) {
    scratch.setUint32(0, bits >>> 0);
    return scratch.getFloat32(0);
}

/** @param {number} value */
function bitsFromFloat(value) {
    scratch.setFloat32(0, value);
    return scratch.getUint32(0);
}

/**
 * Float32 reading, or `null` when the instrument reports it as invalid (NaN)
 * or the value is not finite.
 * @param {number[]} words
 * @param {number} index
 * @returns {number | null}
 */
function f32(words, index) {
    const value = floatFromBits(u32(words, index));
    return Number.isFinite(value) ? value : null;
}

/**
 * Scaled-integer reading, or `null` for the invalid sentinel.
 * @param {number[]} words
 * @param {number} index
 * @returns {number | null}
 */
function i32Reading(words, index) {
    const value = i32(words, index);
    return value === INVALID_INT32 ? null : value;
}

/**
 * Apply an info block's decimal places to a scaled-integer reading.
 * @param {number | null} value
 * @param {number} decimals
 */
function descale(value, decimals) {
    if (value === null) {
        return null;
    }
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 9) {
        throw new AlicatError('EINVALIDARG', `Decimal places must be 0–9, got ${String(decimals)}`);
    }
    return value / 10 ** decimals;
}

/**
 * @param {number} value
 * @returns {[number, number]}
 */
function encodeU32(value) {
    if (!Number.isInteger(value) || value < 0 || value > 0xFFFFFFFF) {
        throw new AlicatError('EINVALIDARG', `Expected an unsigned 32-bit integer, got ${String(value)}`);
    }
    return [Math.floor(value / 0x10000), value % 0x10000];
}

/**
 * @param {number} value
 * @returns {[number, number]}
 */
function encodeI32(value) {
    if (!Number.isInteger(value) || value < -0x80000000 || value > 0x7FFFFFFF) {
        throw new AlicatError('EINVALIDARG', `Expected a signed 32-bit integer, got ${String(value)}`);
    }
    return encodeU32(value >>> 0);
}

/**
 * @param {number} value
 * @returns {[number, number]}
 */
function encodeF32(value) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new AlicatError('EINVALIDARG', `Expected a finite number, got ${String(value)}`);
    }
    const max = 3.4028234663852886e38;
    if (Math.abs(value) > max) {
        throw new AlicatError('EINVALIDARG', `${value} is outside the float32 range`);
    }
    return encodeU32(bitsFromFloat(value));
}

/** The value as it will be stored by the device (float32 rounding). @param {number} value */
function toFloat32(value) {
    return Math.fround(value);
}

/**
 * Identify the word/byte order of a fixed-test-value read (registers 1088–1089).
 * Returns 'ABCD' for the correct order, the detected permutation otherwise, or
 * null if the words are not the test value in any order.
 * @param {number[]} words
 * @returns {'ABCD' | 'CDAB' | 'BADC' | 'DCBA' | null}
 */
function detectWordOrder(words) {
    /** @param {number} w */
    const swapBytes = (w) => ((w & 0xFF) << 8) | ((w >> 8) & 0xFF);
    const a = word(words, 0);
    const b = word(words, 1);
    /** @type {Array<['ABCD' | 'CDAB' | 'BADC' | 'DCBA', number, number]>} */
    const candidates = [
        ['ABCD', a, b],
        ['CDAB', b, a],
        ['BADC', swapBytes(a), swapBytes(b)],
        ['DCBA', swapBytes(b), swapBytes(a)]
    ];
    for (const [order, hi, lo] of candidates) {
        if ((((hi << 16) | lo) >>> 0) === FIXED_TEST_BITS) {
            return order;
        }
    }
    return null;
}

module.exports = {
    INVALID_FLOAT_BITS,
    INVALID_INT32,
    FIXED_TEST_BITS,
    FIXED_TEST_FLOAT,
    word,
    u16,
    u32,
    i32,
    f32,
    i32Reading,
    descale,
    floatFromBits,
    bitsFromFloat,
    encodeU32,
    encodeI32,
    encodeF32,
    toFloat32,
    detectWordOrder
};
