'use strict';

/**
 * Closed set of error codes. `err.code` is public API and is governed by SemVer:
 * adding a code is a minor change, renaming or removing one is a major change.
 * OS-level errors (ECONNREFUSED, EHOSTUNREACH, EPIPE, …) are never exposed as
 * `code`; they travel in `err.cause` because they differ between platforms.
 */
const CODES = Object.freeze({
    ENOTCONNECTED: 'Not connected to the device',
    ECONNECT: 'Could not connect to the device',
    ELINKDOWN: 'Connection to the device was lost',
    ETIMEDOUT: 'No response from the device',
    EQUEUETIMEOUT: 'Request expired before it could be sent',
    EQUEUEFULL: 'Request queue is full',
    ECANCELED: 'Request was cancelled',
    ECLOSED: 'Client is closed',
    EMODBUS: 'Device returned a Modbus exception',
    ECOMMAND: 'Device rejected the command',
    EPREEMPTED: 'Command was pre-empted by an urgent command',
    EUNSUPPORTED: 'Not supported by this device or firmware',
    EINVALIDARG: 'Invalid argument',
    EIDENTIFY: 'Could not identify the device',
    EFRAMING: 'Malformed Modbus frame',
    EDUPLICATE: 'Another configuration already uses this device'
});

/**
 * @typedef {keyof typeof CODES} ErrorCode
 * @typedef {'not-sent' | 'unknown' | 'accepted' | 'rejected'} FailureOutcome
 *   What a failed write did: never left this process, may or may not have
 *   reached the device, reached it but wasn't confirmed, or was refused.
 * @typedef {{
 *   cause?: unknown,
 *   outcome?: FailureOutcome,
 *   exceptionCode?: number, exceptionName?: string,
 *   fc?: number, address?: number, txnId?: number,
 *   command?: number, arg?: number, status?: number, statusName?: string,
 *   nextRetryInMs?: number
 * }} ErrorDetails
 *   Facts an error carries next to its code. Each is an own, enumerable
 *   property, so Node-RED copies it into msg.error:
 *   - EMODBUS: exceptionCode, exceptionName, fc, address;
 *   - ETIMEDOUT (transport): txnId, fc, address;
 *   - command lane errors: command (ID), arg, status, statusName (ECOMMAND);
 *   - ENOTCONNECTED: nextRetryInMs;
 *   - writes: outcome.
 */

/**
 * The message for a new error: the one given, or the code's default. Throws
 * for a code outside the closed set.
 * @param {ErrorCode} code @param {string | undefined} message
 */
function messageFor(code, message) {
    if (!Object.hasOwn(CODES, code)) {
        throw new TypeError(`Unknown AlicatError code: ${code}`);
    }
    return message || CODES[code];
}

class AlicatError extends Error {
    /**
     * @param {ErrorCode} code
     * @param {string} [message]
     * @param {ErrorDetails} [details]
     */
    constructor(code, message, details = {}) {
        const { cause } = details;
        super(messageFor(code, message), cause === undefined ? undefined : { cause });
        // A detail becomes an own, enumerable property only when it is given, so
        // Object.keys() and toJSON() list exactly the facts supplied. Other keys
        // (including code, name, message and stack) are ignored.
        const d = details;
        if (d.outcome !== undefined) /** @type {FailureOutcome | undefined} */ this.outcome = d.outcome;
        if (d.exceptionCode !== undefined) /** @type {number | undefined} */ this.exceptionCode = d.exceptionCode;
        if (d.exceptionName !== undefined) /** @type {string | undefined} */ this.exceptionName = d.exceptionName;
        if (d.fc !== undefined) /** @type {number | undefined} */ this.fc = d.fc;
        if (d.address !== undefined) /** @type {number | undefined} */ this.address = d.address;
        if (d.txnId !== undefined) /** @type {number | undefined} */ this.txnId = d.txnId;
        if (d.command !== undefined) /** @type {number | undefined} */ this.command = d.command;
        if (d.arg !== undefined) /** @type {number | undefined} */ this.arg = d.arg;
        if (d.status !== undefined) /** @type {number | undefined} */ this.status = d.status;
        if (d.statusName !== undefined) /** @type {string | undefined} */ this.statusName = d.statusName;
        if (d.nextRetryInMs !== undefined) /** @type {number | undefined} */ this.nextRetryInMs = d.nextRetryInMs;
        this.name = 'AlicatError';
        // Own, enumerable property so Node-RED copies it into msg.error.
        this.code = code;
    }

    toJSON() {
        const json = { ...this, name: this.name, code: this.code, message: this.message };
        if (this.cause instanceof Error) {
            const cause = /** @type {Error & {code?: string}} */ (this.cause);
            json.cause = { name: cause.name, message: cause.message, code: cause.code };
        }
        return json;
    }
}

/**
 * @param {unknown} err
 * @param {ErrorCode} [code]
 * @returns {err is AlicatError}
 */
function isAlicatError(err, code) {
    return err instanceof AlicatError && (code === undefined || err.code === code);
}

/**
 * The string `code` of any thrown value (an AlicatError, a Node system error), if it has one.
 * @param {unknown} err
 * @returns {string | undefined}
 */
function codeOf(err) {
    const code = typeof err === 'object' && err !== null ? /** @type {{code?: unknown}} */ (err).code : undefined;
    return typeof code === 'string' ? code : undefined;
}

/**
 * `{code, message}` of anything thrown, for events, stats and snapshots.
 * @param {unknown} err
 * @returns {{code: string, message: string}}
 */
function errorSummary(err) {
    return { code: codeOf(err) || 'ERROR', message: err instanceof Error ? err.message : String(err) };
}

/**
 * Whether `err` is the device answering with Modbus exception `exceptionCode`.
 * @param {unknown} err
 * @param {number} exceptionCode
 */
function isModbusException(err, exceptionCode) {
    return codeOf(err) === 'EMODBUS' && /** @type {{exceptionCode?: unknown}} */ (err).exceptionCode === exceptionCode;
}

/** Client errors that can only happen before a request is transmitted. */
const NOT_TRANSMITTED = Object.freeze(new Set(['EQUEUETIMEOUT', 'EQUEUEFULL', 'ENOTCONNECTED']));

/**
 * The outcome of a write that failed with `err`: 'not-sent' if it never left
 * the queue, otherwise 'unknown' (it may have reached the device).
 * @param {unknown} err
 * @returns {'not-sent' | 'unknown'}
 */
function failedWriteOutcome(err) {
    const code = codeOf(err);
    return code !== undefined && NOT_TRANSMITTED.has(code) ? 'not-sent' : 'unknown';
}

/**
 * Give `err` an outcome unless it already has one, and return it (for `throw withOutcome(...)`).
 * @template {unknown} E
 * @param {E} err
 * @param {FailureOutcome} outcome
 * @returns {E}
 */
function withOutcome(err, outcome) {
    if (err instanceof AlicatError && err.outcome === undefined) {
        err.outcome = outcome;
    }
    return err;
}

module.exports = {
    AlicatError, CODES, isAlicatError, codeOf, errorSummary, isModbusException, NOT_TRANSMITTED, failedWriteOutcome, withOutcome
};
