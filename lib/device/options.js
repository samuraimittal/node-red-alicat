'use strict';

const { AlicatError } = require('../errors');
const legacy = require('../alicat/profiles/legacy');
const statistics = require('../alicat/statistics');
const { withDefaults } = require('../util/defaults');

/**
 * @typedef {import('./types').DeviceSettings} DeviceSettings
 * @typedef {import('./types').DeviceOptions} DeviceOptions
 */

/** Register maps a configuration may force (`auto` detects the firmware generation). */
const MAP_MODES = Object.freeze(['auto', 'modern', 'legacy']);

/** @type {Readonly<DeviceSettings>} */
const DEFAULTS = Object.freeze({
    mapMode: 'auto', // auto | modern | legacy
    deviceType: 'auto', // Gen-1 layout guess: auto | mfc | mfm | pc | pg
    layout: null, // Gen-1 preset name or ordered reading keys
    controlVariable: 'unknown', // Gen-1: what the setpoint controls (can't be read from the device)
    unitLabels: {}, // Gen-1: {key: 'SCCM', ...}
    setpointLimits: {}, // Gen-1: {variable: {min, max}}
    refreshMs: 60000,
    identifyRetryMs: 2000,
    reidentifyMinMs: 30000,
    minPollMs: 100,
    effectTimeoutMs: 1000
});

/** Settings that change how the device is decoded: changing one re-identifies it. */
const IDENTIFY_SETTINGS = Object.freeze(/** @type {(keyof DeviceSettings)[]} */ (['mapMode', 'deviceType', 'layout', 'controlVariable', 'unitLabels', 'setpointLimits']));

/**
 * Check the identification settings a configuration supplies (throws EINVALIDARG).
 * @param {{mapMode?: unknown, deviceType?: unknown, layout?: unknown, controlVariable?: unknown}} options
 */
function validateSettings(options) {
    if (options.mapMode !== undefined && !MAP_MODES.includes(/** @type {string} */ (options.mapMode))) {
        throw new AlicatError('EINVALIDARG', `mapMode must be one of ${MAP_MODES.join(', ')}, got ${String(options.mapMode)}`);
    }
    if (options.deviceType !== undefined && !legacy.DEVICE_TYPES.includes(/** @type {string} */ (options.deviceType))) {
        throw new AlicatError('EINVALIDARG', `deviceType must be one of ${legacy.DEVICE_TYPES.join(', ')}, got ${String(options.deviceType)}`);
    }
    if (options.layout) legacy.validateLayout(/** @type {string | string[]} */ (options.layout));
    if (options.controlVariable !== undefined && options.controlVariable !== 'unknown') {
        statistics.controlVariable(/** @type {string} */ (options.controlVariable));
    }
}

/**
 * The parts of a device's constructor options: unit ID, lane timings and the
 * (checked, resolved) settings.
 * @param {DeviceOptions} options
 */
function splitOptions(options) {
    const { lane, unitId, ...settings } = options;
    validateSettings(settings);
    return { unitId: unitId ?? 1, lane: lane || {}, settings: withDefaults(DEFAULTS, settings) };
}

/**
 * Whether two settings decode the device differently.
 * @param {DeviceSettings} a @param {DeviceSettings} b
 */
function identifySettingsDiffer(a, b) {
    return JSON.stringify(IDENTIFY_SETTINGS.map((k) => a[k])) !== JSON.stringify(IDENTIFY_SETTINGS.map((k) => b[k]));
}

module.exports = { DEFAULTS, MAP_MODES, validateSettings, splitOptions, identifySettingsDiffer };
