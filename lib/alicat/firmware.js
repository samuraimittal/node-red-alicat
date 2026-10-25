'use strict';

const { AlicatError } = require('../errors');
const { word } = require('./codec');

/**
 * @typedef {{major: number, minor: number, custom: number, internal?: number, text: string}} Firmware
 */

/** Minimum firmware per capability (Alicat Modbus manual Rev 7 "added in" notes). */
const FEATURES = Object.freeze({
    standardReadings: '10v07.0',
    infoBlocks: '10v07.0',
    extendedCommands: '10v07.0',
    setpointReadable: '10v07.0',
    alarmStatus: '10v07.0',
    firmwareRegisters: '10v07.0',
    deviceInfo: '10v19.0',
    testRegisters: '10v19.0',
    loopVariableQuery: '10v19.0', // command 43: set and query the loop control variable
    totalizerSelect: '10v19.0' // command 80: reset totalizer 1 or 2
});

/** @param {number} major @param {number} minor @param {number} custom */
function format(major, minor, custom) {
    return `${major}v${String(minor).padStart(2, '0')}.${custom}`;
}

/**
 * Parse an Alicat firmware string such as "10v20.0" or "8v24".
 * @param {string} text
 * @returns {Firmware}
 */
function parse(text) {
    const match = /^\s*(\d{1,3})v(\d{1,3})(?:\.(\d{1,3}))?\s*$/i.exec(String(text));
    if (!match) {
        throw new AlicatError('EINVALIDARG', `Not an Alicat firmware version: "${String(text)}"`);
    }
    const major = Number(match[1]);
    const minor = Number(match[2]);
    const custom = match[3] === undefined ? 0 : Number(match[3]);
    return { major, minor, custom, text: format(major, minor, custom) };
}

/**
 * Decode registers 1090–1093. The layout of `custom` in the version text is
 * provisional until confirmed on hardware (Gate 0, item 8).
 * @param {number[]} words [major, minor, custom, internal]
 * @returns {Firmware}
 */
function fromRegisters(words) {
    if (!Array.isArray(words) || words.length < 4) {
        throw new AlicatError('EINVALIDARG', 'Firmware decoding needs registers 1090–1093');
    }
    const major = word(words, 0);
    const minor = word(words, 1);
    const custom = word(words, 2);
    const internal = word(words, 3);
    return { major, minor, custom, internal, text: format(major, minor, custom) };
}

/**
 * @param {Firmware | string} value
 * @returns {Firmware}
 */
function normalize(value) {
    return typeof value === 'string' ? parse(value) : value;
}

/**
 * @param {Firmware | string} a
 * @param {Firmware | string} b
 * @returns {-1 | 0 | 1}
 */
function compare(a, b) {
    const x = normalize(a);
    const y = normalize(b);
    for (const key of /** @type {const} */ (['major', 'minor', 'custom'])) {
        if (x[key] !== y[key]) {
            return x[key] < y[key] ? -1 : 1;
        }
    }
    return 0;
}

/**
 * @param {Firmware | string} firmware
 * @param {Firmware | string} minimum
 */
function atLeast(firmware, minimum) {
    return compare(firmware, minimum) >= 0;
}

/**
 * @param {Firmware | string | null | undefined} firmware
 * @param {keyof typeof FEATURES} feature
 */
function supports(firmware, feature) {
    if (!Object.hasOwn(FEATURES, feature)) {
        throw new AlicatError('EINVALIDARG', `Unknown firmware feature "${feature}"`);
    }
    return firmware ? atLeast(firmware, FEATURES[feature]) : false;
}

/**
 * Positive evidence that registers 1090–1093 hold a real Gen-2 version.
 * Undefined registers can read 0xFFFF instead of raising an exception, so a
 * successful read alone proves nothing.
 * @param {number[]} words
 */
function isPlausibleGen2(words) {
    if (!Array.isArray(words) || words.length < 4 || words.slice(0, 4).some((w) => w === 0xFFFF)) {
        return false;
    }
    const major = word(words, 0);
    const minor = word(words, 1);
    return major >= 10 && major <= 30 && minor <= 99 && atLeast(fromRegisters(words), FEATURES.firmwareRegisters);
}

/** All four firmware registers read 0xFFFF — what an undefined register may return. @param {number[]} words */
function looksUndefined(words) {
    return Array.isArray(words) && words.length >= 4 && words.slice(0, 4).every((w) => w === 0xFFFF);
}

module.exports = {
    FEATURES,
    parse,
    fromRegisters,
    compare,
    atLeast,
    supports,
    isPlausibleGen2,
    looksUndefined
};
