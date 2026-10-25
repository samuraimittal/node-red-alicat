'use strict';

const assert = require('node:assert/strict');
const codec = require('../../lib/alicat/codec');

/** @param {() => unknown} fn */
const invalidArg = (fn) => assert.throws(fn, (err) => /** @type {any} */ (err).code === 'EINVALIDARG');

describe('alicat/codec', () => {
    it('decodes the fixed test value (registers 1088–1089) as 1.234567', () => {
        const words = [0x3F9E, 0x064B];
        assert.equal(codec.u32(words, 0), codec.FIXED_TEST_BITS);
        assert.equal(codec.i32(words, 0), 1067320907);
        assert.equal(codec.f32(words, 0), Math.fround(codec.FIXED_TEST_FLOAT));
    });

    it('decodes u16/u32/i32 big-endian, high word first', () => {
        assert.equal(codec.u16([0x1234], 0), 0x1234);
        assert.equal(codec.u32([0xFFFF, 0xFFFE], 0), 0xFFFFFFFE);
        assert.equal(codec.i32([0xFFFF, 0xFFFE], 0), -2);
        assert.equal(codec.u32([0, 0, 0x0001, 0x0002], 2), 0x00010002);
    });

    it('reads a register only if the reply has it, never undefined', () => {
        assert.equal(codec.word([7, 8], 1), 8);
        invalidArg(() => codec.word([7, 8], 2));
        invalidArg(() => codec.word([7, 8], -1));
        invalidArg(() => codec.u16([], 0));
        invalidArg(() => codec.u32([1], 0));
    });

    it('maps the invalid sentinels to null', () => {
        assert.equal(codec.f32([0xFFFF, 0xFFFF], 0), null);
        assert.equal(codec.f32([0x7FC0, 0x0000], 0), null); // any NaN
        assert.equal(codec.f32([0x7F80, 0x0000], 0), null); // +Infinity
        assert.equal(codec.i32Reading([0x8000, 0x0000], 0), null);
        assert.equal(codec.i32Reading([0x0000, 0x3039], 0), 12345);
    });

    it('descales integer readings by decimal places', () => {
        assert.equal(codec.descale(12345, 3), 12.345);
        assert.equal(codec.descale(null, 3), null);
        assert.equal(codec.descale(-50, 1), -5);
        invalidArg(() => codec.descale(1, -1));
        invalidArg(() => codec.descale(1, 1.5));
    });

    it('encodes u32/i32/f32 into two registers and round-trips', () => {
        assert.deepEqual(codec.encodeU32(0x3F9E064B), [0x3F9E, 0x064B]);
        assert.deepEqual(codec.encodeI32(-2), [0xFFFF, 0xFFFE]);
        assert.deepEqual(codec.encodeF32(12.5), [0x4148, 0x0000]);
        for (const value of [0, -0, 0.1, 1.234567, -273.15, 64000, 1e-30, 3.4e38]) {
            assert.equal(codec.f32(codec.encodeF32(value), 0), Math.fround(value), String(value));
        }
    });

    it('rejects values that cannot be encoded', () => {
        invalidArg(() => codec.encodeU32(-1));
        invalidArg(() => codec.encodeU32(0x100000000));
        invalidArg(() => codec.encodeU32(1.5));
        invalidArg(() => codec.encodeI32(0x80000000));
        invalidArg(() => codec.encodeF32(NaN));
        invalidArg(() => codec.encodeF32(Infinity));
        invalidArg(() => codec.encodeF32(/** @type {any} */ ('12')));
        invalidArg(() => codec.encodeF32(1e39));
    });

    it('rejects reads past the end of the register array', () => {
        invalidArg(() => codec.u32([1], 0));
        invalidArg(() => codec.u16([], 0));
        invalidArg(() => codec.f32(/** @type {any} */ (null), 0));
    });

    it('toFloat32 is the value the device will store', () => {
        assert.equal(codec.toFloat32(0.1), 0.10000000149011612);
        assert.notEqual(codec.toFloat32(0.1), 0.1);
    });

    describe('detectWordOrder (self-test permutations from the manual)', () => {
        const cases = /** @type {const} */ ([
            [[0x3F9E, 0x064B], 'ABCD'],
            [[0x064B, 0x3F9E], 'CDAB'],
            [[0x9E3F, 0x4B06], 'BADC'],
            [[0x4B06, 0x9E3F], 'DCBA']
        ]);
        for (const [words, order] of cases) {
            it(`detects ${order}`, () => assert.equal(codec.detectWordOrder([...words]), order));
        }
        it('returns null for anything else', () => {
            assert.equal(codec.detectWordOrder([0x0000, 0x0000]), null);
            assert.equal(codec.detectWordOrder([0xFFFF, 0xFFFF]), null);
        });
    });
});
