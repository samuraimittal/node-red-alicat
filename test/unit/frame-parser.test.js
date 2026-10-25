'use strict';

const assert = require('node:assert/strict');
const { FrameParser, encodeFrame } = require('../../lib/modbus/pdu');
const { prng } = require('../helpers/raw-server');

/** @param {number} n @param {() => number} rand */
function randomFrames(n, rand) {
    const frames = [];
    for (let i = 0; i < n; i++) {
        const length = 1 + Math.floor(rand() * 253);
        const body = Buffer.alloc(length);
        for (let j = 0; j < length; j++) body[j] = Math.floor(rand() * 256);
        frames.push({ txnId: Math.floor(rand() * 0x10000), unitId: Math.floor(rand() * 256), pdu: body });
    }
    return frames;
}

describe('modbus/FrameParser', () => {
    it('parses one complete frame', () => {
        const parser = new FrameParser();
        const frames = parser.push(encodeFrame(7, 1, Buffer.from([0x04, 2, 0, 1])));
        assert.equal(frames.length, 1);
        assert.deepEqual(frames[0], { txnId: 7, unitId: 1, pdu: Buffer.from([0x04, 2, 0, 1]) });
        assert.equal(parser.pendingBytes, 0);
    });

    it('reassembles a frame delivered byte by byte', () => {
        const parser = new FrameParser();
        const bytes = encodeFrame(42, 3, Buffer.from([0x10, 0x03, 0xF1, 0, 2]));
        /** @type {any[]} */
        let out = [];
        for (let i = 0; i < bytes.length; i++) {
            out = out.concat(parser.push(bytes.subarray(i, i + 1)));
            assert.equal(out.length, i === bytes.length - 1 ? 1 : 0);
        }
        assert.equal(out[0].txnId, 42);
    });

    it('splits several frames merged into one chunk', () => {
        const parser = new FrameParser();
        const merged = Buffer.concat([
            encodeFrame(1, 1, Buffer.from([0x04, 0])),
            encodeFrame(2, 1, Buffer.from([0x84, 2])),
            encodeFrame(3, 1, Buffer.from([0x10, 0, 0, 0, 1]))
        ]);
        assert.deepEqual(parser.push(merged).map((f) => f.txnId), [1, 2, 3]);
    });

    it('fuzz: any chunking of a valid stream yields the same frames', () => {
        for (let seed = 1; seed <= 25; seed++) {
            const rand = prng(seed);
            const expected = randomFrames(40, rand);
            const stream = Buffer.concat(expected.map((f) => encodeFrame(f.txnId, f.unitId, f.pdu)));
            const parser = new FrameParser();
            /** @type {any[]} */
            const got = [];
            let offset = 0;
            while (offset < stream.length) {
                const size = 1 + Math.floor(rand() * 300);
                got.push(...parser.push(stream.subarray(offset, offset + size)));
                offset += size;
            }
            assert.equal(parser.pendingBytes, 0, `seed ${seed}`);
            assert.deepEqual(got, expected, `seed ${seed}`);
        }
    });

    it('rejects a non-zero protocol identifier', () => {
        const parser = new FrameParser();
        const bad = encodeFrame(1, 1, Buffer.from([0x04, 0]));
        bad.writeUInt16BE(0xBEEF, 2);
        assert.throws(() => parser.push(bad), (err) => /** @type {any} */ (err).code === 'EFRAMING');
        assert.equal(parser.pendingBytes, 0);
    });

    it('rejects lengths outside 2–254', () => {
        for (const length of [0, 1, 255, 0xFFFF]) {
            const parser = new FrameParser();
            const header = Buffer.from([0, 1, 0, 0, length >> 8, length & 0xFF, 1]);
            assert.throws(() => parser.push(header), (err) => /** @type {any} */ (err).code === 'EFRAMING', `length ${length}`);
        }
    });

    it('fuzz: random garbage either parses or throws EFRAMING, never hangs or grows', () => {
        for (let seed = 100; seed < 140; seed++) {
            const rand = prng(seed);
            const parser = new FrameParser();
            for (let i = 0; i < 50; i++) {
                const chunk = Buffer.alloc(1 + Math.floor(rand() * 64));
                for (let j = 0; j < chunk.length; j++) chunk[j] = Math.floor(rand() * 256);
                try {
                    parser.push(chunk);
                } catch (err) {
                    assert.equal(/** @type {any} */ (err).code, 'EFRAMING');
                }
                assert.ok(parser.pendingBytes <= 6 + 254 + 64);
            }
        }
    });
});
