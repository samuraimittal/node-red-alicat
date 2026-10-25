'use strict';

const { AlicatError } = require('../errors');

/**
 * Alicat register NUMBERS, 1-based, exactly as printed in the Alicat Modbus
 * manual (Rev 7, Nov 2024). The on-wire PDU address is `number − 1`; convert
 * only through `toAddress()`.
 */
const REG = Object.freeze({
    // Command interface (§2.6 of the plan)
    LIMITED_COMMAND_ID: 1000, // u16 — write: command ID · read: last executed ID
    LIMITED_COMMAND_ARG: 1001, // u16 — write: argument · read: result (≥32769 = error)
    EXT_COMMAND_ID: 1002, // u32 (≥10v07)
    EXT_COMMAND_ARG: 1004, // i32/u32/f32 (≥10v07)
    EXT_COMMAND_STATUS: 1006, // u32 (≥10v07)
    EXT_COMMAND_RETURN: 1008, // i32/f32 (≥10v07)
    SETPOINT: 1010, // f32 — write-only before 10v07, R/W after
    MIX_BASE: 1050, // 5 × (gas number, percent × 100)

    // Device information and self-test (≥10v07 / ≥10v19)
    TEST_SCRATCH: 1086, // 4 bytes R/W (≥10v19)
    TEST_FIXED: 1088, // 0x3F9E064B = 1.234567 (≥10v19)
    FW_MAJOR: 1090,
    FW_MINOR: 1091,
    FW_CUSTOM: 1092,
    FW_INTERNAL: 1093,
    SERIAL: 1094, // u32 (≥10v19)
    MFG_MONTH_DAY: 1096, // month << 8 | day
    MFG_YEAR: 1097,
    CAL_MONTH_DAY: 1098,
    CAL_YEAR: 1099,

    // Optimized ("data-frame") readings — the only live block on Gen-1
    OPT_ALARM: 1199, // ≥10v07
    OPT_GAS: 1200,
    OPT_STATUS: 1201, // u32
    OPT_READING_BASE: 1203, // reading n (1-based) at 1203 + 2(n − 1), f32
    OPT_INFO_BASE: 1400, // reading n info block at 1400 + 12(n − 1) (≥10v07)

    // Standard readings — fixed layout (≥10v07)
    STD_INT_ALARM: 1296,
    STD_INT_GAS: 1297,
    STD_INT_STATUS: 1298,
    STD_INT_BASE: 1300,
    STD_FLOAT_ALARM: 1346,
    STD_FLOAT_GAS: 1347,
    STD_FLOAT_STATUS: 1348,
    STD_FLOAT_BASE: 1350,
    STD_INFO_BASE: 1640
});

/** Standard readings in register order (Gen-2, ≥10v07). */
const STANDARD_READINGS = Object.freeze([
    'setpoint',
    'valveDrive',
    'pressure',
    'pressure2',
    'barometricPressure',
    'temperature',
    'volumetricFlow',
    'massFlow',
    'totalizer1',
    'totalizer2',
    'humidity'
]);

const MAX_OPTIMIZED_READINGS = 20;

/** Offsets inside a 12-register reading info block. */
const INFO_BLOCK = Object.freeze({
    SIZE: 12,
    TYPE: 0,
    SOURCE: 1,
    MIN_INT: 2,
    MAX_INT: 4,
    MIN_FLOAT: 6,
    MAX_FLOAT: 8,
    UNITS: 10,
    DECIMALS: 11
});

/** Contiguous blocks the library reads, as {start register, quantity}. */
const BLOCKS = Object.freeze({
    LIMITED_COMMAND: Object.freeze({ start: REG.LIMITED_COMMAND_ID, quantity: 2 }),
    EXT_COMMAND: Object.freeze({ start: REG.EXT_COMMAND_ID, quantity: 8 }),
    SETPOINT: Object.freeze({ start: REG.SETPOINT, quantity: 2 }),
    TEST_FIXED: Object.freeze({ start: REG.TEST_FIXED, quantity: 2 }),
    FIRMWARE: Object.freeze({ start: REG.FW_MAJOR, quantity: 4 }),
    DEVICE_INFO: Object.freeze({ start: REG.SERIAL, quantity: 6 }),
    GEN1_HEADER: Object.freeze({ start: REG.OPT_GAS, quantity: 3 }),
    STD_FLOAT: Object.freeze({ start: REG.STD_FLOAT_ALARM, quantity: 4 + STANDARD_READINGS.length * 2 }),
    STD_INFO: Object.freeze({ start: REG.STD_INFO_BASE, quantity: STANDARD_READINGS.length * INFO_BLOCK.SIZE })
});

/**
 * Convert a 1-based register number to the 0-based PDU address.
 * @param {number} register
 */
function toAddress(register) {
    if (!Number.isInteger(register) || register < 1 || register > 0x10000) {
        throw new AlicatError('EINVALIDARG', `Register number must be an integer 1–65536, got ${String(register)}`);
    }
    return register - 1;
}

/** @param {string} name */
function standardIndex(name) {
    const index = STANDARD_READINGS.indexOf(name);
    if (index < 0) {
        throw new AlicatError('EINVALIDARG', `Unknown standard reading "${name}"`);
    }
    return index;
}

/** First register of a standard reading's float value. @param {string} name */
function standardFloatRegister(name) {
    return REG.STD_FLOAT_BASE + standardIndex(name) * 2;
}

/** First register of a standard reading's scaled-integer value. @param {string} name */
function standardIntRegister(name) {
    return REG.STD_INT_BASE + standardIndex(name) * 2;
}

/** First register of a standard reading's info block. @param {string} name */
function standardInfoRegister(name) {
    return REG.STD_INFO_BASE + standardIndex(name) * INFO_BLOCK.SIZE;
}

/** @param {number} n 1-based reading number */
function assertReadingNumber(n) {
    if (!Number.isInteger(n) || n < 1 || n > MAX_OPTIMIZED_READINGS) {
        throw new AlicatError('EINVALIDARG', `Optimized reading number must be 1–${MAX_OPTIMIZED_READINGS}, got ${String(n)}`);
    }
}

/** First register of optimized (data-frame) reading n, f32. @param {number} n */
function optimizedReadingRegister(n) {
    assertReadingNumber(n);
    return REG.OPT_READING_BASE + (n - 1) * 2;
}

/** First register of optimized reading n's info block (≥10v07). @param {number} n */
function optimizedInfoRegister(n) {
    assertReadingNumber(n);
    return REG.OPT_INFO_BASE + (n - 1) * INFO_BLOCK.SIZE;
}

module.exports = {
    REG,
    STANDARD_READINGS,
    MAX_OPTIMIZED_READINGS,
    INFO_BLOCK,
    BLOCKS,
    toAddress,
    standardFloatRegister,
    standardIntRegister,
    standardInfoRegister,
    optimizedReadingRegister,
    optimizedInfoRegister
};
