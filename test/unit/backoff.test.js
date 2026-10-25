'use strict';

const assert = require('node:assert/strict');
const { Backoff } = require('../../lib/Backoff');

describe('Backoff', () => {
    it('doubles from 1 s and caps at 30 s', () => {
        const b = new Backoff();
        assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 20].map((n) => b.ceiling(n)), [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
    });

    it('uses equal jitter: between half and all of the ceiling', () => {
        const low = new Backoff({ random: () => 0 });
        const high = new Backoff({ random: () => 0.999999 });
        assert.equal(low.delay(3), 2000);
        assert.equal(high.delay(3), 4000);
        const real = new Backoff();
        for (let i = 0; i < 200; i++) {
            const d = real.delay(4);
            assert.ok(d >= 4000 && d <= 8000, String(d));
        }
    });

    it('treats attempt 0 like the first retry and honours custom settings', () => {
        const b = new Backoff({ initialMs: 50, maxMs: 300, factor: 3, random: () => 0.5 });
        assert.equal(b.ceiling(0), 50);
        assert.equal(b.ceiling(3), 300);
        assert.equal(b.delay(2), 113);
    });
});
