'use strict';

const assert = require('node:assert/strict');
const sinon = require('sinon');
const { unref, sleep, pollUntil } = require('../../lib/util/timers');

describe('util/timers', () => {
    /** @type {sinon.SinonFakeTimers} */
    let clock;
    beforeEach(() => { clock = sinon.useFakeTimers(); });
    afterEach(() => clock.restore());

    it('unref() returns the timer and tolerates timers without unref', () => {
        const timer = setTimeout(() => {}, 10);
        assert.equal(unref(timer), timer);
        const bare = /** @type {any} */ ({});
        assert.equal(unref(bare), bare);
    });

    it('sleep() waits, and an abort ends it early with an error', async () => {
        let done = false;
        const plain = sleep(100).then(() => { done = true; });
        await clock.tickAsync(99);
        assert.equal(done, false);
        await clock.tickAsync(1);
        await plain;
        assert.equal(done, true);

        const controller = new AbortController();
        const aborted = sleep(1000, controller.signal);
        controller.abort();
        await assert.rejects(aborted, /aborted/);
        await assert.rejects(sleep(10, controller.signal), /aborted/, 'an aborted signal fails at once');
        const fine = sleep(10, new AbortController().signal);
        await clock.tickAsync(10);
        await fine;
    });

    it('pollUntil() stops at the first success', async () => {
        let calls = 0;
        const result = pollUntil(async () => ++calls === 3, { intervalMs: 50 });
        await clock.tickAsync(100);
        assert.equal(await result, true);
        assert.equal(calls, 3);
    });

    it('pollUntil() gives up after `attempts` calls, waiting between them only', async () => {
        let calls = 0;
        const result = pollUntil(async () => { calls++; return false; }, { intervalMs: 200, attempts: 6 });
        await clock.tickAsync(1000);
        assert.equal(await result, false);
        assert.equal(calls, 6, '6 calls, 5 waits of 200 ms');
    });

    it('pollUntil() gives up once `timeoutMs` has passed after a failed check', async () => {
        let calls = 0;
        const result = pollUntil(async () => { calls++; return false; }, { intervalMs: 100, timeoutMs: 250 });
        await clock.tickAsync(300);
        assert.equal(await result, false);
        assert.equal(calls, 4, 'at 0, 100, 200 and 300 ms');
    });
});
