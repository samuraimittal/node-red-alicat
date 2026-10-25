'use strict';

const { EventEmitter } = require('events');
const { AlicatError } = require('../../lib/errors');

/**
 * In-memory stand-in for ModbusTcpTransport, scripted by a FakeDevice. Works
 * with sinon fake timers: every delay goes through setTimeout/setImmediate.
 */
class FakeTransport extends EventEmitter {
    /** @param {FakeDevice} device @param {any} options */
    constructor(device, options) {
        super();
        this.device = device;
        this.options = options;
        this.state = 'new';
        this.lastRxAt = 0;
        this.stats = { sent: 0 };
        /** @type {Set<{reject: (e: Error) => void, timer: any}>} */
        this.pending = new Set();
        /** @type {((e: Error) => void) | null} */
        this._connectReject = null;
        /** @type {() => void} */
        this._resolveClosed = () => {};
        this.closed = new Promise((resolve) => { this._resolveClosed = () => resolve(undefined); });
    }

    get isOpen() {
        return this.state === 'open';
    }

    connect() {
        this.state = 'connecting';
        return new Promise((resolve, reject) => {
            this._connectReject = reject;
            const behaviour = this.device.connectBehaviour;
            if (behaviour === 'hang') {
                return;
            }
            setTimeout(() => {
                if (this.state !== 'connecting') return;
                this._connectReject = null;
                if (behaviour === 'refuse') {
                    this.state = 'down';
                    this._resolveClosed();
                    reject(new AlicatError('ECONNECT', 'refused', {
                        cause: Object.assign(new Error('connect ECONNREFUSED'), { code: this.device.refuseCode })
                    }));
                } else {
                    this.state = 'open';
                    resolve(undefined);
                }
            }, this.device.connectDelayMs);
        });
    }

    /** @param {number} unitId @param {any} request @param {number} timeoutMs */
    send(unitId, request, timeoutMs) {
        if (this.state !== 'open') {
            return Promise.reject(new AlicatError('ENOTCONNECTED', 'not open'));
        }
        this.stats.sent++;
        this.device.log.push({ unitId, request, at: Date.now() });
        return new Promise((resolve, reject) => {
            const entry = { reject, timer: /** @type {any} */ (null) };
            this.pending.add(entry);
            let outcome;
            try {
                outcome = this.device.handler(unitId, request, this);
            } catch (err) {
                outcome = { error: err };
            }
            if (outcome === 'silent') {
                entry.timer = setTimeout(() => {
                    this.pending.delete(entry);
                    reject(new AlicatError('ETIMEDOUT', 'timeout'));
                }, timeoutMs);
                return;
            }
            entry.timer = setTimeout(() => {
                this.pending.delete(entry);
                if (this.state !== 'open') return;
                this.lastRxAt = Date.now();
                if (outcome && outcome.error) {
                    reject(outcome.error);
                } else {
                    resolve({ ...outcome, rttMs: this.device.latencyMs });
                }
            }, Math.min(this.device.latencyMs, timeoutMs));
        });
    }

    /** @param {Error} [error] */
    destroy(error) {
        if (this.state === 'down') return;
        const wasOpen = this.state === 'open';
        this.state = 'down';
        const err = error || new AlicatError('ECANCELED', 'destroyed');
        for (const p of this.pending) {
            clearTimeout(p.timer);
            p.reject(err);
        }
        this.pending.clear();
        if (this._connectReject) {
            const r = this._connectReject;
            this._connectReject = null;
            r(err);
        }
        this._resolveClosed();
        if (wasOpen) this.emit('down', err);
    }

    close() {
        this.destroy(new AlicatError('ECANCELED', 'closed by client'));
        return this.closed;
    }

    /** Simulate the peer dropping the connection. */
    drop() {
        this.destroy(new AlicatError('ELINKDOWN', 'peer closed'));
    }
}

/** Scripted device behind any number of FakeTransports (one per connection attempt). */
class FakeDevice {
    constructor() {
        /** @type {'ok' | 'refuse' | 'hang'} */
        this.connectBehaviour = 'ok';
        this.refuseCode = 'ECONNREFUSED';
        this.connectDelayMs = 1;
        this.latencyMs = 5;
        /** @type {(unitId: number, request: any, t: FakeTransport) => any} */
        this.handler = (_unit, request) => (request.fc === 4
            ? { fc: 4, registers: new Array(request.quantity).fill(0) }
            : { fc: 16, address: request.address, quantity: request.quantity });
        /** @type {FakeTransport[]} */
        this.transports = [];
        /** @type {{unitId: number, request: any, at: number}[]} */
        this.log = [];
        this.factory = (/** @type {any} */ options) => {
            const t = new FakeTransport(this, options);
            this.transports.push(t);
            return /** @type {any} */ (t);
        };
    }

    get current() {
        return this.transports[this.transports.length - 1];
    }
}

module.exports = { FakeTransport, FakeDevice };
