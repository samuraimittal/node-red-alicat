'use strict';

/**
 * Engineering-unit codes (Alicat Modbus manual Rev 7, Appendix B). The same
 * code means different units in different tables (7 = SLPM for mass flow,
 * LPM for volumetric flow, bar for pressure), so a reading's statistic
 * category selects the table.
 */

const COMMON = Object.freeze({ 0: '', 1: '', 62: 'count', 63: '%FS' });

/** B-1 standard/normal flow and B-2 true mass flow (disjoint codes). */
const MASS_FLOW = Object.freeze({
    ...COMMON,
    2: 'SµL/m', 3: 'SmL/s', 4: 'SmL/m', 5: 'SmL/h', 6: 'SL/s', 7: 'SLPM', 8: 'SL/h',
    11: 'SCCS', 12: 'SCCM', 13: 'Scm³/h', 14: 'Sm³/m', 15: 'Sm³/h', 16: 'Sm³/d', 17: 'Sin³/m',
    18: 'SCFM', 19: 'SCFH', 20: 'kSCFM', 21: 'SCFD',
    32: 'NµL/m', 33: 'NmL/s', 34: 'NmL/m', 35: 'NmL/h', 36: 'NL/s', 37: 'NLPM', 38: 'NL/h',
    41: 'NCCS', 42: 'NCCM', 43: 'Ncm³/h', 44: 'Nm³/m', 45: 'Nm³/h', 46: 'Nm³/d',
    64: 'mg/s', 65: 'mg/m', 66: 'g/s', 67: 'g/m', 68: 'g/h', 69: 'kg/m', 70: 'kg/h',
    71: 'oz/s', 72: 'oz/m', 73: 'lb/m', 74: 'lb/h'
});

/** B-4 volumetric flow. */
const VOLUMETRIC_FLOW = Object.freeze({
    ...COMMON,
    2: 'µL/m', 3: 'mL/s', 4: 'mL/m', 5: 'mL/h', 6: 'L/s', 7: 'LPM', 8: 'L/h', 9: 'US GPM', 10: 'US GPH',
    11: 'CCS', 12: 'CCM', 13: 'cm³/h', 14: 'm³/m', 15: 'm³/h', 16: 'm³/d', 17: 'in³/m', 18: 'CFM', 19: 'CFH', 21: 'CFD'
});

/** B-3 total standard/normal volume (totalizers of mass flow). */
const TOTAL_MASS = Object.freeze({
    0: '', 1: '',
    2: 'SµL', 3: 'SmL', 4: 'SL', 6: 'Scm³', 7: 'Sm³', 8: 'Sin³', 9: 'Sft³', 10: 'kSft³',
    32: 'NµL', 33: 'NmL', 34: 'NL', 36: 'Ncm³', 37: 'Nm³'
});

/** B-5 total volume. */
const TOTAL_VOLUME = Object.freeze({
    0: '', 1: '', 2: 'µL', 3: 'mL', 4: 'L', 5: 'US gal', 6: 'cm³', 7: 'm³', 8: 'in³', 9: 'ft³'
});

/** B-6 pressure. */
const PRESSURE = Object.freeze({
    ...COMMON,
    2: 'Pa', 3: 'hPa', 4: 'kPa', 5: 'MPa', 6: 'mbar', 7: 'bar', 8: 'g/cm²', 9: 'kg/cm²', 10: 'PSI', 11: 'PSF',
    12: 'mTorr', 13: 'torr', 14: 'mmHg', 15: 'inHg', 16: 'mmH₂O (4 °C)', 17: 'mmH₂O (60 °F)',
    18: 'cmH₂O (4 °C)', 19: 'cmH₂O (60 °F)', 20: 'inH₂O (4 °C)', 21: 'inH₂O (60 °F)', 22: 'atm', 61: 'V'
});

/** B-7 temperature. */
const TEMPERATURE = Object.freeze({ 0: '', 1: '', 2: '°C', 3: '°F', 4: 'K', 5: '°Ra' });

const PERCENT = Object.freeze({ ...COMMON, 63: '%' });

/** @type {Readonly<Record<import('./statistics').Category, Readonly<Record<number, string>>>>} */
const TABLES = Object.freeze({
    none: COMMON,
    massFlow: MASS_FLOW,
    volumetricFlow: VOLUMETRIC_FLOW,
    totalMass: TOTAL_MASS,
    totalVolume: TOTAL_VOLUME,
    pressure: PRESSURE,
    temperature: TEMPERATURE,
    percent: PERCENT
});

const PSI_SUFFIX = Object.freeze({ absolute: 'PSIA', gauge: 'PSIG', differential: 'PSID', barometric: 'PSIA' });
const REFERENCE_SUFFIX = Object.freeze({ absolute: ' abs', gauge: ' g', differential: ' d', barometric: ' abs' });

/**
 * Display label for a units code, e.g. (pressure, 10, gauge) → 'PSIG'.
 * @param {import('./statistics').Category} category
 * @param {number} code
 * @param {import('./statistics').PressureReference} [reference]
 */
function unitLabel(category, code, reference = null) {
    const table = TABLES[category] || COMMON;
    const base = table[code];
    if (base === undefined) {
        return `units#${code}`;
    }
    if (category === 'pressure' && reference && base) {
        return base === 'PSI' ? PSI_SUFFIX[reference] : `${base}${REFERENCE_SUFFIX[reference]}`;
    }
    return base;
}

module.exports = { TABLES, unitLabel };
