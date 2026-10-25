'use strict';

const net = require('net');
const { EventEmitter } = require('events');
const { AlicatError } = require('../errors');
const { encodeFrame, decodeResponse, matchesFunction, FrameParser } = require('./pdu');
const { unref } = require('../util/timers');

/**
 * @typedef {import('./pdu').Request} Request
 * @typedef {import('./pdu').ReadResponse & {rttMs: number}} TimedRead
 * @typedef {import('./pdu').WriteResponse & {rttMs: number}} TimedWrite
 * @typedef {TimedRead | TimedWrite} TimedResponse
 *   A response with its round-trip time.
 * @typedef {'new' | 'connecting' | 'open' | 'closing' | 'down'} TransportState
 * @typedef {{
 *   host: string,
 *   port: number,
 *   connectTimeoutMs?: number,
 *   keepAliveMs?: number,
 *   lateReplyGraceMs?: number,
 *   firstTxnId?: number,
 *   createConnection?: (options: {host: string, port: number}) => net.Socket,
 *   trace?: ((direction: 'tx' | 'rx', data: Buffer) => void) | null
 * }} TransportOptions
 * @typedef {{
 *   request: Request,
 *   unitId: number,
 *   resolve: (response: TimedResponse) => void,
 *   reject: (err: Error) => void,
 *   timer: NodeJS.Timeout,
 *   sentAt: number
 * }} Pending
 */

const DEFAULTS = Object.freeze({
    connectTimeoutMs: 5000,
    keepAliveMs: 10000,
    lateReplyGraceMs: 250
});

// Bound on remembered timed-out transaction IDs (used to recognise late replies).
const MAX_TIMED_OUT = 32;

function noop() {}

/**
 * One TCP connection to one Modbus TCP server. Single-use: once it goes down it
 * stays down, and the owner creates a new transport for the next attempt. That
 * makes every socket event unambiguous — a late 'close' from an old socket can
 * never touch a newer connection.
 *
 * Responses are matched on 16-bit transaction ID plus function code. A reply
 * that arrives after its request timed out is recognised and discarded, and the
 * next send waits up to `lateReplyGraceMs` for it so a slow device is not
 * mistaken for a dead one.
 *
 * Events: 'down' (error) once, if the connection had been open; 'warning' (message).
 * @extends {EventEmitter<{down: [error: Error], warning: [message: string]}>}
 */
class ModbusTcpTransport extends EventEmitter {
    /** @param {TransportOptions} options */
    constructor(options) {
        super();
        this.host = options.host;
        this.port = options.port;
        this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULTS.connectTimeoutMs;
        this.keepAliveMs = options.keepAliveMs ?? DEFAULTS.keepAliveMs;
        this.lateReplyGraceMs = options.lateReplyGraceMs ?? DEFAULTS.lateReplyGraceMs;
        this._createConnection = options.createConnection || net.createConnection;
        this._trace = options.trace || null;

        /** @type {TransportState} */
        this._state = 'new';
        /** @type {net.Socket | null} */
        this._sock = null;
        this._parser = new FrameParser();
        /** @type {Map<number, Pending>} */
        this._pending = new Map();
        /** @type {Map<number, number>} txnId → function code */
        this._timedOut = new Map();
        this._nextTxnId = options.firstTxnId ?? 1;
        this._lateUntil = 0;
        /** @type {{promise: Promise<void>, resolve: () => void, timer: NodeJS.Timeout} | null} */
        this._graceWaiter = null;
        /** @type {Error | null} */
        this._downError = null;
        /** @type {((err: Error) => void) | null} */
        this._connectReject = null;
        /** @type {NodeJS.Timeout | undefined} */
        this._connectTimer = undefined;
        /** @type {NodeJS.Timeout | undefined} */
        this._closeTimer = undefined;
        this._warnedUnitMismatch = false;

        this.lastRxAt = 0;
        this.stats = { sent: 0, received: 0, timeouts: 0, late: 0, stale: 0, mismatched: 0, exceptions: 0 };

        /** @type {() => void} */
        this._resolveClosed = noop;
        /** Resolves once the underlying socket is fully closed. */
        /** @type {Promise<void>} */
        this.closed = new Promise((resolve) => { this._resolveClosed = () => resolve(); });
    }

    get state() {
        return this._state;
    }

    get isOpen() {
        return this._state === 'open';
    }

    get pendingCount() {
        return this._pending.size;
    }

    /** @returns {Promise<void>} */
    connect() {
        if (this._state !== 'new') {
            return Promise.reject(new AlicatError('ECLOSED', 'A transport can only connect once'));
        }
        this._state = 'connecting';
        return new Promise((resolve, reject) => {
            this._connectReject = reject;
            /** @type {net.Socket} */
            let sock;
            try {
                sock = this._createConnection({ host: this.host, port: this.port });
            } catch (err) {
                this._state = 'down';
                this._connectReject = null;
                this._resolveClosed();
                reject(this._connectError(err));
                return;
            }
            this._sock = sock;
            this._connectTimer = unref(setTimeout(() => {
                const cause = Object.assign(new Error(`connect ETIMEDOUT ${this.host}:${this.port}`), { code: 'ETIMEDOUT' });
                this._down(sock, cause);
            }, this.connectTimeoutMs));

            sock.on('error', (err) => this._down(sock, err));
            sock.on('end', () => this._down(sock, null));
            sock.on('close', () => this._down(sock, null));
            sock.once('close', () => this._resolveClosed());
            sock.on('data', (chunk) => this._onData(sock, chunk));
            sock.once('connect', () => {
                if (sock !== this._sock || this._state !== 'connecting') {
                    return;
                }
                clearTimeout(this._connectTimer);
                this._connectReject = null;
                this._state = 'open';
                sock.setNoDelay(true);
                sock.setKeepAlive(true, this.keepAliveMs);
                resolve();
            });
        });
    }

    /**
     * @overload
     * @param {number} unitId
     * @param {import('./pdu').ReadRequest} request
     * @param {number} timeoutMs
     * @returns {Promise<TimedRead>}
     */
    /**
     * @overload
     * @param {number} unitId
     * @param {import('./pdu').WriteRequest} request
     * @param {number} timeoutMs
     * @returns {Promise<TimedWrite>}
     */
    /**
     * @overload
     * @param {number} unitId
     * @param {Request} request
     * @param {number} timeoutMs
     * @returns {Promise<TimedResponse>}
     */
    /**
     * Send one request and resolve with its decoded response (decoded against
     * that very request, so a read gets a read response).
     * @param {number} unitId
     * @param {Request} request
     * @param {number} timeoutMs
     * @returns {Promise<TimedResponse>}
     */
    async send(unitId, request, timeoutMs) {
        if (this._state !== 'open') {
            throw this._notOpenError();
        }
        await this._waitForLateReply();
        if (this._state !== 'open' || !this._sock) {
            throw this._notOpenError();
        }
        const sock = this._sock;
        const txnId = this._allocateTxnId();
        const frame = encodeFrame(txnId, unitId, request.pdu);
        return new Promise((resolve, reject) => {
            const timer = unref(setTimeout(() => this._onTimeout(txnId, timeoutMs), timeoutMs));
            this._pending.set(txnId, { request, unitId, resolve, reject, timer, sentAt: Date.now() });
            this.stats.sent++;
            if (this._trace) {
                this._trace('tx', frame);
            }
            sock.write(frame);
        });
    }

    /**
     * Graceful close: FIN when idle, then destroy after `graceMs`. With requests
     * in flight the socket is destroyed immediately.
     * @param {number} [graceMs]
     * @returns {Promise<void>}
     */
    close(graceMs = 250) {
        const sock = this._sock;
        if (this._state !== 'open' || !sock || this._pending.size > 0) {
            this.destroy();
            return this.closed;
        }
        this._state = 'closing';
        this._downError = new AlicatError('ECANCELED', 'Connection closed by client');
        this._releaseGrace();
        sock.end();
        this._closeTimer = unref(setTimeout(() => this._down(sock, null), graceMs));
        return this.closed;
    }

    /**
     * Immediate teardown. Idempotent. Pending requests reject with `error`
     * (default ECANCELED).
     * @param {Error} [error]
     */
    destroy(error) {
        if (this._state === 'down') {
            return;
        }
        if (this._state === 'new' || !this._sock) {
            this._state = 'down';
            this._resolveClosed();
            return;
        }
        this._downError = error || this._downError || new AlicatError('ECANCELED', 'Connection closed by client');
        this._down(this._sock, null);
    }

    /**
     * The single, idempotent down path for every socket event.
     * @param {net.Socket} sock
     * @param {Error | null} cause
     */
    _down(sock, cause) {
        if (sock !== this._sock || this._state === 'down') {
            return;
        }
        const wasConnecting = this._state === 'connecting';
        this._state = 'down';
        clearTimeout(this._connectTimer);
        clearTimeout(this._closeTimer);

        /** @type {Error} */
        let error;
        if (this._downError) {
            error = this._downError;
        } else if (wasConnecting) {
            error = this._connectError(cause);
        } else {
            error = new AlicatError('ELINKDOWN', `Connection to ${this.host}:${this.port} lost`,
                cause ? { cause } : {});
        }
        this._downError = error;

        for (const pending of this._pending.values()) {
            clearTimeout(pending.timer);
            pending.reject(error);
        }
        this._pending.clear();
        this._timedOut.clear();
        this._releaseGrace();

        // Keep an 'error' listener on the retired socket: an unhandled 'error'
        // would crash the Node-RED process. The listeners above become no-ops.
        sock.on('error', noop);
        sock.destroy();

        if (this._connectReject) {
            const reject = this._connectReject;
            this._connectReject = null;
            reject(error);
        } else if (!wasConnecting) {
            this.emit('down', error);
        }
    }

    /**
     * @param {net.Socket} sock
     * @param {Buffer} chunk
     */
    _onData(sock, chunk) {
        if (sock !== this._sock || (this._state !== 'open' && this._state !== 'closing')) {
            return;
        }
        this.lastRxAt = Date.now();
        if (this._trace) {
            this._trace('rx', chunk);
        }
        let frames;
        try {
            frames = this._parser.push(chunk);
        } catch (err) {
            this._downError = /** @type {Error} */ (err);
            this._down(sock, /** @type {Error} */ (err));
            return;
        }
        for (const frame of frames) {
            this._onFrame(frame);
        }
    }

    /** @param {import('./pdu').Frame} frame */
    _onFrame(frame) {
        const pending = this._pending.get(frame.txnId);
        if (pending && matchesFunction(pending.request.fc, frame.pdu)) {
            this._pending.delete(frame.txnId);
            clearTimeout(pending.timer);
            this.stats.received++;
            if (frame.unitId !== pending.unitId) {
                this._warnUnitMismatch(frame.unitId, pending.unitId);
            }
            let response;
            try {
                response = decodeResponse(pending.request, frame.pdu);
            } catch (err) {
                if (/** @type {{code?: string}} */ (err).code === 'EMODBUS') {
                    this.stats.exceptions++;
                }
                pending.reject(/** @type {Error} */ (err));
                return;
            }
            pending.resolve({ ...response, rttMs: Date.now() - pending.sentAt });
            return;
        }
        if (pending) {
            this.stats.mismatched++;
            return;
        }
        if (this._timedOut.has(frame.txnId)) {
            this._timedOut.delete(frame.txnId);
            this.stats.late++;
            if (this._timedOut.size === 0) {
                this._releaseGrace();
            }
            return;
        }
        this.stats.stale++;
    }

    /**
     * @param {number} txnId
     * @param {number} timeoutMs
     */
    _onTimeout(txnId, timeoutMs) {
        const pending = this._pending.get(txnId);
        if (!pending) {
            return;
        }
        this._pending.delete(txnId);
        this.stats.timeouts++;
        this._timedOut.set(txnId, pending.request.fc);
        if (this._timedOut.size > MAX_TIMED_OUT) {
            const oldest = this._timedOut.keys().next().value;
            this._timedOut.delete(/** @type {number} */ (oldest));
        }
        this._lateUntil = Date.now() + this.lateReplyGraceMs;
        pending.reject(new AlicatError('ETIMEDOUT', `No response from ${this.host}:${this.port} within ${timeoutMs} ms`, {
            txnId,
            fc: pending.request.fc,
            address: pending.request.address
        }));
    }

    /** @returns {Promise<void>} */
    _waitForLateReply() {
        const remaining = this._lateUntil - Date.now();
        if (remaining <= 0 || this._timedOut.size === 0) {
            return Promise.resolve();
        }
        if (!this._graceWaiter) {
            /** @type {() => void} */
            let resolve = noop;
            const promise = new Promise((r) => { resolve = /** @type {() => void} */ (r); });
            const timer = unref(setTimeout(() => this._releaseGrace(), remaining));
            this._graceWaiter = { promise, resolve, timer };
        }
        return this._graceWaiter.promise;
    }

    _releaseGrace() {
        this._lateUntil = 0;
        const waiter = this._graceWaiter;
        if (!waiter) {
            return;
        }
        this._graceWaiter = null;
        clearTimeout(waiter.timer);
        waiter.resolve();
    }

    _allocateTxnId() {
        for (let i = 0; i < 0x10000; i++) {
            const id = this._nextTxnId;
            this._nextTxnId = id >= 0xFFFF ? 1 : id + 1;
            if (!this._pending.has(id) && !this._timedOut.has(id)) {
                return id;
            }
        }
        throw new AlicatError('EQUEUEFULL', 'No free Modbus transaction IDs');
    }

    /**
     * @param {number} got
     * @param {number} expected
     */
    _warnUnitMismatch(got, expected) {
        if (this._warnedUnitMismatch) {
            return;
        }
        this._warnedUnitMismatch = true;
        this.emit('warning', `${this.host}:${this.port} answered with unit ID ${got} to a request for unit ID ${expected}`);
    }

    _notOpenError() {
        if (this._downError) {
            return this._downError instanceof AlicatError && this._downError.code === 'ECANCELED'
                ? new AlicatError('ECLOSED', 'Connection was closed by the client')
                : new AlicatError('ELINKDOWN', `Connection to ${this.host}:${this.port} is down`, { cause: this._downError });
        }
        return new AlicatError('ENOTCONNECTED', `Not connected to ${this.host}:${this.port}`);
    }

    /** @param {unknown} cause */
    _connectError(cause) {
        const osCode = cause && /** @type {{code?: string}} */ (cause).code;
        return new AlicatError('ECONNECT',
            `Could not connect to ${this.host}:${this.port}${osCode ? ` (${osCode})` : ''}`,
            cause ? { cause } : {});
    }
}

module.exports = { ModbusTcpTransport, DEFAULTS };
