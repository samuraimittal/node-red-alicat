'use strict';

const { AlicatError } = require('./errors');
const { Priority } = require('./PriorityQueue');
const { EXTENDED, LIMITED } = require('./lane/interface');
const { LaneSession, commandResult } = require('./lane/session');

/**
 * @typedef {'none' | 'u16' | 'i32' | 'u32' | 'f32'} ArgType
 * @typedef {{
 *   id: number, arg?: number, argType?: ArgType | undefined, returnType?: 'none' | 'u16' | 'i32' | 'f32' | undefined,
 *   priority?: 0 | 1 | 2, timeoutMs?: number | undefined, owner?: unknown, label?: string, retryIfDropped?: boolean,
 *   onQueuedBehind?: (running: {id: number, arg: number}) => void
 * }} CommandSpec
 * @typedef {{
 *   id: number, arg: number, interface: 'extended' | 'limited',
 *   outcome: 'executed' | 'accepted' | 'rejected' | 'unknown' | 'not-sent',
 *   status: number | null, statusName: string | null, returnValue: number | null,
 *   durationMs: number, queuedBehind: {id: number, arg: number} | null, superseded?: boolean
 * }} CommandResult
 * @typedef {{spec: CommandSpec, resolve: (r: CommandResult) => void, reject: (e: Error) => void,
 *            controller: AbortController, urgent: boolean, started: boolean}} Job
 * @typedef {import('./lane/interface').Echo} Echo
 * @typedef {{
 *   maxDepth?: number | undefined, nopSettleMs?: number | undefined, minNopGapMs?: number | undefined,
 *   dropDetectMs?: number | undefined, pollIntervalMs?: number | undefined, defaultTimeoutMs?: number | undefined
 * }} LaneTimings
 */

/**
 * One command at a time per device, over Alicat's command registers. The
 * handshake is built on what 10v20 and 9v07 hardware actually do (Gate 0),
 * and each step is a method of LaneSession (lib/lane/session.js):
 *
 * 1. Read the echo. A foreign command that is still running is waited out;
 *    URGENT doesn't wait (the device queues it anyway, so it is reported as
 *    `queuedBehind`).
 * 2. Write a NOP. The device runs a write only if it differs from the
 *    previous write on the same interface, and that can't be read back, so a
 *    NOP always comes first. Then settle: if the echo was non-zero, wait for
 *    it to drop to 0; otherwise wait 300 ms (more than 2 device cycles).
 *    Never write while the echo already shows our command, or completion
 *    would be ambiguous.
 * 3. Write the command, then poll every 100 ms (the device cycle is
 *    ~110–125 ms) until the echo shows it finished.
 *
 * URGENT jobs jump the lane and pre-empt the active job's polling. That job
 * rejects EPREEMPTED with outcome 'unknown'.
 */
class CommandLane {
    /**
     * @param {LaneTimings & {
     *   client: InstanceType<typeof import('./AlicatClient').AlicatClient>,
     *   unitId: number,
     *   useExtended: () => boolean,
     *   onWarning?: (message: string) => void
     * }} options
     */
    constructor(options) {
        this.client = options.client;
        this.unitId = options.unitId;
        this._useExtended = options.useExtended;
        this.maxDepth = options.maxDepth ?? 8;
        this.nopSettleMs = options.nopSettleMs ?? 300;
        this.minNopGapMs = options.minNopGapMs ?? Math.min(200, this.nopSettleMs);
        this.dropDetectMs = options.dropDetectMs ?? 1000;
        this.pollIntervalMs = options.pollIntervalMs ?? 100;
        this.defaultTimeoutMs = options.defaultTimeoutMs ?? 10000;
        this._warn = options.onWarning || (() => {});
        /** @type {Job[]} */
        this._jobs = [];
        /** @type {Job | null} */
        this._active = null;
        this._closed = false;
        this._warnedForeign = false;
        this._urgentRequests = 0;
    }

    get depth() {
        return this._jobs.length + (this._active ? 1 : 0);
    }

    /** The command running now, or null: the same object for as long as it runs (diagnostics). */
    get activeCommand() {
        return this._active ? this._active.spec : null;
    }

    /**
     * How many URGENT (valve) commands have been requested so far. A multi-step
     * operation compares it before and after, to see whether an operator's
     * valve command arrived in between and must not be undone.
     */
    get urgentRequests() {
        return this._urgentRequests;
    }

    /**
     * @param {CommandSpec} spec
     * @returns {Promise<CommandResult>}
     */
    run(spec) {
        return new Promise((resolve, reject) => {
            if (this._closed) {
                reject(new AlicatError('ECLOSED', 'Command lane is closed'));
                return;
            }
            /** @type {Job} */
            const job = { spec, resolve, reject, controller: new AbortController(), urgent: spec.priority === Priority.URGENT, started: false };
            if (job.urgent) {
                this._urgentRequests++;
                const old = this._jobs.find((j) => j.urgent);
                if (old) {
                    this._jobs.splice(this._jobs.indexOf(old), 1);
                    old.resolve(commandResult(old.spec, 'not-sent', Date.now(), this._interface().name, { superseded: true }));
                }
                this._jobs.unshift(job);
                if (this._active && !this._active.urgent) {
                    this._active.controller.abort('preempted');
                }
            } else {
                if (this._jobs.length >= this.maxDepth) {
                    reject(new AlicatError('EQUEUEFULL', `Command lane is full (${this.maxDepth} commands waiting)`));
                    return;
                }
                this._jobs.push(job);
            }
            this._drain();
        });
    }

    /** Cancel queued commands of `owner`; an active one has its polling aborted. @param {unknown} owner */
    cancelOwner(owner) {
        const error = new AlicatError('ECANCELED', 'Owner closed');
        this._jobs = this._jobs.filter((j) => {
            if (j.spec.owner === owner) {
                j.reject(error);
                return false;
            }
            return true;
        });
        if (this._active && this._active.spec.owner === owner) {
            this._active.controller.abort('cancelled');
        }
    }

    close() {
        this._closed = true;
        const error = new AlicatError('ECLOSED', 'Command lane is closed');
        for (const j of this._jobs) j.reject(error);
        this._jobs = [];
        if (this._active) this._active.controller.abort('closed');
    }

    _interface() {
        return this._useExtended() ? EXTENDED : LIMITED;
    }

    /**
     * What a session needs from this lane, with the current timings.
     * @returns {import('./lane/session').LaneContext}
     */
    _context() {
        return {
            client: this.client,
            unitId: this.unitId,
            nopSettleMs: this.nopSettleMs,
            minNopGapMs: this.minNopGapMs,
            dropDetectMs: this.dropDetectMs,
            pollIntervalMs: this.pollIntervalMs,
            warn: (message) => this._warn(message),
            foreignEcho: (id, label) => {
                if (this._warnedForeign) return;
                this._warnedForeign = true;
                this._warn(`Command echo shows command ${id}, not ${label}: another master may be sending commands`);
            }
        };
    }

    async _drain() {
        if (this._active) {
            return;
        }
        while (this._jobs.length > 0) {
            const job = /** @type {Job} */ (this._jobs.shift());
            this._active = job;
            job.started = true;
            try {
                const session = new LaneSession(this._context(), job.spec, {
                    signal: job.controller.signal,
                    urgent: job.urgent,
                    timeoutMs: job.spec.timeoutMs ?? this.defaultTimeoutMs,
                    iface: this._interface()
                });
                job.resolve(await session.run());
            } catch (err) {
                job.reject(/** @type {Error} */ (err));
            } finally {
                this._active = null;
            }
        }
    }
}

module.exports = { CommandLane };
