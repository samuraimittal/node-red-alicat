'use strict';

/**
 * Device status bit fields (registers 1201–1202 / 1348–1349), one table per
 * generation. Bit 10 is EXHAUST on both: verified on 10v20 hardware, where it
 * sets on command 6,3 and clears on 6,0. The Rev 7 manual's "pressure over user
 * limit" is wrong for that firmware. Bits 11–13 are still unverified on
 * hardware, and `raw` is always reported.
 */
const BITS = Object.freeze({
    gen2: Object.freeze([
        'temperatureOverrange', 'temperatureUnderrange', 'volumetricFlowOverrange', 'volumetricFlowUnderrange',
        'massFlowOverrange', 'massFlowUnderrange', 'pressureOverrange', 'totalizerAtMax', 'holding',
        'hardwareError', 'exhausting', 'flowOverrangeWhileTotalizing'
    ]),
    gen1: Object.freeze([
        'temperatureOverrange', 'temperatureUnderrange', 'volumetricFlowOverrange', 'volumetricFlowUnderrange',
        'massFlowOverrange', 'massFlowUnderrange', 'pressureOverrange', 'totalizerAtMax', 'holding',
        'hardwareError', 'exhausting', 'overPressureLimit', 'flowOverrangeWhileTotalizing', 'measurementAborted'
    ])
});

const HOLDING_BIT = 8;
const EXHAUSTING_BIT = 10;

/**
 * @param {number} raw u32 status
 * @param {'gen1' | 'gen2'} generation
 * @returns {{raw: number, active: string[], flags: Record<string, boolean>, unknownBits: number[]}}
 */
function decodeStatus(raw, generation) {
    const names = BITS[generation];
    /** @type {Record<string, boolean>} */
    const flags = {};
    /** @type {string[]} */
    const active = [];
    /** @type {number[]} */
    const unknownBits = [];
    names.forEach((name, bit) => {
        const set = ((raw >>> bit) & 1) === 1;
        flags[name] = set;
        if (set) active.push(name);
    });
    for (let bit = names.length; bit < 32; bit++) {
        if ((raw >>> bit) & 1) unknownBits.push(bit);
    }
    return { raw: raw >>> 0, active, flags, unknownBits };
}

/** Alarm output status (Gen-2 only): +1 alarm 1, +2 alarm 2. @param {number} raw */
function decodeAlarms(raw) {
    return { raw, alarm1: (raw & 1) === 1, alarm2: (raw & 2) === 2 };
}

/**
 * Whether the status bits show the valve in the state a valve command asks for:
 * `resume` = neither holding nor exhausting, `exhaust` = exhausting, a hold = holding.
 * @param {Record<string, boolean>} flags decoded status flags
 * @param {'resume' | 'holdClosed' | 'holdCurrent' | 'exhaust'} action
 */
function isValveState(flags, action) {
    if (action === 'resume') return flags.holding !== true && flags.exhausting !== true;
    if (action === 'exhaust') return flags.exhausting === true;
    return flags.holding === true;
}

module.exports = { BITS, HOLDING_BIT, EXHAUSTING_BIT, decodeStatus, decodeAlarms, isValveState };
