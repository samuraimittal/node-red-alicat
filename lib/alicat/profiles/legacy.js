'use strict';

const { AlicatError } = require('../../errors');
const codec = require('../codec');
const { REG, MAX_OPTIMIZED_READINGS } = require('../registers');
const { STATISTICS } = require('../statistics');
const { own } = require('../../util/own');

/**
 * Gen-1 (6v17–10v06) "data-frame" profile. The device only exposes gas
 * (1200), status (1201–1202) and N float slots from 1203. It has no units or
 * info blocks, and a missing slot raises exception 02 over TCP. What each slot
 * means depends on the device's data frame, so it comes from a preset or a
 * custom layout.
 */

/** Slot keys a layout may use, with their category and pressure reference. */
const SLOT_KEYS = Object.freeze({
    pressure: { category: 'pressure', reference: null },
    absolutePressure: { category: 'pressure', reference: 'absolute' },
    gaugePressure: { category: 'pressure', reference: 'gauge' },
    differentialPressure: { category: 'pressure', reference: 'differential' },
    barometricPressure: { category: 'pressure', reference: 'barometric' },
    temperature: { category: 'temperature', reference: null },
    volumetricFlow: { category: 'volumetricFlow', reference: null },
    massFlow: { category: 'massFlow', reference: null },
    totalMass: { category: 'totalMass', reference: null },
    totalVolume: { category: 'totalVolume', reference: null },
    valveDrive: { category: 'percent', reference: null },
    relativeHumidity: { category: 'percent', reference: null },
    setpoint: { category: 'none', reference: null }
});

/**
 * Presets. The default frames come from the legacy Modbus manual's device-type
 * tables. 'extended-7' is the frame found on both bench units (10v20 serial
 * a 10v20 and a 9v07) and in the production flow.
 */
const LAYOUT_PRESETS = Object.freeze({
    'extended-7': Object.freeze(['absolutePressure', 'gaugePressure', 'barometricPressure', 'temperature', 'volumetricFlow', 'massFlow', 'setpoint']),
    'mfc': Object.freeze(['absolutePressure', 'temperature', 'volumetricFlow', 'massFlow', 'setpoint']),
    'mfc-totalizer': Object.freeze(['absolutePressure', 'temperature', 'volumetricFlow', 'massFlow', 'setpoint', 'totalMass']),
    'mfm': Object.freeze(['absolutePressure', 'temperature', 'volumetricFlow', 'massFlow']),
    'mfm-totalizer': Object.freeze(['absolutePressure', 'temperature', 'volumetricFlow', 'massFlow', 'totalMass']),
    'pc': Object.freeze(['pressure', 'setpoint']),
    'pg': Object.freeze(['pressure'])
});

/** deviceType → presets it can mean, by slot count. */
const DEVICE_TYPE_PRESETS = Object.freeze({
    mfc: ['mfc', 'mfc-totalizer'],
    mfm: ['mfm', 'mfm-totalizer'],
    pc: ['pc'],
    pg: ['pg'],
    auto: ['pg', 'pc', 'mfm', 'mfc-totalizer'] // 5 slots is ambiguous (MFC or MFM + totalizer)
});

/**
 * @param {string | string[] | null | undefined} layout preset name or ordered keys
 */
function validateLayout(layout) {
    const keys = typeof layout === 'string' ? own(/** @type {Record<string, readonly string[]>} */ (LAYOUT_PRESETS), layout) : layout;
    if (!Array.isArray(keys) || keys.length === 0 || keys.length > MAX_OPTIMIZED_READINGS) {
        throw new AlicatError('EINVALIDARG',
            `Layout must be a preset (${Object.keys(LAYOUT_PRESETS).join(', ')}) or a list of 1–${MAX_OPTIMIZED_READINGS} reading names`);
    }
    const seen = new Set();
    for (const key of keys) {
        if (!Object.hasOwn(SLOT_KEYS, key)) {
            throw new AlicatError('EINVALIDARG', `Unknown reading "${key}" in layout. Use: ${Object.keys(SLOT_KEYS).join(', ')}`);
        }
        if (seen.has(key)) {
            throw new AlicatError('EINVALIDARG', `Reading "${key}" appears twice in the layout`);
        }
        seen.add(key);
    }
    return [...keys];
}

/**
 * Decide the slot layout from configuration and the probed slot count.
 * @param {{layout?: string | string[] | null, deviceType?: string}} config
 * @param {number} count
 * @returns {string[]}
 */
function resolveLayout(config, count) {
    if (config.layout) {
        const keys = validateLayout(config.layout);
        if (keys.length !== count) {
            throw new AlicatError('EIDENTIFY', `The configured layout has ${keys.length} slots but the device reports ${count}`);
        }
        return keys;
    }
    const type = config.deviceType || 'auto';
    const candidates = own(/** @type {Record<string, string[]>} */ (DEVICE_TYPE_PRESETS), type);
    if (!candidates) {
        throw new AlicatError('EINVALIDARG', `Unknown device type "${type}"`);
    }
    /** @type {(readonly string[])[]} */
    const match = [];
    for (const preset of candidates) {
        const keys = own(/** @type {Record<string, readonly string[]>} */ (LAYOUT_PRESETS), preset);
        if (keys && keys.length === count) match.push(keys);
    }
    const [only] = match;
    if (match.length === 1 && only) {
        return [...only];
    }
    throw new AlicatError('EIDENTIFY', count === 5 && type === 'auto'
        ? 'The device reports 5 data-frame slots, which can be a flow controller or a meter with totalizer: set the device type'
        : `The device reports ${count} data-frame slots; set a custom layout (for example preset "extended-7")`);
}

/**
 * @param {number[]} words 1200 … 1202 + 2N
 * @param {string[]} layout
 */
function decodeLive(words, layout) {
    /** @type {Record<string, number | null>} */
    const values = {};
    layout.forEach((key, i) => {
        values[key] = codec.f32(words, 3 + i * 2);
    });
    return { values, gas: codec.u16(words, 0), statusRaw: codec.u32(words, 1) };
}

/** @param {number} count */
function liveBlock(count) {
    return { start: REG.OPT_GAS, quantity: 3 + count * 2 };
}

/** @param {string} key */
function slotInfo(key) {
    const info = own(/** @type {Record<string, {category: import('../statistics').Category, reference: import('../statistics').PressureReference}>} */ (SLOT_KEYS), key);
    if (!info) {
        throw new AlicatError('EINVALIDARG', `Unknown reading "${key}" in layout`);
    }
    return info;
}

/** Device types a configuration may name (`auto` guesses from the slot count). */
const DEVICE_TYPES = Object.freeze(Object.keys(DEVICE_TYPE_PRESETS));

module.exports = { SLOT_KEYS, LAYOUT_PRESETS, DEVICE_TYPES, validateLayout, resolveLayout, decodeLive, liveBlock, slotInfo, STATISTICS };
