'use strict';

const { AlicatError } = require('../errors');
const { own } = require('../util/own');

/**
 * Statistic type codes (Alicat Modbus manual Rev 7, Appendix A), as reported in
 * a reading's info block. `key` is the library's output name; `category` picks
 * the units table; `setpointFor` marks setpoint types and names the variable
 * they control. Type 0 is not in Appendix A but is what 10v20 hardware reports
 * for absent readings (Gate 0), so it is treated like 1 = None.
 *
 * @typedef {'none' | 'pressure' | 'temperature' | 'massFlow' | 'volumetricFlow' | 'totalMass' | 'totalVolume' | 'percent'} Category
 * @typedef {'absolute' | 'gauge' | 'differential' | 'barometric' | null} PressureReference
 * @typedef {{code: number, key: string | null, name: string, category: Category,
 *            reference?: PressureReference, setpointFor?: string}} Statistic
 */

/** @type {Readonly<Record<number, Statistic>>} */
const STATISTICS = Object.freeze({
    0: { code: 0, key: null, name: 'None', category: 'none' },
    1: { code: 1, key: null, name: 'None', category: 'none' },
    2: { code: 2, key: 'absolutePressure', name: 'Pressure, absolute', category: 'pressure', reference: 'absolute' },
    3: { code: 3, key: 'temperature', name: 'Temperature, stream', category: 'temperature' },
    4: { code: 4, key: 'volumetricFlow', name: 'Volumetric flow', category: 'volumetricFlow' },
    5: { code: 5, key: 'massFlow', name: 'Mass flow', category: 'massFlow' },
    6: { code: 6, key: 'gaugePressure', name: 'Pressure, gauge', category: 'pressure', reference: 'gauge' },
    7: { code: 7, key: 'differentialPressure', name: 'Pressure, differential', category: 'pressure', reference: 'differential' },
    8: { code: 8, key: 'totalVolume', name: 'Total volume', category: 'totalVolume' },
    9: { code: 9, key: 'totalMass', name: 'Total mass', category: 'totalMass' },
    13: { code: 13, key: 'valveDrive', name: 'Valve drive', category: 'percent' },
    15: { code: 15, key: 'barometricPressure', name: 'Pressure, barometric', category: 'pressure', reference: 'barometric' },
    25: { code: 25, key: 'relativeHumidity', name: 'Relative humidity', category: 'percent' },
    34: { code: 34, key: 'setpoint', name: 'Pressure, absolute setpoint', category: 'pressure', reference: 'absolute', setpointFor: 'absolutePressure' },
    36: { code: 36, key: 'setpoint', name: 'Volumetric flow setpoint', category: 'volumetricFlow', setpointFor: 'volumetricFlow' },
    37: { code: 37, key: 'setpoint', name: 'Mass flow setpoint', category: 'massFlow', setpointFor: 'massFlow' },
    38: { code: 38, key: 'setpoint', name: 'Pressure, gauge setpoint', category: 'pressure', reference: 'gauge', setpointFor: 'gaugePressure' },
    39: { code: 39, key: 'setpoint', name: 'Pressure, differential setpoint', category: 'pressure', reference: 'differential', setpointFor: 'differentialPressure' },
    45: { code: 45, key: 'setpoint', name: 'Valve drive setpoint', category: 'percent', setpointFor: 'valveDrive' },
    344: { code: 344, key: 'absolutePressure2', name: 'Pressure, second absolute', category: 'pressure', reference: 'absolute' },
    345: { code: 345, key: 'setpoint', name: 'Pressure, second absolute setpoint', category: 'pressure', reference: 'absolute', setpointFor: 'absolutePressure2' },
    352: { code: 352, key: 'gaugePressure2', name: 'Pressure, second gauge', category: 'pressure', reference: 'gauge' },
    353: { code: 353, key: 'setpoint', name: 'Pressure, second gauge setpoint', category: 'pressure', reference: 'gauge', setpointFor: 'gaugePressure2' },
    360: { code: 360, key: 'differentialPressure2', name: 'Pressure, second differential', category: 'pressure', reference: 'differential' },
    361: { code: 361, key: 'setpoint', name: 'Pressure, second differential setpoint', category: 'pressure', reference: 'differential', setpointFor: 'differentialPressure2' }
});

/**
 * Variables the setpoint can control, with the argument for commands 11 / 43
 * and the setpoint statistic type the device reports in that mode.
 * Valve drive is selected by its Appendix A code (45), which command 11
 * accepts from firmware 8v24.0.
 * @typedef {{loopArg: number, setpointType: number, label: string, minFirmware?: string}} ControlVariableDef
 * @satisfies {Readonly<Record<string, Readonly<ControlVariableDef>>>}
 */
const CONTROL_VARIABLES = Object.freeze({
    massFlow: Object.freeze({ loopArg: 0, setpointType: 37, label: 'Mass flow' }),
    volumetricFlow: Object.freeze({ loopArg: 1, setpointType: 36, label: 'Volumetric flow' }),
    differentialPressure: Object.freeze({ loopArg: 2, setpointType: 39, label: 'Differential pressure' }),
    absolutePressure: Object.freeze({ loopArg: 3, setpointType: 34, label: 'Absolute pressure' }),
    gaugePressure: Object.freeze({ loopArg: 4, setpointType: 38, label: 'Gauge pressure' }),
    valveDrive: Object.freeze({ loopArg: 45, setpointType: 45, label: 'Valve drive', minFirmware: '8v24.0' })
});

/** Legacy loop-variable arguments 0–4 → variable. */
const LOOP_ARG_TO_VARIABLE = Object.freeze(['massFlow', 'volumetricFlow', 'differentialPressure', 'absolutePressure', 'gaugePressure']);

/** @param {number} code */
function statistic(code) {
    return STATISTICS[code] || { code, key: `statistic${code}`, name: `Statistic ${code}`, category: /** @type {Category} */ ('none') };
}

/** Type 0/1 = empty slot. @param {number} code */
function isAbsent(code) {
    return code === 0 || code === 1;
}

/** @param {number} code */
function isKnown(code) {
    return Object.hasOwn(STATISTICS, code);
}

/**
 * The controlled variable from a setpoint info type, or null (meter / unknown).
 * @param {number} setpointType
 * @returns {string | null}
 */
function controlledVariableFromSetpointType(setpointType) {
    const s = STATISTICS[setpointType];
    return s && s.setpointFor ? s.setpointFor : null;
}

/**
 * Decode the answer of a loop-control-variable query (command 43). 10v20
 * answers in Appendix A codes (45 = valve drive); 0–4 are accepted as well.
 * @param {number} value
 */
function controlledVariableFromLoopValue(value) {
    if (Number.isInteger(value) && value >= 0 && value < LOOP_ARG_TO_VARIABLE.length) {
        return LOOP_ARG_TO_VARIABLE[value];
    }
    return controlledVariableFromSetpointType(value);
}

/**
 * @param {string} variable
 * @returns {Readonly<ControlVariableDef>}
 */
function controlVariable(variable) {
    const def = own(/** @type {Readonly<Record<string, Readonly<ControlVariableDef>>>} */ (CONTROL_VARIABLES), variable);
    if (!def) {
        throw new AlicatError('EINVALIDARG',
            `Unknown control variable "${variable}". Use one of: ${Object.keys(CONTROL_VARIABLES).join(', ')}`);
    }
    return def;
}

module.exports = {
    STATISTICS,
    CONTROL_VARIABLES,
    LOOP_ARG_TO_VARIABLE,
    statistic,
    isAbsent,
    isKnown,
    controlledVariableFromSetpointType,
    controlledVariableFromLoopValue,
    controlVariable
};
