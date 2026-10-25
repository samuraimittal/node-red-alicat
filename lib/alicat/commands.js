'use strict';

const { AlicatError } = require('../errors');
const { Priority } = require('../PriorityQueue');
const { own } = require('../util/own');

/**
 * Command catalog (Alicat Modbus manual Rev 7, "Commands"). `minFirmware`
 * applies when the firmware is known (Gen-2). Gen-1 doesn't report its
 * firmware, so the device's own INVALID_ID / UNSUPPORTED answer is the check
 * there. `extendedOnly` commands need the 32-bit interface (≥10v07).
 *
 * @typedef {'none' | 'u16' | 'i32' | 'u32' | 'f32'} ArgType
 * @typedef {{
 *   key: string, id: number, name: string, argType: ArgType, returnType: 'none' | 'u16' | 'i32' | 'f32',
 *   minFirmware?: string, extendedOnly?: boolean, priority: 0 | 1 | 2, timeoutMs: number, idempotent?: boolean,
 *   args?: Readonly<Record<string, number>>
 * }} CommandDef
 */

/**
 * Checked against CommandDef but keeps its literal keys, so `COMMANDS.valve` is known
 * to exist. Lookups by a name from outside go through `own()` (see `command()`).
 * @satisfies {Readonly<Record<string, CommandDef>>}
 */
const COMMANDS = Object.freeze({
    nop: { key: 'nop', id: 0, name: 'No operation', argType: 'none', returnType: 'none', priority: Priority.CONTROL, timeoutMs: 3000 },
    selectGas: { key: 'selectGas', id: 1, name: 'Select gas', idempotent: true, argType: 'u16', returnType: 'none', priority: Priority.CONTROL, timeoutMs: 3000 },
    tare: {
        key: 'tare', id: 4, name: 'Tare', argType: 'u16', returnType: 'none', priority: Priority.CONTROL, timeoutMs: 5000,
        args: Object.freeze({ gaugePressure: 0, absolutePressure: 1, flow: 2 })
    },
    resetTotalizer1: { key: 'resetTotalizer1', id: 5, name: 'Reset totalizer 1', argType: 'none', returnType: 'none', minFirmware: '7v05.0', priority: Priority.CONTROL, timeoutMs: 3000 },
    valve: {
        key: 'valve', id: 6, name: 'Valve hold / exhaust / resume', idempotent: true, argType: 'u16', returnType: 'none', priority: Priority.URGENT, timeoutMs: 3000,
        args: Object.freeze({ resume: 0, holdClosed: 1, holdCurrent: 2, exhaust: 3 })
    },
    displayLock: { key: 'displayLock', id: 7, name: 'Lock / unlock display', idempotent: true, argType: 'u16', returnType: 'none', priority: Priority.CONTROL, timeoutMs: 3000 },
    setProportionalGain: { key: 'setProportionalGain', id: 8, name: 'Set P gain', idempotent: true, argType: 'u16', returnType: 'none', priority: Priority.CONTROL, timeoutMs: 3000 },
    setDerivativeGain: { key: 'setDerivativeGain', id: 9, name: 'Set D gain', idempotent: true, argType: 'u16', returnType: 'none', priority: Priority.CONTROL, timeoutMs: 3000 },
    setIntegralGain: { key: 'setIntegralGain', id: 10, name: 'Set I gain', idempotent: true, argType: 'u16', returnType: 'none', priority: Priority.CONTROL, timeoutMs: 3000 },
    setLoopVariable: { key: 'setLoopVariable', id: 11, name: 'Set loop control variable', idempotent: true, argType: 'u16', returnType: 'none', minFirmware: '7v05.0', priority: Priority.CONTROL, timeoutMs: 3000 },
    savePowerUpSetpoint: { key: 'savePowerUpSetpoint', id: 12, name: 'Save setpoint as power-up value', idempotent: true, argType: 'none', returnType: 'none', minFirmware: '7v05.0', priority: Priority.CONTROL, timeoutMs: 3000 },
    setLoopAlgorithm: {
        key: 'setLoopAlgorithm', id: 13, name: 'Set loop algorithm', idempotent: true, argType: 'u16', returnType: 'none', minFirmware: '7v08.0', priority: Priority.CONTROL, timeoutMs: 3000,
        args: Object.freeze({ PDF: 1, PD2I: 2 })
    },
    readGain: {
        key: 'readGain', id: 14, name: 'Read control gain', idempotent: true, argType: 'u16', returnType: 'u16', minFirmware: '7v08.0', priority: Priority.CONTROL, timeoutMs: 3000,
        args: Object.freeze({ P: 0, D: 1, I: 2 })
    },
    flashDisplay: { key: 'flashDisplay', id: 20, name: 'Flash display', idempotent: true, argType: 'u16', returnType: 'none', minFirmware: '8v28.0', priority: Priority.CONTROL, timeoutMs: 3000 },
    loopControlVariable: {
        key: 'loopControlVariable', id: 43, name: 'Loop control variable (set / query)', idempotent: true, argType: 'u16', returnType: 'i32',
        minFirmware: '10v19.0', extendedOnly: true, priority: Priority.CONTROL, timeoutMs: 3000
    },
    resetTotalizer: { key: 'resetTotalizer', id: 80, name: 'Reset totalizer', argType: 'u16', returnType: 'none', minFirmware: '10v19.0', extendedOnly: true, priority: Priority.CONTROL, timeoutMs: 3000 }
});

/** Never sent, even in raw mode: factory restore, RTU-only address/watchdog, EEPROM-wearing ramp. */
const DENIED = Object.freeze(new Set([26, 32765, 32767, 65546]));

/** Status codes of the extended interface (and limited results ≥ 32769 = 0x8000 + status). */
const COMMAND_STATUS = Object.freeze({
    0: 'SUCCESS',
    1: 'IN_PROGRESS',
    2: 'INVALID_ID',
    3: 'INVALID_ARGUMENT',
    4: 'UNSUPPORTED',
    5: 'INVALID_MIX_IDX',
    6: 'INVALID_MIX_GAS',
    7: 'INVALID_MIX_PCT'
});

/** @param {number} status */
function statusName(status) {
    return COMMAND_STATUS[/** @type {keyof typeof COMMAND_STATUS} */ (status)] || `STATUS_${status}`;
}

/**
 * @param {string} key
 * @returns {CommandDef}
 */
function command(key) {
    const def = own(COMMANDS, key);
    if (!def) {
        throw new AlicatError('EINVALIDARG', `Unknown command "${key}"`);
    }
    return def;
}

/**
 * Validate a raw command (msg.command = {id, arg}).
 * @param {number} id
 * @param {number} arg
 */
function assertRawCommand(id, arg) {
    if (!Number.isInteger(id) || id < 0 || id > 0xFFFFFFFF) {
        throw new AlicatError('EINVALIDARG', `Command id must be an unsigned integer, got ${String(id)}`);
    }
    if (DENIED.has(id)) {
        throw new AlicatError('EINVALIDARG', `Command ${id} is blocked by this library (factory restore, RTU-only or EEPROM-wearing)`);
    }
    if (typeof arg !== 'number' || !Number.isFinite(arg)) {
        throw new AlicatError('EINVALIDARG', `Command argument must be a number, got ${String(arg)}`);
    }
}

module.exports = { COMMANDS, DENIED, COMMAND_STATUS, statusName, command, assertRawCommand };
