'use strict';

const { RegisterBank } = require('../RegisterBank');
const { REG, STANDARD_READINGS, MAX_OPTIMIZED_READINGS, INFO_BLOCK } = require('../../../lib/alicat/registers');
const codec = require('../../../lib/alicat/codec');

/**
 * Info-block metadata for a reading: statistic type (Appendix A), units code
 * (Appendix B), decimal places, range.
 * @typedef {{type: number, units: number, decimals: number, min: number, max: number, source?: number}} ReadingInfo
 * @typedef {{
 *   firmware: [number, number, number, number],
 *   standard: Record<string, string | null>,
 *   frame: string[],
 *   info: Record<string, ReadingInfo>,
 *   setpointInfo: Record<string, ReadingInfo>
 * }} Gen2Config
 */

const NONE_TYPE = 1;

/** Gen-2 mass flow controller, 0–20 SLPM N2, in mass-flow control. */
const MFC_10V20 = Object.freeze({
    firmware: /** @type {[number, number, number, number]} */ ([10, 20, 0, 0]),
    standard: {
        setpoint: 'setpoint', valveDrive: 'valveDrive', pressure: 'absolutePressure', pressure2: null,
        barometricPressure: 'barometricPressure', temperature: 'temperature', volumetricFlow: 'volumetricFlow',
        massFlow: 'massFlow', totalizer1: 'totalMass', totalizer2: null, humidity: null
    },
    frame: ['absolutePressure', 'temperature', 'volumetricFlow', 'massFlow', 'setpoint'],
    info: {
        valveDrive: { type: 13, units: 63, decimals: 2, min: 0, max: 100 },
        absolutePressure: { type: 2, units: 10, decimals: 2, min: 0, max: 160 },
        gaugePressure: { type: 6, units: 10, decimals: 2, min: -15, max: 160 },
        barometricPressure: { type: 15, units: 10, decimals: 2, min: 0, max: 20 },
        temperature: { type: 3, units: 2, decimals: 2, min: -10, max: 60 },
        volumetricFlow: { type: 4, units: 7, decimals: 3, min: -20, max: 20 },
        massFlow: { type: 5, units: 7, decimals: 3, min: -20, max: 20 },
        totalMass: { type: 9, units: 4, decimals: 1, min: 0, max: 9999999 }
    },
    setpointInfo: {
        massFlow: { type: 37, units: 7, decimals: 3, min: 0, max: 20 },
        volumetricFlow: { type: 36, units: 7, decimals: 3, min: 0, max: 20 },
        gaugePressure: { type: 38, units: 10, decimals: 2, min: 0, max: 160 },
        absolutePressure: { type: 34, units: 10, decimals: 2, min: 0, max: 160 },
        valveDrive: { type: 45, units: 63, decimals: 2, min: 0, max: 100 }
    }
});

/**
 * Replica of a 10v20 bench unit (10v20.0, Gate 0, 2026-10-15):
 * - primary pressure gauge, secondary absolute;
 * - 7-slot data frame;
 * - bidirectional ±2000 SCCM / ±2 LPM;
 * - valve-drive control (setpoint type 45, ±100 %);
 * - dual valve (exhaust supported).
 */
const BENCH_10V20 = Object.freeze({
    firmware: /** @type {[number, number, number, number]} */ ([10, 20, 0, 0]),
    standard: {
        setpoint: 'setpoint', valveDrive: 'valveDrive', pressure: 'gaugePressure', pressure2: 'absolutePressure',
        barometricPressure: 'barometricPressure', temperature: 'temperature', volumetricFlow: 'volumetricFlow',
        massFlow: 'massFlow', totalizer1: null, totalizer2: null, humidity: null
    },
    frame: ['absolutePressure', 'gaugePressure', 'barometricPressure', 'temperature', 'volumetricFlow', 'massFlow', 'setpoint'],
    info: {
        valveDrive: { type: 13, units: 63, decimals: 2, min: 0, max: 100 },
        absolutePressure: { type: 2, units: 10, decimals: 2, min: 0, max: 160 },
        gaugePressure: { type: 6, units: 10, decimals: 2, min: -15, max: 160 },
        barometricPressure: { type: 15, units: 10, decimals: 3, min: 0, max: 14.695948600769043 },
        temperature: { type: 3, units: 2, decimals: 2, min: -10, max: 60 },
        volumetricFlow: { type: 4, units: 7, decimals: 4, min: -2, max: 2 },
        massFlow: { type: 5, units: 12, decimals: 1, min: -2000, max: 2000 }
    },
    setpointInfo: {
        valveDrive: { type: 45, units: 63, decimals: 2, min: -100, max: 100 },
        massFlow: { type: 37, units: 12, decimals: 1, min: -2000, max: 2000 },
        volumetricFlow: { type: 36, units: 7, decimals: 4, min: -2, max: 2 },
        gaugePressure: { type: 38, units: 10, decimals: 2, min: -15, max: 160 },
        absolutePressure: { type: 34, units: 10, decimals: 2, min: 0, max: 160 }
    }
});

/**
 * Build the register map of a Gen-2 (≥10v07) instrument over Modbus TCP.
 * @param {InstanceType<typeof import('../DeviceModel').DeviceModel>} model
 * @param {Gen2Config} config
 * @param {{serial?: number | undefined, undefinedValue?: number | null}} [options]
 */
function buildGen2(model, config, options = {}) {
    const bank = new RegisterBank({ undefinedValue: options.undefinedValue ?? null });

    // Setpoint: must be written as one pair; reads back the applied (clamped) value.
    bank.group(REG.SETPOINT, 2, (words) => model.setSetpoint(codec.f32(words, 0)));
    bank.defineRange(REG.MIX_BASE, 10, { writable: true });

    // Device information and self-test registers (≥10v19).
    bank.defineRange(REG.TEST_SCRATCH, 2, { writable: true });
    bank.define(REG.TEST_FIXED, codec.FIXED_TEST_BITS >>> 16);
    bank.define(REG.TEST_FIXED + 1, codec.FIXED_TEST_BITS & 0xFFFF);
    config.firmware.forEach((w, i) => bank.define(REG.FW_MAJOR + i, w));
    const serial = options.serial ?? 123456;
    bank.define(REG.SERIAL, Math.floor(serial / 0x10000));
    bank.define(REG.SERIAL + 1, serial % 0x10000);
    bank.define(REG.MFG_MONTH_DAY, (5 << 8) | 17);
    bank.define(REG.MFG_YEAR, 2023);
    bank.define(REG.CAL_MONTH_DAY, (1 << 8) | 9);
    bank.define(REG.CAL_YEAR, 2024);

    // Optimized (data-frame) block: float and integer mirrors, plus info blocks.
    bank.defineRange(REG.OPT_ALARM, 4 + MAX_OPTIMIZED_READINGS * 2); // 1199–1242
    bank.defineRange(1246, 4 + MAX_OPTIMIZED_READINGS * 2); // 1246–1289
    bank.defineRange(REG.OPT_INFO_BASE, MAX_OPTIMIZED_READINGS * INFO_BLOCK.SIZE);

    // Standard block: integer and float mirrors (setpoint R/W in both), info blocks.
    bank.defineRange(REG.STD_INT_ALARM, 4 + STANDARD_READINGS.length * 2);
    bank.defineRange(REG.STD_FLOAT_ALARM, 4 + STANDARD_READINGS.length * 2);
    bank.defineRange(REG.STD_INFO_BASE, STANDARD_READINGS.length * INFO_BLOCK.SIZE);
    bank.group(REG.STD_FLOAT_BASE, 2, (words) => model.setSetpoint(codec.f32(words, 0)));
    bank.group(REG.STD_INT_BASE, 2, (words) => {
        const raw = codec.i32Reading(words, 0);
        const info = config.setpointInfo[model.controlVariable];
        model.setSetpoint(raw === null || !info ? null : raw / 10 ** info.decimals);
    });

    /** @param {string | null | undefined} key */
    const infoFor = (key) => (key === 'setpoint' ? config.setpointInfo[model.controlVariable] || null : key ? config.info[key] || null : null);

    /** @param {number} start @param {ReadingInfo | null} info */
    function writeInfo(start, info) {
        bank.set(start + INFO_BLOCK.TYPE, info ? info.type : NONE_TYPE);
        bank.set(start + INFO_BLOCK.SOURCE, info ? (info.source ?? 2) : 0);
        bank.setI32(start + INFO_BLOCK.MIN_INT, info ? Math.round(info.min * 10 ** info.decimals) : null);
        bank.setI32(start + INFO_BLOCK.MAX_INT, info ? Math.round(info.max * 10 ** info.decimals) : null);
        bank.setFloat(start + INFO_BLOCK.MIN_FLOAT, info ? info.min : null);
        bank.setFloat(start + INFO_BLOCK.MAX_FLOAT, info ? info.max : null);
        bank.set(start + INFO_BLOCK.UNITS, info ? info.units : 0);
        bank.set(start + INFO_BLOCK.DECIMALS, info ? info.decimals : 0);
    }

    /** Rewrite info blocks (they change when the control variable changes). */
    function refreshInfo() {
        STANDARD_READINGS.forEach((slot, i) => writeInfo(REG.STD_INFO_BASE + i * INFO_BLOCK.SIZE, infoFor(config.standard[slot])));
        for (let n = 0; n < MAX_OPTIMIZED_READINGS; n++) {
            writeInfo(REG.OPT_INFO_BASE + n * INFO_BLOCK.SIZE, infoFor(config.frame[n] || null));
        }
    }

    /** Copy the model's current state into every live register block. */
    function refresh() {
        model.advance();
        const s = model.state;
        bank.setFloat(REG.SETPOINT, s.setpoint);
        for (const base of [REG.OPT_ALARM, 1246, REG.STD_INT_ALARM, REG.STD_FLOAT_ALARM]) {
            bank.set(base, s.alarms);
            bank.set(base + 1, s.gas);
            bank.setU32(base + 2, model.status);
        }
        STANDARD_READINGS.forEach((slot, i) => {
            const key = config.standard[slot];
            const info = infoFor(key);
            const value = info ? model.reading(key) : null;
            bank.setFloat(REG.STD_FLOAT_BASE + i * 2, value);
            bank.setI32(REG.STD_INT_BASE + i * 2, value === null || !info ? null : Math.round(value * 10 ** info.decimals));
        });
        for (let n = 0; n < MAX_OPTIMIZED_READINGS; n++) {
            const key = config.frame[n] || null;
            const info = infoFor(key);
            const value = info ? model.reading(key) : null;
            bank.setFloat(REG.OPT_READING_BASE + n * 2, value);
            bank.setI32(1250 + n * 2, value === null || !info ? null : Math.round(value * 10 ** info.decimals));
        }
    }

    refreshInfo();
    refresh();
    return { bank, refresh, refreshInfo, generation: 2 };
}

module.exports = { buildGen2, MFC_10V20, BENCH_10V20 };
