'use strict';

const codec = require('../codec');
const { REG, STANDARD_READINGS, INFO_BLOCK, BLOCKS } = require('../registers');
const { statistic, isAbsent } = require('../statistics');
const { unitLabel } = require('../units');

/**
 * Gen-2 (≥10v07) "standard readings" profile: one fixed 26-register live block
 * (1346–1371) plus 12-register info blocks (1640–1771) that describe each
 * reading's statistic type, units, decimals and range.
 *
 * @typedef {{
 *   slot: string, key: string, type: number, name: string, category: import('../statistics').Category,
 *   reference: import('../statistics').PressureReference, unitsCode: number, units: string,
 *   decimals: number, min: number | null, max: number | null, source: number, register: number
 * }} Reading
 */

/**
 * Parse the standard info blocks into readings (absent ones omitted).
 * Output keys follow the statistic type, e.g. the primary pressure slot on unit
 * a 10v20 unit is gauge (type 6) → `gaugePressure`, the secondary is absolute → `absolutePressure`.
 * @param {number[]} words 132 registers from 1640
 * @returns {{readings: Reading[], setpointType: number}}
 */
function parseInfoBlocks(words) {
    /** @type {Reading[]} */
    const readings = [];
    const used = new Set();
    let setpointType = 0;
    STANDARD_READINGS.forEach((slot, i) => {
        const b = i * INFO_BLOCK.SIZE;
        const type = codec.u16(words, b + INFO_BLOCK.TYPE);
        if (slot === 'setpoint') {
            setpointType = type;
        }
        if (isAbsent(type)) {
            return;
        }
        const stat = statistic(type);
        let key = slot === 'setpoint' ? 'setpoint' : stat.key || slot;
        if (used.has(key)) {
            key = `${key}_${slot}`;
        }
        used.add(key);
        const unitsCode = codec.u16(words, b + INFO_BLOCK.UNITS);
        readings.push({
            slot,
            key,
            type,
            name: stat.name,
            category: stat.category,
            reference: stat.reference ?? null,
            unitsCode,
            units: unitLabel(stat.category, unitsCode, stat.reference ?? null),
            decimals: codec.u16(words, b + INFO_BLOCK.DECIMALS),
            min: codec.f32(words, b + INFO_BLOCK.MIN_FLOAT),
            max: codec.f32(words, b + INFO_BLOCK.MAX_FLOAT),
            source: codec.u16(words, b + INFO_BLOCK.SOURCE),
            register: REG.STD_FLOAT_BASE + i * 2
        });
    });
    return { readings, setpointType };
}

/**
 * Decode the live block 1346–1371.
 * @param {number[]} words
 * @param {readonly {key: string, register: number}[]} readings
 */
function decodeLive(words, readings) {
    /** @type {Record<string, number | null>} */
    const values = {};
    for (const r of readings) {
        values[r.key] = codec.f32(words, r.register - BLOCKS.STD_FLOAT.start);
    }
    return {
        values,
        alarmsRaw: codec.u16(words, 0),
        gas: codec.u16(words, 1),
        statusRaw: codec.u32(words, 2)
    };
}

module.exports = { parseInfoBlocks, decodeLive, LIVE_BLOCK: BLOCKS.STD_FLOAT, INFO_BLOCKS: BLOCKS.STD_INFO };
