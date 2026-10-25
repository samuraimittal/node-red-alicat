'use strict';

const assert = require('node:assert/strict');
const { PriorityQueue, Priority, settle } = require('../../lib/PriorityQueue');

/** @param {Partial<import('../../lib/PriorityQueue').RequestSpec>} [over] */
function spec(over = {}) {
    return /** @type {import('../../lib/PriorityQueue').RequestSpec} */ ({
        unitId: 1, request: { fc: 4, address: 0, quantity: 1, pdu: Buffer.alloc(5) },
        priority: Priority.CONTROL, timeoutMs: 1000, idempotent: true, retries: 0, laneJob: false, ...over
    });
}

/** @param {unknown} [owner] @param {number} [deadline] */
function waiter(owner = null, deadline = Infinity) {
    /** @type {any} */
    const w = { owner, deadline, result: undefined, error: undefined };
    w.resolve = (/** @type {unknown} */ v) => { w.result = v; };
    w.reject = (/** @type {Error} */ e) => { w.error = e; };
    return w;
}

describe('PriorityQueue', () => {
    it('serves URGENT, then CONTROL, then POLL, FIFO within a level', () => {
        const q = new PriorityQueue();
        const order = [];
        q.push(spec({ priority: Priority.POLL, unitId: 1 }), waiter(), 0);
        q.push(spec({ priority: Priority.CONTROL, unitId: 2 }), waiter(), 0);
        q.push(spec({ priority: Priority.URGENT, unitId: 3 }), waiter(), 0);
        q.push(spec({ priority: Priority.CONTROL, unitId: 4 }), waiter(), 0);
        for (let item = q.next(1); item; item = q.next(1)) order.push(item.unitId);
        assert.deepEqual(order, [3, 2, 4, 1]);
        assert.equal(q.size, 0);
    });

    it('ages a POLL that has waited too long ahead of CONTROL, never ahead of URGENT', () => {
        const q = new PriorityQueue({ agingMs: 3000 });
        q.push(spec({ priority: Priority.POLL, unitId: 1 }), waiter(), 0);
        q.push(spec({ priority: Priority.CONTROL, unitId: 2 }), waiter(), 2000);
        assert.equal(/** @type {any} */ (q.next(2500)).unitId, 2);
        q.push(spec({ priority: Priority.CONTROL, unitId: 3 }), waiter(), 3500);
        q.push(spec({ priority: Priority.URGENT, unitId: 4 }), waiter(), 3500);
        assert.equal(/** @type {any} */ (q.next(4000)).unitId, 4);
        assert.equal(/** @type {any} */ (q.next(4000)).unitId, 1, 'aged poll beats CONTROL');
        assert.equal(/** @type {any} */ (q.next(4000)).unitId, 3);
    });

    it('coalesces waiters onto one item and raises it to the most urgent level', () => {
        const q = new PriorityQueue();
        const a = waiter();
        const b = waiter();
        q.push(spec({ priority: Priority.CONTROL, unitId: 9 }), waiter(), 0);
        const item = q.push(spec({ priority: Priority.POLL, coalesceKey: 'live' }), a, 0);
        const same = q.push(spec({ priority: Priority.URGENT, coalesceKey: 'live' }), b, 0);
        assert.equal(same, item);
        assert.equal(q.size, 2);
        const first = /** @type {any} */ (q.next(0));
        assert.equal(first, item);
        assert.equal(first.waiters.length, 2);
        assert.deepEqual(q.indexSizes(), { coalesce: 0, replace: 0 });
    });

    it('keeps a deadline per coalesced waiter', () => {
        const q = new PriorityQueue();
        const early = waiter(null, 100);
        const late = waiter(null, 1000);
        q.push(spec({ coalesceKey: 'k' }), early, 0);
        q.push(spec({ coalesceKey: 'k' }), late, 0);
        const item = /** @type {any} */ (q.next(500));
        assert.equal(early.error.code, 'EQUEUETIMEOUT');
        assert.deepEqual(item.waiters, [late]);
    });

    it('latest-wins: replacing a queued item resolves the old waiter as superseded', () => {
        const q = new PriorityQueue();
        const first = waiter();
        const second = waiter();
        const item = q.push(spec({ replaceKey: 'sp', request: /** @type {any} */ ({ value: 1 }) }), first, 0);
        const again = q.push(spec({ replaceKey: 'sp', request: /** @type {any} */ ({ value: 2 }) }), second, 0);
        assert.equal(again, item);
        assert.deepEqual(first.result, { superseded: true });
        assert.equal(/** @type {any} */ (item.request).value, 2);
        assert.equal(q.stats.superseded, 1);
        assert.equal(q.size, 1);
    });

    it('never hands out an expired request and sweeps expired waiters', () => {
        const q = new PriorityQueue();
        const w = waiter(null, 100);
        q.push(spec(), w, 0);
        assert.equal(q.next(100), null);
        assert.equal(w.error.code, 'EQUEUETIMEOUT');
        const w2 = waiter(null, 50);
        q.push(spec(), w2, 0);
        q.sweep(60);
        assert.equal(w2.error.code, 'EQUEUETIMEOUT');
        assert.equal(q.size, 0);
        assert.equal(q.stats.expired, 2);
    });

    it('on overflow evicts the oldest POLL, then refuses; URGENT and lane jobs are exempt', () => {
        const q = new PriorityQueue({ maxDepth: 2 });
        const p1 = waiter();
        q.push(spec({ priority: Priority.POLL }), p1, 0);
        q.push(spec({ priority: Priority.CONTROL }), waiter(), 0);
        q.push(spec({ priority: Priority.CONTROL }), waiter(), 0);
        assert.equal(p1.error.code, 'EQUEUEFULL');
        assert.equal(q.stats.evicted, 1);
        assert.throws(() => q.push(spec({ priority: Priority.CONTROL }), waiter(), 0), (e) => /** @type {any} */ (e).code === 'EQUEUEFULL');
        q.push(spec({ priority: Priority.URGENT }), waiter(), 0);
        q.push(spec({ priority: Priority.CONTROL, laneJob: true }), waiter(), 0);
        assert.equal(q.size, 4);
    });

    it('cancels by owner and by waiter, dropping empty items', () => {
        const q = new PriorityQueue();
        const mine = Symbol('mine');
        const a = waiter(mine);
        const b = waiter('other');
        q.push(spec({ coalesceKey: 'k' }), a, 0);
        q.push(spec({ coalesceKey: 'k' }), b, 0);
        q.push(spec(), waiter(mine), 0);
        assert.equal(q.cancelOwner(mine, new Error('gone')), 2);
        assert.equal(a.error.message, 'gone');
        assert.equal(q.size, 1);
        assert.equal(q.cancelWaiter(b, new Error('x')), true);
        assert.equal(q.cancelWaiter(b, new Error('x')), false);
        assert.equal(q.size, 0);
    });

    it('rejectWhere removes matching items', () => {
        const q = new PriorityQueue();
        const poll = waiter();
        const control = waiter();
        q.push(spec({ priority: Priority.POLL }), poll, 0);
        q.push(spec({ priority: Priority.CONTROL }), control, 0);
        assert.equal(q.rejectWhere((it) => it.priority === Priority.POLL, new Error('offline')), 1);
        assert.equal(poll.error.message, 'offline');
        assert.equal(control.error, undefined);
        assert.deepEqual(q.depths(), [0, 1, 0]);
    });

    it('settle() settles once and runs cleanup', () => {
        let cleaned = 0;
        const w = waiter();
        w.cleanup = () => cleaned++;
        const reply = { fc: /** @type {const} */ (4), registers: [1], rttMs: 3 };
        assert.equal(settle(w, null, reply), true);
        assert.equal(settle(w, new Error('late')), false);
        assert.equal(w.result, reply);
        assert.equal(cleaned, 1);
    });
});
