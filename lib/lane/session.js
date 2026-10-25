'use strict';

const { AlicatError, codeOf, failedWriteOutcome, withOutcome } = require('../errors');
const { Priority } = require('../PriorityQueue');
const { statusName } = require('../alicat/commands');
const { sleep } = require('../util/timers');

/**
 * One command's run through the handshake measured on hardware (see
 * CommandLane): wait out a foreign command, NOP and settle, send, then poll
 * the echo until the command completes.
 *
 * @typedef {import('../CommandLane').CommandSpec} CommandSpec
 * @typedef {import('../CommandLane').CommandResult} CommandResult
 * @typedef {import('./interface').CommandInterface} CommandInterface
 * @typedef {import('./interface').Echo} Echo
 * @typedef {{
 *   client: InstanceType<typeof import('../AlicatClient').AlicatClient>,
 *   unitId: number,
 *   nopSettleMs: number, minNopGapMs: number, dropDetectMs: number, pollIntervalMs: number,
 *   warn(message: string): void,
 *   foreignEcho(id: number, label: string): void
 * }} LaneContext
 *   What a session needs from its lane. `foreignEcho`: the echo shows a command
 *   this lane did not send (the lane warns once).
 */

/**
 * @param {CommandSpec} spec
 * @param {CommandResult['outcome']} outcome
 * @param {number} start when the job started
 * @param {'extended' | 'limited'} iface
 * @param {{returnValue?: number | null, status?: number, queuedBehind?: {id: number, arg: number} | null, superseded?: boolean}} [extra]
 * @returns {CommandResult}
 */
function commandResult(spec, outcome, start, iface, extra = {}) {
    return {
        id: spec.id,
        arg: spec.arg ?? 0,
        interface: iface,
        outcome,
        status: extra.status ?? null,
        statusName: extra.status === undefined ? null : statusName(extra.status),
        returnValue: extra.returnValue ?? null,
        durationMs: Date.now() - start,
        queuedBehind: extra.queuedBehind ?? null,
        ...(extra.superseded ? { superseded: true } : {})
    };
}

class LaneSession {
    /**
     * @param {LaneContext} lane
     * @param {CommandSpec} spec
     * @param {{signal: AbortSignal, urgent: boolean, timeoutMs: number, iface: CommandInterface}} job
     */
    constructor(lane, spec, job) {
        this.lane = lane;
        this.spec = spec;
        this.iface = job.iface;
        this.signal = job.signal;
        this.urgent = job.urgent;
        this.label = spec.label || `command ${spec.id}`;
        this.timeoutMs = job.timeoutMs;
        this.start = Date.now();
        this.deadline = this.start + job.timeoutMs;
        /** @type {number[]} the encoded command */
        this.words = [];
        /** @type {Echo | null} */
        this.echo = null;
        /** @type {{id: number, arg: number} | null} a running foreign command an urgent one was queued behind */
        this.queuedBehind = null;
        this.writing = false; // the command write is queued or in flight
        this.sent = false; // the command write completed
        this.base = { priority: spec.priority ?? Priority.CONTROL, laneJob: true, owner: spec.owner ?? null, signal: job.signal };
    }

    /** @returns {Promise<CommandResult>} */
    async run() {
        try {
            this.words = this.iface.encode(this.spec.id, this.spec.arg ?? 0, this.spec.argType || 'u16');
        } catch (err) {
            throw withOutcome(err, 'not-sent');
        }
        try {
            await this.waitOutForeign();
            await this.nopAndSettle();
            await this.send();
            return await this.awaitCompletion();
        } catch (err) {
            throw this.failure(err);
        }
    }

    /** 0. Another master's command still running: wait, unless urgent (then report what it is queued behind). */
    async waitOutForeign() {
        let echo = await this.readEcho();
        if (!this.iface.isRunning(echo) || this.isOurs(echo)) return;
        if (this.urgent) {
            this.queuedBehind = { id: echo.id, arg: echo.arg };
            if (this.spec.onQueuedBehind) this.spec.onQueuedBehind(this.queuedBehind);
            return;
        }
        while (this.iface.isRunning(echo)) {
            this.checkDeadline();
            await sleep(this.lane.pollIntervalMs, this.signal);
            echo = await this.readEcho();
        }
    }

    /**
     * 1. NOP, then settle. Even when the NOP's echo appears quickly, the command
     * goes out at least minNopGapMs after the NOP, clear of the device-cycle edge.
     */
    async nopAndSettle() {
        const before = /** @type {Echo} */ (this.echo);
        await this.write(this.iface.encode(0, 0, 'u16'));
        const nopAt = Date.now();
        for (;;) {
            await sleep(this.lane.pollIntervalMs, this.signal);
            const echo = await this.readEcho();
            const elapsed = Date.now() - nopAt;
            const nopExecuted = before.id !== 0 && echo.id === 0 && elapsed >= this.lane.minNopGapMs;
            if (!this.isOurs(echo) && (nopExecuted || elapsed >= this.lane.nopSettleMs)) return;
            this.checkDeadline();
        }
    }

    /** 2. The command itself. */
    async send() {
        this.writing = true;
        await this.write(this.words);
        this.sent = true;
    }

    /**
     * 3. Poll until the echo shows the command finished. A command the device
     * never picked up (seen once on 9v07) is sent again, once, if repeating it
     * is harmless.
     * @returns {Promise<CommandResult>}
     */
    async awaitCompletion() {
        let commandAt = Date.now();
        let resent = false;
        for (;;) {
            await sleep(this.lane.pollIntervalMs, this.signal);
            const echo = await this.readEcho();
            if (this.isOurs(echo)) {
                if (this.iface.isRunning(echo)) {
                    this.checkDeadline();
                    continue;
                }
                const done = this.iface.complete(echo, this.spec.returnType);
                if ('rejected' in done) throw this.rejected(done.rejected);
                return commandResult(this.spec, 'executed', this.start, this.iface.name,
                    { returnValue: done.returnValue, status: 0, queuedBehind: this.queuedBehind });
            }
            if (!this.iface.isRunning(echo) && this.spec.retryIfDropped && !resent && Date.now() - commandAt >= this.lane.dropDetectMs) {
                resent = true;
                this.lane.warn(`${this.label} was not picked up by the device within ${this.lane.dropDetectMs} ms; sending it again`);
                await this.nopAndSettle();
                await this.write(this.words);
                commandAt = Date.now();
                continue;
            }
            if (echo.id !== 0 && !(this.queuedBehind && echo.id === this.queuedBehind.id)) {
                this.lane.foreignEcho(echo.id, this.label);
            }
            this.checkDeadline();
        }
    }

    /**
     * What a failure means for the device: a write that failed before it left
     * the client queue never reached it ('not-sent'); otherwise it may have.
     * @param {unknown} err
     */
    failure(err) {
        const maybeSent = this.sent || (this.writing && (this.signal.aborted || failedWriteOutcome(err) === 'unknown'));
        const outcome = maybeSent ? 'unknown' : 'not-sent';
        /** @type {import('../errors').ErrorDetails} */
        const details = { outcome, command: this.spec.id };
        if (this.signal.aborted) {
            if (this.signal.reason === 'preempted') {
                return new AlicatError('EPREEMPTED', `${this.label} was pre-empted by an urgent command`, details);
            }
            if (this.signal.reason === 'cancelled') {
                return new AlicatError('ECANCELED', `${this.label} cancelled by its owner`, details);
            }
            return new AlicatError('ECLOSED', `${this.label} cancelled: command lane closed`, details);
        }
        if (codeOf(err) === 'EQUEUETIMEOUT') {
            // A step expired in the client queue because the job's own deadline ran out.
            return new AlicatError('ETIMEDOUT', `${this.label} did not complete within ${this.timeoutMs} ms`, { cause: err, ...details });
        }
        return withOutcome(err, outcome);
    }

    /** @returns {Promise<Echo>} */
    async readEcho() {
        const words = await this.lane.client.readInputRegisters(this.lane.unitId, this.iface.register, this.iface.echoQuantity,
            { ...this.base, idempotent: true, retries: 1, deadlineMs: this.remaining() });
        this.echo = this.iface.decodeEcho(words);
        return this.echo;
    }

    /** @param {number[]} values */
    write(values) {
        return this.lane.client.writeRegisters(this.lane.unitId, this.iface.register, values,
            { ...this.base, idempotent: false, retries: 0, deadlineMs: this.remaining() });
    }

    /** @param {Echo} echo */
    isOurs(echo) {
        return this.iface.isOurs(echo, this.spec.id, this.words);
    }

    remaining() {
        return Math.max(1, this.deadline - Date.now());
    }

    checkDeadline() {
        if (Date.now() > this.deadline) {
            throw new AlicatError('ETIMEDOUT', `${this.label} did not complete within ${this.timeoutMs} ms`, { command: this.spec.id });
        }
    }

    /** @param {number} status */
    rejected(status) {
        return new AlicatError('ECOMMAND', `${this.label} rejected by the device: ${statusName(status)}`, {
            command: this.spec.id, arg: this.spec.arg ?? 0, status, statusName: statusName(status), outcome: 'rejected'
        });
    }
}

module.exports = { LaneSession, commandResult };
