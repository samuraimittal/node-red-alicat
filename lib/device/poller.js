'use strict';

const { Priority } = require('../PriorityQueue');
const { unref } = require('../util/timers');
const { degradedSnapshot } = require('./live');

/**
 * @typedef {import('./types').Snapshot} Snapshot
 * @typedef {{intervalMs: number, cb: (s: Snapshot) => void, last: number}} Subscriber
 */

/** A subscriber is due when 90 % of its interval has passed, so jitter never skips a cycle. */
const DUE_FRACTION = 0.9;

/**
 * One poll loop at the fastest interval any subscriber asks for, shared by
 * every subscriber (N read nodes = 1 wire read per cycle). When reads fail,
 * subscribers get the last good snapshot once, marked stale or offline.
 */
class LivePoller {
    /**
     * @param {{
     *   read: (opts: {priority: 0 | 1 | 2, owner: unknown}) => Promise<Snapshot>,
     *   isOnline: () => boolean,
     *   minIntervalMs: () => number,
     *   warn: (message: string) => void
     * }} source
     */
    constructor(source) {
        this._source = source;
        /** @type {Map<unknown, Subscriber>} */
        this._subscribers = new Map();
        /** @type {Snapshot | null} */
        this._last = null;
        /** @type {'good' | 'stale' | 'offline'} */
        this._quality = 'good';
        /** @type {NodeJS.Timeout | null} */
        this._timer = null;
        this._polling = false;
        this._closed = false;
    }

    get size() {
        return this._subscribers.size;
    }

    /** The last snapshot a poll delivered (null before the first). */
    get lastSnapshot() {
        return this._last;
    }

    /**
     * @param {unknown} owner
     * @param {number | undefined} intervalMs default 1 s; at least minIntervalMs
     * @param {(snapshot: Snapshot) => void} callback
     * @returns {() => void} unsubscribe
     */
    subscribe(owner, intervalMs, callback) {
        const interval = Math.max(this._source.minIntervalMs(), intervalMs ?? 1000);
        this._subscribers.set(owner, { intervalMs: interval, cb: callback, last: 0 });
        this._schedule(0);
        return () => this.remove(owner);
    }

    /** @param {unknown} owner */
    remove(owner) {
        this._subscribers.delete(owner);
        if (this._subscribers.size === 0) this._clearTimer();
    }

    /**
     * Tell subscribers once that data is stale or offline (values are the last good ones).
     * @param {'stale' | 'offline'} quality
     * @param {Error | null} [error]
     */
    deliverQuality(quality, error) {
        if (this._quality === quality || !this._last) {
            this._quality = quality;
            return;
        }
        this._quality = quality;
        this._deliver(degradedSnapshot(this._last, quality, error), true);
    }

    close() {
        this._closed = true;
        this._subscribers.clear();
        this._clearTimer();
    }

    /** @param {number} delay */
    _schedule(delay) {
        if (this._timer || this._polling || this._closed || this._subscribers.size === 0) return;
        this._timer = unref(setTimeout(() => {
            this._timer = null;
            this._pollOnce();
        }, delay));
    }

    async _pollOnce() {
        if (this._subscribers.size === 0) return;
        this._polling = true;
        const started = Date.now();
        const interval = Math.min(...[...this._subscribers.values()].map((s) => s.intervalMs));
        try {
            const snapshot = await this._source.read({ priority: Priority.POLL, owner: this });
            this._last = snapshot;
            this._quality = 'good';
            this._deliver(snapshot, false);
        } catch (err) {
            this.deliverQuality(this._source.isOnline() ? 'stale' : 'offline', /** @type {Error} */ (err));
        } finally {
            this._polling = false;
            this._schedule(Math.max(0, interval - (Date.now() - started)));
        }
    }

    /** @param {Snapshot} snapshot @param {boolean} force deliver to every subscriber, due or not */
    _deliver(snapshot, force) {
        const now = Date.now();
        for (const sub of this._subscribers.values()) {
            if (force || now - sub.last >= sub.intervalMs * DUE_FRACTION) {
                sub.last = now;
                try {
                    sub.cb(snapshot);
                } catch (err) {
                    this._source.warn(`Subscriber callback threw: ${/** @type {Error} */ (err).message}`);
                }
            }
        }
    }

    _clearTimer() {
        if (this._timer) clearTimeout(this._timer);
        this._timer = null;
    }
}

module.exports = { LivePoller };
