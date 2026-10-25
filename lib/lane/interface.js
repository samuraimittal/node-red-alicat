'use strict';

const { AlicatError } = require('../errors');
const { REG } = require('../alicat/registers');
const codec = require('../alicat/codec');

/**
 * The device's two command interfaces. Extended (≥10v07): 32-bit ID and
 * argument at 1002–1005, with status and return value in the echo (1006–1009).
 * Limited (all firmware): 16-bit ID and argument at 1000–1001; the echo is the
 * last ID and a result, where ≥ 0x8001 means the command was refused.
 *
 * @typedef {import('../CommandLane').ArgType} ArgType
 * @typedef {import('../CommandLane').CommandSpec} CommandSpec
 * @typedef {{id: number, arg: number, status: number, ret: [number, number], result: number}} Echo
 *   The command registers as read back.
 * @typedef {{rejected: number} | {returnValue: number | null}} Completion
 *   A finished command: refused with a device status, or done with its return value.
 * @typedef {{
 *   name: 'extended' | 'limited',
 *   register: number,
 *   echoQuantity: number,
 *   encode(id: number, arg: number, argType: ArgType): number[],
 *   decodeEcho(words: number[]): Echo,
 *   isOurs(echo: Echo, id: number, words: number[]): boolean,
 *   isRunning(echo: Echo): boolean,
 *   complete(echo: Echo, returnType: CommandSpec['returnType']): Completion
 * }} CommandInterface
 */

/** Extended status: the command is still running. */
const IN_PROGRESS = 1;
/** Limited results above this are 0x8000 + device status − 1. */
const LIMITED_ERROR_BASE = 0x8000;

/** @type {CommandInterface} */
const EXTENDED = Object.freeze({
    name: 'extended',
    register: REG.EXT_COMMAND_ID,
    echoQuantity: 8,
    encode(id, arg, argType) {
        /** @type {[number, number]} */
        let argWords;
        if (argType === 'f32') argWords = codec.encodeF32(arg);
        else if (argType === 'i32' || arg < 0) argWords = codec.encodeI32(arg);
        else argWords = codec.encodeU32(arg);
        return [...codec.encodeU32(id), ...argWords];
    },
    decodeEcho(w) {
        return { id: codec.u32(w, 0), arg: codec.u32(w, 2), status: codec.u32(w, 4), ret: [codec.u16(w, 6), codec.u16(w, 7)], result: 0 };
    },
    isOurs(echo, id, words) {
        return echo.id === id && echo.arg === codec.u32(words, 2);
    },
    isRunning(echo) {
        return echo.status === IN_PROGRESS;
    },
    complete(echo, returnType) {
        if (echo.status !== 0) return { rejected: echo.status };
        if (!returnType || returnType === 'none') return { returnValue: null };
        return { returnValue: returnType === 'f32' ? codec.f32(echo.ret, 0) : codec.i32(echo.ret, 0) };
    }
});

/** @type {CommandInterface} */
const LIMITED = Object.freeze({
    name: 'limited',
    register: REG.LIMITED_COMMAND_ID,
    echoQuantity: 2,
    encode(id, arg) {
        if (!Number.isInteger(id) || id < 0 || id > 0xFFFF || !Number.isInteger(arg) || arg < 0 || arg > 0xFFFF) {
            throw new AlicatError('EINVALIDARG',
                `Command ${id} with argument ${arg} needs the extended 32-bit command interface (firmware ≥ 10v07)`, { outcome: 'not-sent' });
        }
        return [id, arg];
    },
    decodeEcho(w) {
        return { id: codec.u16(w, 0), arg: 0, status: 0, ret: [0, 0], result: codec.u16(w, 1) };
    },
    isOurs(echo, id) {
        return echo.id === (id & 0xFFFF);
    },
    isRunning() {
        return false; // the limited echo has no status: a command shows only once it finished
    },
    complete(echo, returnType) {
        // 0x8001 = INVALID_ID (status 2), 0x8002 = INVALID_ARGUMENT (3), 0x8003 = UNSUPPORTED (4)…
        // Confirmed on 9v07: an unsupported loop variable answers 0x8002.
        if (echo.result > LIMITED_ERROR_BASE) return { rejected: echo.result - LIMITED_ERROR_BASE + 1 };
        return { returnValue: returnType && returnType !== 'none' ? echo.result : null };
    }
});

module.exports = { EXTENDED, LIMITED, IN_PROGRESS };
