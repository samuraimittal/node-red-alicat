'use strict';

const { AlicatError } = require('./errors');

/**
 * URGENT: valve hold/close/exhaust/resume.
 * CONTROL: setpoint jobs, commands, PID, identification.
 * POLL: interval polls, on-demand reads, heartbeat, metadata, editor probe.
 */
const Priority = Object.freeze({ URGENT: 0, CONTROL: 1, POLL: 2 });

/**
 * @typedef {import('./modbus/ModbusTcpTransport').TimedResponse | {superseded: true}} Settlement
 *   What a request resolves with: the reply, or `superseded` when a newer
 *   request with the same replaceKey took its place before it was sent.
 * @typedef {{
 *   resolve: (value: Settlement) => void,
 *   reject: (err: Error) => void,
 *   owner: unknown,
 *   deadline: number,
 *   done?: boolean,
 *   cleanup?: () => void,
 *   item?: QueueItem
 * }} Waiter
 *
 * @typedef {{
 *   unitId: number,
 *   request: import('./modbus/pdu').Request,
 *   priority: 0 | 1 | 2,
 *   coalesceKey?: string | undefined,
 *   replaceKey?: string | undefined,
 *   timeoutMs: number,
 *   idempotent: boolean,
 *   retries: number,
 *   laneJob: boolean
 * }} RequestSpec
 *
 * @typedef {RequestSpec & {id: number, waiters: Waiter[], enqueuedAt: number, state: 'queued' | 'inflight' | 'done'}} QueueItem
 */

/**
 * @overload
 * @param {Waiter} waiter
 * @param {Error} error
 * @returns {boolean}
 */
/**
 * @overload
 * @param {Waiter} waiter
 * @param {null} error
 * @param {Settlement} value
 * @returns {boolean}
 */
/**
 * Settle a waiter exactly once: reject it with `error`, or resolve it with `value`.
 * @param {Waiter} waiter
 * @param {Error | null} error
 * @param {Settlement} [value]
 * @returns {boolean} false if it was already settled
 */
function settle(waiter, error, value) {
    if (waiter.done) {
        return false;
    }
    waiter.done = true;
    if (waiter.cleanup) {
        waiter.cleanup();
    }
    if (error) {
        waiter.reject(error);
    } else {
        waiter.resolve(/** @type {Settlement} */ (value));
    }
    return true;
}

/**
 * Three-level FIFO queue for one socket.
 * - Coalescing: idempotent reads with the same key share one wire request.
 *   The shared item is raised to its most urgent waiter's level, and each
 *   waiter keeps its own deadline.
 * - Latest-wins: a queued item with the same replaceKey has its request swapped,
 *   and the superseded waiters resolve `{superseded: true}`.
 * - Deadlines: expired waiters are rejected and never sent late.
 * - Overflow: the oldest POLL is evicted; URGENT items and lane-job steps are
 *   never refused or evicted.
 * - Aging: a POLL item waiting longer than `agingMs` is served before CONTROL.
 */
class PriorityQueue {
    /** @param {{maxDepth?: number, agingMs?: number}} [options] */
    constructor(options = {}) {
        this.maxDepth = options.maxDepth ?? 200;
        this.agingMs = options.agingMs ?? 3000;
        /** @type {[QueueItem[], QueueItem[], QueueItem[]]} */
        this._levels = [[], [], []];
        /** @type {Map<string, QueueItem>} */
        this._byCoalesce = new Map();
        /** @type {Map<string, QueueItem>} */
        this._byReplace = new Map();
        this._seq = 0;
        this.stats = { superseded: 0, evicted: 0, expired: 0, canceled: 0 };
    }

    get size() {
        return this._levels[0].length + this._levels[1].length + this._levels[2].length;
    }

    /** @returns {[number, number, number]} */
    depths() {
        return [this._levels[0].length, this._levels[1].length, this._levels[2].length];
    }

    /** Sizes of the internal indexes (for leak tests). */
    indexSizes() {
        return { coalesce: this._byCoalesce.size, replace: this._byReplace.size };
    }

    /**
     * @param {RequestSpec} spec
     * @param {Waiter} waiter
     * @param {number} [now]
     * @returns {QueueItem}
     */
    push(spec, waiter, now = Date.now()) {
        const shared = spec.coalesceKey ? this._byCoalesce.get(spec.coalesceKey) : undefined;
        if (shared) {
            this._join(shared, spec, waiter);
            return shared;
        }
        const replaced = spec.replaceKey ? this._byReplace.get(spec.replaceKey) : undefined;
        if (replaced) {
            this._replace(replaced, spec, waiter);
            return replaced;
        }
        if (spec.priority !== Priority.URGENT && !spec.laneJob && this.size >= this.maxDepth) {
            this._evictPoll();
        }
        /** @type {QueueItem} */
        const item = { ...spec, id: ++this._seq, waiters: [waiter], enqueuedAt: now, state: 'queued' };
        waiter.item = item;
        this._levels[item.priority].push(item);
        if (item.coalesceKey) {
            this._byCoalesce.set(item.coalesceKey, item);
        }
        if (item.replaceKey) {
            this._byReplace.set(item.replaceKey, item);
        }
        return item;
    }

    /**
     * Coalesce: an identical request shares the queued item and its reply.
     * @param {QueueItem} item @param {RequestSpec} spec @param {Waiter} waiter
     */
    _join(item, spec, waiter) {
        item.waiters.push(waiter);
        waiter.item = item;
        if (spec.priority < item.priority) {
            this._move(item, spec.priority);
        }
    }

    /**
     * Latest wins: the queued item takes the newer request, and its waiters
     * resolve `{superseded: true}`.
     * @param {QueueItem} item @param {RequestSpec} spec @param {Waiter} waiter
     */
    _replace(item, spec, waiter) {
        const superseded = item.waiters;
        item.waiters = [waiter];
        waiter.item = item;
        item.request = spec.request;
        item.unitId = spec.unitId;
        item.timeoutMs = spec.timeoutMs;
        item.idempotent = spec.idempotent;
        item.retries = spec.retries;
        if (spec.priority < item.priority) {
            this._move(item, spec.priority);
        }
        for (const w of superseded) {
            if (settle(w, null, { superseded: true })) {
                this.stats.superseded++;
            }
        }
    }

    /** Full: drop the oldest POLL (never a lane-job step), or refuse. */
    _evictPoll() {
        const victim = this._levels[Priority.POLL].find((it) => !it.laneJob);
        if (!victim) {
            throw new AlicatError('EQUEUEFULL', `Request queue is full (${this.maxDepth} requests waiting)`);
        }
        this._remove(victim);
        this.stats.evicted++;
        for (const w of victim.waiters) {
            settle(w, new AlicatError('EQUEUEFULL', 'Evicted from a full request queue'));
        }
    }

    /** Every queued item, most urgent level first (a copy: callers may remove items). */
    _all() {
        return this._levels.flatMap((level) => level.slice());
    }

    /**
     * Take the next item to send. Expired waiters are rejected; items with no
     * live waiters are skipped.
     * @param {number} [now]
     * @returns {QueueItem | null}
     */
    next(now = Date.now()) {
        for (;;) {
            const item = this._pick(now);
            if (!item) {
                return null;
            }
            this._remove(item);
            this._expireWaiters(item, now);
            if (item.waiters.length > 0) {
                item.state = 'inflight';
                return item;
            }
            item.state = 'done';
        }
    }

    /** Reject expired waiters everywhere and drop empty items. @param {number} [now] */
    sweep(now = Date.now()) {
        for (const item of this._all()) {
            this._expireWaiters(item, now);
            if (item.waiters.length === 0) {
                this._remove(item);
                item.state = 'done';
            }
        }
    }

    /**
     * Cancel one waiter. If it was the last waiter on a queued item, the item is dropped.
     * @param {Waiter} waiter
     * @param {Error} error
     */
    cancelWaiter(waiter, error) {
        if (!settle(waiter, error)) {
            return false;
        }
        this.stats.canceled++;
        const item = waiter.item;
        if (item && item.state === 'queued') {
            item.waiters = item.waiters.filter((w) => !w.done);
            if (item.waiters.length === 0) {
                this._remove(item);
                item.state = 'done';
            }
        }
        return true;
    }

    /**
     * Cancel every queued waiter belonging to `owner`.
     * @param {unknown} owner
     * @param {Error} error
     */
    cancelOwner(owner, error) {
        let count = 0;
        for (const item of this._all()) {
            for (const w of item.waiters.slice()) {
                if (w.owner === owner && this.cancelWaiter(w, error)) {
                    count++;
                }
            }
        }
        return count;
    }

    /**
     * Remove every queued item matching `predicate` and reject its waiters.
     * @param {(item: QueueItem) => boolean} predicate
     * @param {Error} error
     */
    rejectWhere(predicate, error) {
        let count = 0;
        for (const item of this._all()) {
            if (!predicate(item)) continue;
            this._remove(item);
            item.state = 'done';
            count += item.waiters.filter((w) => settle(w, error)).length;
        }
        return count;
    }

    /** @param {number} now */
    _pick(now) {
        if (this._levels[Priority.URGENT].length > 0) {
            return this._levels[Priority.URGENT][0];
        }
        const poll = this._levels[Priority.POLL][0];
        if (poll && now - poll.enqueuedAt > this.agingMs) {
            return poll;
        }
        return this._levels[Priority.CONTROL][0] || poll || null;
    }

    /** @param {QueueItem} item @param {number} now */
    _expireWaiters(item, now) {
        for (const w of item.waiters) {
            if (!w.done && w.deadline <= now) {
                if (settle(w, new AlicatError('EQUEUETIMEOUT', 'Request expired before it could be sent'))) {
                    this.stats.expired++;
                }
            }
        }
        item.waiters = item.waiters.filter((w) => !w.done);
    }

    /** @param {QueueItem} item @param {0 | 1 | 2} priority */
    _move(item, priority) {
        const level = this._levels[item.priority];
        const index = level.indexOf(item);
        if (index >= 0) {
            level.splice(index, 1);
        }
        item.priority = priority;
        this._levels[priority].push(item);
    }

    /** @param {QueueItem} item */
    _remove(item) {
        const level = this._levels[item.priority];
        const index = level.indexOf(item);
        if (index >= 0) {
            level.splice(index, 1);
        }
        if (item.coalesceKey && this._byCoalesce.get(item.coalesceKey) === item) {
            this._byCoalesce.delete(item.coalesceKey);
        }
        if (item.replaceKey && this._byReplace.get(item.replaceKey) === item) {
            this._byReplace.delete(item.replaceKey);
        }
    }
}

module.exports = { PriorityQueue, Priority, settle };
