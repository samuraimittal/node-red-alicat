'use strict';

const { codeOf } = require('../errors');

/**
 * msg.alicat has one shape, whichever node sends it:
 * - the instrument (DeviceMeta: device, host, port, unitId, generation, firmware, serial);
 * - `op`, the sending node's operation: read, setpoint, command, pid, status or control;
 * - on success, what that operation reports (e.g. `outcome` and `result`);
 * - on failure, `error`. It replaces msg.alicat as a whole, so a Catch node
 *   never sees fields an upstream node left behind.
 *
 * @typedef {import('./types').NodeMessage} NodeMessage
 * @typedef {import('./types').DeviceMeta} DeviceMeta
 * @typedef {'read' | 'setpoint' | 'command' | 'pid' | 'status' | 'control'} Op
 * @typedef {{
 *   code: string, message: string, outcome?: string,
 *   exceptionCode?: number, status?: number, statusName?: string
 * }} ErrorInfo
 */

/**
 * The parts of an error a flow can act on.
 * @param {unknown} err
 * @returns {ErrorInfo}
 */
function errorInfo(err) {
    const e = typeof err === 'object' && err !== null
        ? /** @type {{message?: unknown, outcome?: unknown, exceptionCode?: unknown, status?: unknown, statusName?: unknown}} */ (err)
        : {};
    return {
        code: codeOf(err) || 'ERROR',
        message: typeof e.message === 'string' && e.message !== '' ? e.message : String(err),
        ...(typeof e.outcome === 'string' ? { outcome: e.outcome } : {}),
        ...(typeof e.exceptionCode === 'number' ? { exceptionCode: e.exceptionCode } : {}),
        ...(typeof e.status === 'number' ? { status: e.status } : {}),
        ...(typeof e.statusName === 'string' ? { statusName: e.statusName } : {})
    };
}

/**
 * msg.alicat for a successful operation.
 * @param {DeviceMeta} meta @param {Op} op @param {object} [fields] what the operation reports
 * @returns {DeviceMeta & {op: Op}}
 */
function alicatInfo(meta, op, fields = {}) {
    return { ...meta, op, ...fields };
}

/**
 * Put the full error on msg.alicat before done(err): Node-RED copies only
 * message, source, code, stack and cause into msg.error.
 * @param {NodeMessage} msg
 * @param {unknown} err
 * @param {DeviceMeta | null} meta null when the node has no device configured
 * @param {Op} op
 */
function attachError(msg, err, meta, op) {
    msg.alicat = { ...meta, op, error: errorInfo(err) };
    return msg;
}

module.exports = { errorInfo, alicatInfo, attachError };
