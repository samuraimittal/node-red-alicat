'use strict';

const dns = require('dns');
const net = require('net');
const { EventEmitter } = require('events');
const { AlicatError, codeOf, errorSummary, isModbusException } = require('./errors');
const { ModbusTcpTransport } = require('./modbus/ModbusTcpTransport');
const pdu = require('./modbus/pdu');
const { SERVER_DEVICE_BUSY } = require('./modbus/exceptions');
const { REG, toAddress } = require('./alicat/registers');
const { Backoff } = require('./Backoff');
const { PriorityQueue, Priority, settle } = require('./PriorityQueue');
const { withDefaults } = require('./util/defaults');
const { unref, sleep } = require('./util/timers');

/**
 * @typedef {'IDLE' | 'CONNECTING' | 'ONLINE' | 'BACKOFF' | 'CLOSING' | 'CLOSED'} ClientState
 * @typedef {'START' | 'CONNECTED' | 'CONNECT_FAILED' | 'DOWN' | 'LINK_SUSPECT' | 'RECONNECT' | 'RETRY' | 'STOP' | 'CLOSED'} ClientEvent
 * @typedef {{state: ClientState, prev: ClientState, event: ClientEvent, error: Error | null,
 *            attempt: number, nextRetryInMs: number | null}} StateChange
 * @typedef {{state: [change: StateChange], log: [entry: {level: 'info' | 'warn', message: string}],
 *            warning: [message: string], stable: []}} ClientEvents
 * @typedef {{
 *   priority?: 0 | 1 | 2,
 *   owner?: unknown,
 *   coalesceKey?: string,
 *   replaceKey?: string,
 *   timeoutMs?: number,
 *   deadlineMs?: number,
 *   idempotent?: boolean,
 *   retries?: number,
 *   laneJob?: boolean,
 *   signal?: AbortSignal
 * }} RequestOptions
 *   `owner`: cancelByOwner(owner) cancels it. `coalesceKey`: identical reads share
 *   one reply. `replaceKey`: a newer request replaces one not yet sent, which
 *   then resolves `{superseded: true}`.
 * @typedef {RequestOptions & {replaceKey?: never}} ReadOptions A read is never replaced.
 * @typedef {import('./modbus/ModbusTcpTransport').TimedResponse} TimedResponse
 * @typedef {import('./modbus/ModbusTcpTransport').TimedRead} TimedRead
 * @typedef {import('./PriorityQueue').Settlement} Settlement
 * @typedef {import('./PriorityQueue').QueueItem} QueueItem
 * @typedef {import('./PriorityQueue').Waiter} Waiter
 * @typedef {InstanceType<typeof ModbusTcpTransport>} Transport
 * @typedef {{
 *   connectTimeoutMs: number, requestTimeoutMs: number, interFrameDelayMs: number,
 *   maxQueueDepth: number, queueDeadlineMs: number, agingMs: number, stableMs: number,
 *   linkSuspectTimeouts: number, heartbeatMs: number, heartbeatUnitId: number, heartbeatRegister: number,
 *   lateReplyGraceMs: number, keepAliveMs: number, failFastWhenOffline: boolean, retries: number,
 *   logThrottleMs: number, closeGraceMs: number, backoffInitialMs: number, backoffMaxMs: number, backoffFactor: number
 * }} ClientSettings
 *   Tunable settings, all resolved: DEFAULTS has the values, LIMITS the allowed ranges.
 * @typedef {(direction: 'tx' | 'rx', data: Buffer) => void} TraceFn
 * @typedef {{[K in keyof ClientSettings]?: ClientSettings[K] | undefined} & {trace?: TraceFn | null | undefined}} ClientSettingsUpdate
 *   What `configure()` accepts; every value is range-checked at run time.
 * @typedef {ClientSettingsUpdate & {
 *   host: string, port?: number | undefined, strict?: boolean | undefined, random?: (() => number) | undefined,
 *   createTransport?: ((options: import('./modbus/ModbusTcpTransport').TransportOptions) => Transport) | undefined,
 *   lookup?: ((host: string) => Promise<string>) | undefined,
 *   claimAddress?: ((address: string, port: number) => boolean) | undefined
 * }} ClientOptions
 */

const STATES = Object.freeze({
    IDLE: 'IDLE',
    CONNECTING: 'CONNECTING',
    ONLINE: 'ONLINE',
    BACKOFF: 'BACKOFF',
    CLOSING: 'CLOSING',
    CLOSED: 'CLOSED'
});

/** @type {Readonly<Record<ClientState, Partial<Record<ClientEvent, ClientState>>>>} */
const TRANSITIONS = Object.freeze({
    IDLE: { START: 'CONNECTING', STOP: 'CLOSED' },
    CONNECTING: { CONNECTED: 'ONLINE', CONNECT_FAILED: 'BACKOFF', STOP: 'CLOSING' },
    ONLINE: { DOWN: 'BACKOFF', LINK_SUSPECT: 'BACKOFF', RECONNECT: 'BACKOFF', STOP: 'CLOSING' },
    BACKOFF: { RETRY: 'CONNECTING', STOP: 'CLOSING' },
    CLOSING: { CLOSED: 'CLOSED' },
    CLOSED: {}
});

const MAX_LISTENERS = 100;

/** @type {Readonly<ClientSettings>} */
const DEFAULTS = Object.freeze({
    connectTimeoutMs: 5000,
    requestTimeoutMs: 1000,
    interFrameDelayMs: 20, // ≈ 50 Hz, the documented Modbus TCP rate
    maxQueueDepth: 200,
    queueDeadlineMs: 10000,
    agingMs: 3000,
    stableMs: 10000,
    linkSuspectTimeouts: 3,
    heartbeatMs: 5000, // the device drops connections idle for ~20 s (Gate 0)
    heartbeatUnitId: 1,
    heartbeatRegister: REG.OPT_GAS, // defined on both generations
    lateReplyGraceMs: 250,
    keepAliveMs: 10000,
    failFastWhenOffline: true,
    retries: 2,
    logThrottleMs: 60000,
    closeGraceMs: 250,
    backoffInitialMs: 1000,
    backoffMaxMs: 30000,
    backoffFactor: 2
});

const MAX_HEARTBEAT_MS = 15000;
const HEARTBEAT_OWNER = Symbol('alicat-heartbeat');

/**
 * Allowed range of each tunable option. `configure()` checks every value
 * before it changes anything, so a bad setting can't leave the client half
 * reconfigured (for example a zero backoff that reconnects in a tight loop,
 * or a heartbeat register that throws inside the heartbeat timer).
 * `zeroOff` allows 0 (= feature off) below `min`.
 * @type {Readonly<Record<keyof ClientSettings, {min: number, max: number, integer?: boolean, zeroOff?: boolean} | 'boolean'>>}
 */
const LIMITS = Object.freeze({
    connectTimeoutMs: { min: 50, max: 600000, integer: true },
    requestTimeoutMs: { min: 10, max: 600000, integer: true },
    interFrameDelayMs: { min: 0, max: 60000, integer: true },
    maxQueueDepth: { min: 1, max: 100000, integer: true },
    queueDeadlineMs: { min: 10, max: 3600000, integer: true },
    agingMs: { min: 0, max: 3600000, integer: true },
    stableMs: { min: 0, max: 3600000, integer: true },
    linkSuspectTimeouts: { min: 1, max: 1000, integer: true },
    heartbeatMs: { min: 50, max: 3600000, integer: true, zeroOff: true }, // capped at MAX_HEARTBEAT_MS
    heartbeatUnitId: { min: 0, max: 255, integer: true },
    heartbeatRegister: { min: 1, max: 65536, integer: true },
    lateReplyGraceMs: { min: 0, max: 60000, integer: true },
    keepAliveMs: { min: 0, max: 3600000, integer: true },
    failFastWhenOffline: 'boolean',
    retries: { min: 0, max: 10, integer: true },
    logThrottleMs: { min: 0, max: 86400000, integer: true },
    closeGraceMs: { min: 0, max: 60000, integer: true },
    backoffInitialMs: { min: 10, max: 3600000, integer: true },
    backoffMaxMs: { min: 10, max: 86400000, integer: true },
    backoffFactor: { min: 1, max: 10 }
});

/**
 * @param {keyof ClientSettings} key
 * @param {unknown} value
 * @returns {string | null} what is wrong, or null
 */
function checkOption(key, value) {
    const limit = LIMITS[key];
    if (limit === 'boolean') {
        return typeof value === 'boolean' ? null : `${key} must be true or false, got ${String(value)}`;
    }
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return `${key} must be a number, got ${String(value)}`;
    }
    if (limit.integer && !Number.isInteger(value)) {
        return `${key} must be a whole number, got ${value}`;
    }
    if (limit.zeroOff && value === 0) {
        return null;
    }
    if (value < limit.min || value > limit.max) {
        return `${key} must be ${limit.zeroOff ? `0 (off) or ` : ''}${limit.min}–${limit.max}, got ${value}`;
    }
    return null;
}

/**
 * @param {string} host
 * @returns {Promise<string>}
 */
function defaultLookup(host) {
    return new Promise((resolve, reject) => {
        dns.lookup(host, (err, address) => (err ? reject(err) : resolve(address)));
    });
}

/**
 * One supervised Modbus TCP connection to one device, shared by every node
 * that talks to it.
 *
 * FSM: IDLE → CONNECTING → ONLINE ⇄ BACKOFF, any → CLOSING → CLOSED.
 *
 * Behaviour:
 * - Exactly one request in flight, with a minimum gap between requests.
 * - Requests issued while CONNECTING wait (within their deadline). In BACKOFF,
 *   CONTROL and URGENT requests fail fast and polls are dropped.
 * - A timeout fails only that request. The link is declared dead
 *   (LINK_SUSPECT) only after several timeouts with no bytes received at all.
 *
 * Events:
 * - 'state' (StateChange)
 * - 'log' ({level, message})
 * - 'warning' (message)
 * - 'stable'
 * @extends {EventEmitter<ClientEvents>}
 */
class AlicatClient extends EventEmitter {
    /** @param {ClientOptions} options */
    constructor(options) {
        super();
        // Every node using the device listens for state changes (its status dot),
        // so more than Node's default of 10 is normal. A bound keeps the leak warning.
        this.setMaxListeners(MAX_LISTENERS);
        if (!options || typeof options.host !== 'string' || options.host.trim() === '') {
            throw new AlicatError('EINVALIDARG', 'host is required');
        }
        this.host = options.host.trim();
        this.port = options.port ?? 502;
        /** @type {ClientSettings} */
        this._opts = { ...DEFAULTS };
        this._random = options.random || Math.random;
        this._strict = Boolean(options.strict);
        this._createTransport = options.createTransport || ((o) => new ModbusTcpTransport(o));
        this._lookup = options.lookup || defaultLookup;
        this._claimAddress = options.claimAddress || null;
        this._trace = options.trace || null;
        this._queue = new PriorityQueue();
        this._backoff = new Backoff();
        this.configure(options);

        /** @type {ClientState} */
        this._state = 'IDLE';
        /** @type {Transport | null} */
        this._transport = null;
        this._gen = 0;
        this._attempt = 0;
        /** @type {QueueItem | null} */
        this._inFlight = null;
        this._lastTxnEnd = 0; // pacing: end of the last transaction
        this._lastActivity = 0; // heartbeat: last time anything was sent or the link came up
        this._onlineSince = 0;
        this._successSinceOnline = 0;
        this._timeoutsSinceOnline = 0;
        this._consecutiveTimeouts = 0;
        this._everConnected = false;
        /** @type {Error | null} */
        this._lastError = null;
        /** @type {{code: string, at: number} | null} */
        this._failLog = null;
        this._nextRetryAt = 0;
        this._pumpScheduled = false;
        /** @type {Record<'retry' | 'pump' | 'heartbeat' | 'sweep', NodeJS.Timeout | null>} */
        this._timers = { retry: null, pump: null, heartbeat: null, sweep: null };
        this._counters = { sent: 0, ok: 0, timeouts: 0, exceptions: 0, retries: 0, linkSuspects: 0, connects: 0 };
        this._rtt = { last: 0, avg: 0, max: 0 };

        /** @type {() => void} */
        this._resolveClosed = () => {};
        /** @type {Promise<void>} */
        this._closed = new Promise((resolve) => { this._resolveClosed = () => resolve(); });
    }

    get state() {
        return this._state;
    }

    get isOnline() {
        return this._state === 'ONLINE';
    }

    /** The error that last took the link down or prevented a connection (null once connected). */
    get lastError() {
        return this._lastError;
    }

    /** Resolves when the client reaches CLOSED. */
    get closed() {
        return this._closed;
    }

    /**
     * Apply (new) settings. Live-updatable: timeouts, pacing, backoff, heartbeat,
     * queue limits and the frame trace. All-or-nothing: every value is checked
     * first, and nothing changes if any of them is invalid.
     * @param {ClientSettingsUpdate} options
     */
    configure(options = {}) {
        /** @type {string[]} */
        const problems = [];
        for (const key of /** @type {(keyof ClientSettings)[]} */ (Object.keys(DEFAULTS))) {
            const value = options[key];
            const problem = value === undefined ? null : checkOption(key, value);
            if (problem) problems.push(problem);
        }
        const { trace } = options;
        if (trace !== null && trace !== undefined && typeof trace !== 'function') {
            problems.push('trace must be a function or null');
        }
        if (problems.length > 0) {
            throw new AlicatError('EINVALIDARG', problems.join('; '));
        }
        this._opts = withDefaults(this._opts, options);
        if (Object.hasOwn(options, 'trace')) {
            this._trace = trace || null;
        }
        if (this._opts.heartbeatMs > MAX_HEARTBEAT_MS) {
            this._opts.heartbeatMs = MAX_HEARTBEAT_MS;
        }
        this._queue.maxDepth = this._opts.maxQueueDepth;
        this._queue.agingMs = this._opts.agingMs;
        this._backoff = new Backoff({
            initialMs: this._opts.backoffInitialMs,
            maxMs: this._opts.backoffMaxMs,
            factor: this._opts.backoffFactor,
            random: this._random
        });
    }

    get options() {
        return { ...this._opts };
    }

    start() {
        if (this._state !== 'IDLE') {
            return;
        }
        this._transition('START');
        this._timers.sweep = unref(setInterval(() => this._queue.sweep(), 1000));
        this._connect();
    }

    /**
     * Close the connection and reject everything queued (ECANCELED).
     * Idempotent; resolves when CLOSED.
     * @returns {Promise<void>}
     */
    stop() {
        if (this._state === 'CLOSED' || this._state === 'CLOSING') {
            return this._closed;
        }
        const error = new AlicatError('ECANCELED', 'Client stopped');
        this._clearTimers();
        this._queue.rejectWhere(() => true, error);
        this._gen++; // invalidates a pending DNS lookup or connect
        if (this._state === 'IDLE') {
            this._transition('STOP');
            this._resolveClosed();
            return this._closed;
        }
        this._transition('STOP');
        const transport = this._transport;
        this._transport = null;
        const done = () => {
            if (this._state === 'CLOSING') {
                this._transition('CLOSED');
            }
            this._resolveClosed();
        };
        if (!transport) {
            done();
        } else if (transport.isOpen && !this._inFlight) {
            transport.close(this._opts.closeGraceMs).then(done, done);
        } else {
            transport.destroy(error);
            transport.closed.then(done, done);
        }
        return this._closed;
    }

    /** Force a reconnect now (e.g. operator request). */
    reconnect() {
        if (this._state === 'ONLINE') {
            this._goBackoff('RECONNECT', new AlicatError('ECANCELED', 'Reconnect requested'), 0, false);
        } else if (this._state === 'BACKOFF') {
            clearTimeout(/** @type {NodeJS.Timeout} */ (this._timers.retry));
            this._timers.retry = null;
            this._retry();
        }
    }

    /**
     * @overload
     * @param {number} unitId
     * @param {import('./modbus/pdu').ReadRequest} request
     * @param {ReadOptions} [opts]
     * @returns {Promise<TimedRead>}
     */
    /**
     * @overload
     * @param {number} unitId
     * @param {import('./modbus/pdu').Request} request
     * @param {RequestOptions} [opts]
     * @returns {Promise<Settlement>}
     */
    /**
     * Queue one Modbus request. It resolves with the device's reply, or with
     * `{superseded: true}` when it has a replaceKey and a newer request took its place.
     * @param {number} unitId
     * @param {import('./modbus/pdu').Request} request
     * @param {RequestOptions} [opts]
     * @returns {Promise<Settlement>}
     */
    request(unitId, request, opts = {}) {
        return new Promise((resolve, reject) => {
            const refused = this._refusal(opts);
            if (refused) {
                reject(refused);
                return;
            }
            const now = Date.now();
            const waiter = this._waiter(resolve, reject, opts, now);
            try {
                this._queue.push(this._queueSpec(unitId, request, opts), waiter, now);
            } catch (err) {
                settle(waiter, /** @type {Error} */ (err));
                return;
            }
            this._schedulePump();
        });
    }

    /**
     * Why a new request can't be queued now, or null if it can.
     * @param {RequestOptions} opts
     * @returns {Error | null}
     */
    _refusal(opts) {
        if (this._state === 'CLOSED' || this._state === 'CLOSING') {
            return new AlicatError('ECLOSED', `Client for ${this.host}:${this.port} is closed`);
        }
        const priority = opts.priority ?? Priority.CONTROL;
        if (this._state === 'BACKOFF' && (priority === Priority.POLL || this._opts.failFastWhenOffline)) {
            return this._offlineError();
        }
        if (opts.signal && opts.signal.aborted) {
            return new AlicatError('ECANCELED', 'Request aborted');
        }
        return null;
    }

    /**
     * The caller's side of a queued request; an abort signal cancels it.
     * @param {(value: Settlement) => void} resolve
     * @param {(err: Error) => void} reject
     * @param {RequestOptions} opts
     * @param {number} now
     * @returns {Waiter}
     */
    _waiter(resolve, reject, opts, now) {
        /** @type {Waiter} */
        const waiter = { resolve, reject, owner: opts.owner ?? null, deadline: now + (opts.deadlineMs ?? this._opts.queueDeadlineMs) };
        const { signal } = opts;
        if (signal) {
            const onAbort = () => this._cancelWaiter(waiter, new AlicatError('ECANCELED', 'Request aborted'));
            signal.addEventListener('abort', onAbort, { once: true });
            waiter.cleanup = () => signal.removeEventListener('abort', onAbort);
        }
        return waiter;
    }

    /**
     * @param {number} unitId
     * @param {import('./modbus/pdu').Request} request
     * @param {RequestOptions} opts
     * @returns {import('./PriorityQueue').RequestSpec}
     */
    _queueSpec(unitId, request, opts) {
        return {
            unitId,
            request,
            priority: opts.priority ?? Priority.CONTROL,
            // Only identical requests share a reply: after a re-identification the same
            // caller key can stand for a different block.
            coalesceKey: opts.coalesceKey ? `${opts.coalesceKey}|${unitId}|${request.fc}:${request.address}:${request.quantity}` : undefined,
            replaceKey: opts.replaceKey,
            timeoutMs: opts.timeoutMs ?? this._opts.requestTimeoutMs,
            idempotent: opts.idempotent ?? request.fc === pdu.FC_READ_INPUT_REGISTERS,
            retries: opts.retries ?? this._opts.retries,
            laneJob: Boolean(opts.laneJob)
        };
    }

    /**
     * FC04 read by 1-based register number.
     * @param {number} unitId
     * @param {number} register
     * @param {number} quantity
     * @param {ReadOptions} [opts]
     * @returns {Promise<number[]>}
     */
    async readInputRegisters(unitId, register, quantity, opts = {}) {
        const res = await this.request(unitId, pdu.buildReadInputRegisters(toAddress(register), quantity),
            { priority: Priority.POLL, ...opts });
        return res.registers;
    }

    /**
     * FC16 write by 1-based register number.
     * @param {number} unitId
     * @param {number} register
     * @param {number[]} values
     * @param {RequestOptions} [opts]
     */
    writeRegisters(unitId, register, values, opts = {}) {
        return this.request(unitId, pdu.buildWriteMultipleRegisters(toAddress(register), values), opts);
    }

    /**
     * Cancel every request belonging to `owner` (queued or in flight).
     * @param {unknown} owner
     * @param {string} [reason]
     */
    cancelByOwner(owner, reason = 'Owner closed') {
        const error = new AlicatError('ECANCELED', reason);
        let count = this._queue.cancelOwner(owner, error);
        if (this._inFlight) {
            for (const w of this._inFlight.waiters) {
                if (w.owner === owner && settle(w, error)) {
                    count++;
                }
            }
        }
        return count;
    }

    stats() {
        return {
            state: this._state,
            host: this.host,
            port: this.port,
            attempt: this._attempt,
            depth: this._queue.depths(),
            inFlight: Boolean(this._inFlight),
            ...this._counters,
            queue: { ...this._queue.stats },
            rtt: { ...this._rtt },
            lastError: this._lastError ? errorSummary(this._lastError) : null,
            transport: this._transport ? { ...this._transport.stats } : null
        };
    }

    // ---------------------------------------------------------------- FSM

    /**
     * @param {ClientEvent} event
     * @param {{error?: Error | null, nextRetryInMs?: number | null}} [info]
     */
    _transition(event, info = {}) {
        const prev = this._state;
        const next = TRANSITIONS[prev][event];
        if (!next) {
            const message = `Illegal transition ${event} in state ${prev}`;
            if (this._strict) {
                throw new Error(message);
            }
            this.emit('warning', message);
            return false;
        }
        this._state = next;
        /** @type {StateChange} */
        const change = {
            state: next,
            prev,
            event,
            error: info.error ?? null,
            attempt: this._attempt,
            nextRetryInMs: info.nextRetryInMs ?? null
        };
        this.emit('state', change);
        return true;
    }

    async _connect() {
        const gen = ++this._gen;
        try {
            let address = this.host;
            if (!net.isIP(this.host)) {
                try {
                    address = await this._lookup(this.host);
                } catch (err) {
                    throw new AlicatError('ECONNECT', `Cannot resolve ${this.host}`, { cause: err });
                }
                if (gen !== this._gen || this._state !== 'CONNECTING') {
                    return;
                }
            }
            if (this._claimAddress && !this._claimAddress(address, this.port)) {
                throw new AlicatError('EDUPLICATE',
                    `${this.host}:${this.port} (${address}) is already in use by another configuration of this device`);
            }
            const transport = this._createTransport({
                host: address,
                port: this.port,
                connectTimeoutMs: this._opts.connectTimeoutMs,
                keepAliveMs: this._opts.keepAliveMs,
                lateReplyGraceMs: this._opts.lateReplyGraceMs,
                // Looked up on every frame, so turning the trace on or off (a redeploy reuses
                // this connection) takes effect immediately.
                trace: (direction, data) => { if (this._trace) this._trace(direction, data); }
            });
            this._transport = transport;
            transport.on('down', (/** @type {Error} */ err) => this._onTransportDown(transport, err));
            transport.on('warning', (/** @type {string} */ message) => this.emit('warning', message));
            await transport.connect();
            if (gen !== this._gen || transport !== this._transport || this._state !== 'CONNECTING') {
                transport.destroy();
                return;
            }
            this._onConnected();
        } catch (err) {
            if (gen !== this._gen || this._state !== 'CONNECTING') {
                return;
            }
            this._onConnectFailed(/** @type {Error} */ (err));
        }
    }

    _onConnected() {
        const now = Date.now();
        this._counters.connects++;
        this._onlineSince = now;
        this._lastTxnEnd = 0; // no pacing gap before the first request
        this._lastActivity = now;
        this._successSinceOnline = 0;
        this._timeoutsSinceOnline = 0;
        this._consecutiveTimeouts = 0;
        this._lastError = null;
        const recovered = this._failLog !== null;
        this._failLog = null;
        this._everConnected = true;
        // State first, listeners last: a throwing listener must not leave queued work unsent.
        this._schedulePump();
        this._transition('CONNECTED');
        if (recovered) {
            this.emit('log', { level: 'info', message: `Connected to ${this.host}:${this.port} after ${this._attempt} failed attempt(s)` });
        }
    }

    /** @param {Error} err */
    _onConnectFailed(err) {
        this._transport = null;
        this._attempt++;
        const delay = this._backoff.delay(this._attempt);
        this._lastError = err;
        // Schedule the retry first, so the failed requests report when it will happen.
        this._scheduleRetry(delay);
        this._failQueued(err);
        this._logFailure(err);
        this._transition('CONNECT_FAILED', { error: err, nextRetryInMs: delay });
    }

    /**
     * @param {Transport} transport
     * @param {Error} err
     */
    _onTransportDown(transport, err) {
        if (transport !== this._transport || this._state !== 'ONLINE') {
            return;
        }
        this._goBackoff('DOWN', err);
    }

    /**
     * @param {'DOWN' | 'LINK_SUSPECT' | 'RECONNECT'} event
     * @param {Error} err
     * @param {number} [delayOverride]
     * @param {boolean} [countAttempt]
     */
    _goBackoff(event, err, delayOverride, countAttempt = true) {
        const transport = this._transport;
        this._transport = null;
        this._clearTimer('heartbeat');
        this._clearTimer('pump');
        if (countAttempt) {
            this._attempt++;
        }
        const delay = delayOverride ?? this._backoff.delay(Math.max(1, this._attempt));
        this._lastError = err;
        if (transport) {
            transport.destroy(err);
        }
        // Schedule the retry first, so the failed requests report when it will happen.
        this._scheduleRetry(delay);
        this._failQueued(err);
        if (event !== 'RECONNECT') {
            this._logFailure(err);
        }
        this._transition(event, { error: err, nextRetryInMs: delay });
    }

    /** @param {number} delay */
    _scheduleRetry(delay) {
        this._clearTimer('retry');
        this._nextRetryAt = Date.now() + delay;
        this._timers.retry = unref(setTimeout(() => {
            this._timers.retry = null;
            this._retry();
        }, delay));
    }

    _retry() {
        if (this._state !== 'BACKOFF') {
            return;
        }
        this._transition('RETRY');
        this._connect();
    }

    /** Reject queued work that must not wait for a reconnect. @param {Error | null} cause */
    _failQueued(cause) {
        const error = this._offlineError(cause);
        this._queue.rejectWhere((item) => item.priority === Priority.POLL || this._opts.failFastWhenOffline, error);
    }

    /** @param {Error | null} [cause] */
    _offlineError(cause = this._lastError) {
        const retryIn = Math.max(0, this._nextRetryAt - Date.now());
        return new AlicatError('ENOTCONNECTED', `Not connected to ${this.host}:${this.port}`,
            cause ? { cause, nextRetryInMs: retryIn } : { nextRetryInMs: retryIn });
    }

    // ---------------------------------------------------------------- dispatch

    _schedulePump() {
        if (this._pumpScheduled) {
            return;
        }
        this._pumpScheduled = true;
        // Defer one turn so requests issued together are ordered by priority, not arrival.
        setImmediate(() => {
            this._pumpScheduled = false;
            this._pump();
        });
    }

    _pump() {
        if (this._state !== 'ONLINE' || this._inFlight || this._timers.pump) {
            return;
        }
        const now = Date.now();
        const gap = this._lastTxnEnd + this._opts.interFrameDelayMs - now;
        if (gap > 0) {
            this._timers.pump = unref(setTimeout(() => {
                this._timers.pump = null;
                this._pump();
            }, gap));
            return;
        }
        const item = this._queue.next(now);
        if (!item) {
            this._armHeartbeat();
            return;
        }
        this._clearTimer('heartbeat');
        this._dispatch(item);
    }

    /** @param {QueueItem} item */
    async _dispatch(item) {
        this._inFlight = item;
        const transport = /** @type {Transport} */ (this._transport);
        for (let attempts = 0; ; attempts++) {
            this._counters.sent++;
            try {
                const response = await transport.send(item.unitId, item.request, item.timeoutMs);
                this._onSuccess(response);
                for (const w of item.waiters) settle(w, null, response);
                break;
            } catch (e) {
                const err = /** @type {Error} */ (e);
                // A failure on a transport that has since been replaced says nothing about the link.
                const current = transport === this._transport;
                if (current) this._onFailure(err);
                if (!current || !this._shouldRetry(item, err, attempts)) {
                    for (const w of item.waiters) settle(w, err);
                    break;
                }
                this._counters.retries++;
                if (isModbusException(err, SERVER_DEVICE_BUSY) && this._opts.interFrameDelayMs > 0) {
                    // A device that said "busy" gets at least the normal gap before it is asked again.
                    await sleep(this._opts.interFrameDelayMs);
                }
                // Retry in place: it keeps the slot, so it can't overtake newer work.
            }
        }
        this._finishTransaction(item);
    }

    /** Count a failed transaction: timeouts feed link supervision. @param {Error} err */
    _onFailure(err) {
        if (codeOf(err) === 'ETIMEDOUT') {
            this._onTimeout();
        } else if (codeOf(err) === 'EMODBUS') {
            this._counters.exceptions++;
            this._consecutiveTimeouts = 0; // an exception reply proves the link is alive
        }
    }

    /**
     * Whether a failed transaction is sent again: a timeout or a busy reply, on a
     * repeat-safe request with retries left, that someone still waits for in
     * time, while the link is healthy.
     * @param {QueueItem} item @param {Error} err @param {number} attempts retries so far
     */
    _shouldRetry(item, err, attempts) {
        const retryable = codeOf(err) === 'ETIMEDOUT' || isModbusException(err, SERVER_DEVICE_BUSY);
        if (!retryable || !item.idempotent || attempts >= item.retries) return false;
        const live = item.waiters.filter((w) => !w.done);
        const latest = live.reduce((max, w) => Math.max(max, w.deadline), 0);
        return live.length > 0 && Date.now() < latest && !this._isLinkSuspect() && this._state === 'ONLINE';
    }

    /** @param {QueueItem} item */
    _finishTransaction(item) {
        item.state = 'done';
        this._inFlight = null;
        this._lastTxnEnd = Date.now();
        this._lastActivity = this._lastTxnEnd;
        if (this._state === 'ONLINE' && this._isLinkSuspect()) {
            this._counters.linkSuspects++;
            this._goBackoff('LINK_SUSPECT', new AlicatError('ELINKDOWN',
                `${this.host}:${this.port} stopped responding (${this._consecutiveTimeouts} timeouts, no data received)`));
            return;
        }
        this._pump();
    }

    /** @param {TimedResponse} response */
    _onSuccess(response) {
        const now = Date.now();
        this._counters.ok++;
        this._consecutiveTimeouts = 0;
        this._successSinceOnline++;
        this._rtt.last = response.rttMs;
        this._rtt.max = Math.max(this._rtt.max, response.rttMs);
        this._rtt.avg = this._rtt.avg === 0 ? response.rttMs : this._rtt.avg * 0.9 + response.rttMs * 0.1;
        if (this._attempt > 0 && now - this._onlineSince >= this._opts.stableMs && this._timeoutsSinceOnline === 0) {
            this._attempt = 0;
            this.emit('stable');
        }
    }

    _onTimeout() {
        this._counters.timeouts++;
        this._consecutiveTimeouts++;
        this._timeoutsSinceOnline++;
    }

    _isLinkSuspect() {
        if (this._consecutiveTimeouts < this._opts.linkSuspectTimeouts || !this._transport) {
            return false;
        }
        const lastRx = Math.max(this._transport.lastRxAt, this._onlineSince);
        return Date.now() - lastRx >= 2 * this._opts.requestTimeoutMs;
    }

    _armHeartbeat() {
        if (this._timers.heartbeat || !this._opts.heartbeatMs || this._state !== 'ONLINE') {
            return;
        }
        // After a silent timeout, probe every timeout period so a dead link is found in seconds.
        const interval = this._consecutiveTimeouts > 0 ? this._opts.requestTimeoutMs : this._opts.heartbeatMs;
        const due = Math.max(0, this._lastActivity + interval - Date.now());
        this._timers.heartbeat = unref(setTimeout(() => {
            this._timers.heartbeat = null;
            if (this._state !== 'ONLINE') {
                return;
            }
            this.request(this._opts.heartbeatUnitId,
                pdu.buildReadInputRegisters(toAddress(this._opts.heartbeatRegister), 1),
                { priority: Priority.POLL, coalesceKey: '__heartbeat', owner: HEARTBEAT_OWNER, retries: 0 })
                .catch(() => {});
        }, due));
    }

    /**
     * @param {Waiter} waiter
     * @param {Error} error
     */
    _cancelWaiter(waiter, error) {
        if (waiter.item && waiter.item.state === 'queued') {
            this._queue.cancelWaiter(waiter, error);
        } else {
            settle(waiter, error);
        }
    }

    /** @param {Error} err */
    _logFailure(err) {
        const code = codeOf(err.cause) || codeOf(err) || 'ERROR';
        const now = Date.now();
        if (this._failLog && this._failLog.code === code && now - this._failLog.at < this._opts.logThrottleMs) {
            return;
        }
        const hint = code === 'ECONNREFUSED' && this._everConnected
            ? '; another master may be holding the device\'s connection'
            : '';
        this.emit('log', {
            level: 'warn',
            message: `${this._failLog ? 'Still unable' : 'Unable'} to reach ${this.host}:${this.port} (attempt ${this._attempt}, ${code}): ${err.message}${hint}`
        });
        this._failLog = { code, at: now };
    }

    /** @param {'retry' | 'pump' | 'heartbeat' | 'sweep'} name */
    _clearTimer(name) {
        const timer = this._timers[name];
        if (timer) {
            clearTimeout(timer);
            clearInterval(timer);
            this._timers[name] = null;
        }
    }

    _clearTimers() {
        for (const name of /** @type {const} */ (['retry', 'pump', 'heartbeat', 'sweep'])) {
            this._clearTimer(name);
        }
    }
}

module.exports = { AlicatClient, STATES, TRANSITIONS, DEFAULTS, Priority, HEARTBEAT_OWNER };
