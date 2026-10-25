'use strict';

const { AlicatError } = require('../errors');

/**
 * Gas select numbers (Alicat Modbus manual Rev 7, Appendix D).
 * 236–255 are COMPOSER user mixes. Some gases (30–36, 80–86) need
 * corrosion-resistant hardware, and the device rejects unsupported gases.
 */
/** @type {ReadonlyArray<[number, string, string]>} */
const GAS_TABLE = Object.freeze([
    [0, 'Air', 'Air (clean dry)'], [1, 'Ar', 'Argon'], [2, 'CH4', 'Methane'], [3, 'CO', 'Carbon monoxide'],
    [4, 'CO2', 'Carbon dioxide'], [5, 'C2H6', 'Ethane'], [6, 'H2', 'Hydrogen'], [7, 'He', 'Helium'],
    [8, 'N2', 'Nitrogen'], [9, 'N2O', 'Nitrous oxide'], [10, 'Ne', 'Neon'], [11, 'O2', 'Oxygen'],
    [12, 'C3H8', 'Propane'], [13, 'nC4H10', 'Normal butane'], [14, 'C2H2', 'Acetylene'], [15, 'C2H4', 'Ethylene'],
    [16, 'iC4H10', 'Isobutane'], [17, 'Kr', 'Krypton'], [18, 'Xe', 'Xenon'], [19, 'SF6', 'Sulfur hexafluoride'],
    [20, 'C-25', '25% CO2, 75% Ar'], [21, 'C-10', '10% CO2, 90% Ar'], [22, 'C-8', '8% CO2, 92% Ar'],
    [23, 'C-2', '2% CO2, 98% Ar'], [24, 'C-75', '75% CO2, 25% Ar'], [25, 'He-25', '25% He, 75% Ar'],
    [26, 'He-75', '75% He, 25% Ar'], [27, 'A1025', '90% He, 7.5% Ar, 2.5% CO2'],
    [28, 'Star29', 'Stargon CS (90% Ar, 8% CO2, 2% O2)'], [29, 'P-5', '5% CH4, 95% Ar'],
    [30, 'NO', 'Nitric oxide'], [31, 'NF3', 'Nitrogen trifluoride'], [32, 'NH3', 'Ammonia'], [33, 'Cl2', 'Chlorine'],
    [34, 'H2S', 'Hydrogen sulfide'], [35, 'SO2', 'Sulfur dioxide'], [36, 'C3H6', 'Propylene'],
    [80, '1Buten', '1-Butylene'], [81, 'cButen', 'cis-2-Butene'], [82, 'iButen', 'Isobutene'],
    [83, 'tButen', 'trans-2-Butene'], [84, 'COS', 'Carbonyl sulfide'], [85, 'DME', 'Dimethyl ether'], [86, 'SiH4', 'Silane'],
    [100, 'R-11', 'Trichlorofluoromethane'], [101, 'R-115', 'Chloropentafluoroethane'], [102, 'R-116', 'Hexafluoroethane'],
    [103, 'R-124', 'Chlorotetrafluoroethane'], [104, 'R-125', 'Pentafluoroethane'], [105, 'R-134A', 'Tetrafluoroethane'],
    [106, 'R-14', 'Tetrafluoromethane'], [107, 'R-142b', 'Chlorodifluoroethane'], [108, 'R-143a', 'Trifluoroethane'],
    [109, 'R-152a', 'Difluoroethane'], [110, 'R-22', 'Chlorodifluoromethane'], [111, 'R-23', 'Trifluoromethane'],
    [112, 'R-32', 'Difluoromethane'], [113, 'R-318', 'Octafluorocyclobutane'],
    [114, 'R-404A', '44% R-125, 4% R-134A, 52% R-143A'], [115, 'R-407C', '23% R-32, 25% R-125, 52% R-143A'],
    [116, 'R-410A', '50% R-32, 50% R-125'], [117, 'R-507A', '50% R-125, 50% R-143A'],
    [140, 'C-15', '15% CO2, 85% Ar'], [141, 'C-20', '20% CO2, 80% Ar'], [142, 'C-50', '50% CO2, 50% Ar'],
    [143, 'He-50', '50% He, 50% Ar'], [144, 'He-90', '90% He, 10% Ar'],
    [145, 'Bio5M', '5% CH4, 95% CO2'], [146, 'Bio10M', '10% CH4, 90% CO2'], [147, 'Bio15M', '15% CH4, 85% CO2'],
    [148, 'Bio20M', '20% CH4, 80% CO2'], [149, 'Bio25M', '25% CH4, 75% CO2'], [150, 'Bio30M', '30% CH4, 70% CO2'],
    [151, 'Bio35M', '35% CH4, 65% CO2'], [152, 'Bio40M', '40% CH4, 60% CO2'], [153, 'Bio45M', '45% CH4, 55% CO2'],
    [154, 'Bio50M', '50% CH4, 50% CO2'], [155, 'Bio55M', '55% CH4, 45% CO2'], [156, 'Bio60M', '60% CH4, 40% CO2'],
    [157, 'Bio65M', '65% CH4, 35% CO2'], [158, 'Bio70M', '70% CH4, 30% CO2'], [159, 'Bio75M', '75% CH4, 25% CO2'],
    [160, 'Bio80M', '80% CH4, 20% CO2'], [161, 'Bio85M', '85% CH4, 15% CO2'], [162, 'Bio90M', '90% CH4, 10% CO2'],
    [163, 'Bio95M', '95% CH4, 5% CO2'], [164, 'EAN-32', '32% O2, 68% N2'], [165, 'EAN-36', '36% O2, 64% N2'],
    [166, 'EAN-40', '40% O2, 60% N2'], [167, 'HeOx20', '20% O2, 80% He'], [168, 'HeOx21', '21% O2, 79% He'],
    [169, 'HeOx30', '30% O2, 70% He'], [170, 'HeOx40', '40% O2, 60% He'], [171, 'HeOx50', '50% O2, 50% He'],
    [172, 'HeOx60', '60% O2, 40% He'], [173, 'HeOx80', '80% O2, 20% He'], [174, 'HeOx99', '99% O2, 1% He'],
    [175, 'EA-40', 'Enriched air, 40% O2'], [176, 'EA-60', 'Enriched air, 60% O2'], [177, 'EA-80', 'Enriched air, 80% O2'],
    [178, 'Metab', 'Metabolic exhalant (16% O2, 78.04% N2, 5% CO2, 0.96% Ar)'],
    [179, 'LG-4.5', '4.5% CO2, 13.5% N2, 82% He'], [180, 'LG-6', '6% CO2, 14% N2, 80% He'],
    [181, 'LG-7', '7% CO2, 14% N2, 79% He'], [182, 'LG-9', '9% CO2, 15% N2, 76% He'], [183, 'HeNe-9', '9% Ne, 91% He'],
    [184, 'LG-9.4', '9.4% CO2, 19.25% N2, 71.35% He'], [185, 'SynG-1', '40% H2, 29% CO, 20% CO2, 11% CH4'],
    [186, 'SynG-2', '64% H2, 28% CO, 1% CO2, 7% CH4'], [187, 'SynG-3', '70% H2, 4% CO, 25% CO2, 1% CH4'],
    [188, 'SynG-4', '83% H2, 14% CO, 3% CH4'], [189, 'NatG-1', '93% CH4, 3% C2H6, 1% C3H8, 2% N2, 1% CO2'],
    [190, 'NatG-2', '95% CH4, 3% C2H6, 1% N2, 1% CO2'], [191, 'NatG-3', '95.2% CH4, 2.5% C2H6, 0.2% C3H8, 0.1% C4H10, 0.7% CO2'],
    [192, 'CoalG', '50% H2, 35% CH4, 10% CO, 5% C2H4'], [193, 'Endo', '75% H2, 25% N2'], [194, 'HHO', '66.67% H2, 33.33% O2'],
    [195, 'HD-5', 'LPG: 96.1% C3H8, 1.5% C2H6, 0.4% C3H6, 1.9% n-C4H10'], [196, 'HD-10', 'LPG: 85% C3H8, 10% C3H6, 5% n-C4H10'],
    [197, 'OCG-89', '89% O2, 7% N2, 4% Ar'], [198, 'OCG-93', '93% O2, 3% N2, 4% Ar'], [199, 'OCG-95', '95% O2, 1% N2, 4% Ar'],
    [200, 'FG-1', '2.5% O2, 10.8% CO2, 85.7% N2, 1% Ar'], [201, 'FG-2', '2.9% O2, 14% CO2, 82.1% N2, 1% Ar'],
    [202, 'FG-3', '3.7% O2, 15% CO2, 80.3% N2, 1% Ar'], [203, 'FG-4', '7% O2, 12% CO2, 80% N2, 1% Ar'],
    [204, 'FG-5', '10% O2, 9.5% CO2, 79.5% N2, 1% Ar'], [205, 'FG-6', '13% O2, 7% CO2, 79% N2, 1% Ar'],
    [206, 'P-10', '10% CH4, 90% Ar'], [210, 'D-2', 'Deuterium']
]);

const MIX_FIRST = 236;
const MIX_LAST = 255;

/** @type {Map<number, {number: number, symbol: string, name: string}>} */
const BY_NUMBER = new Map(GAS_TABLE.map(([number, symbol, name]) => [number, Object.freeze({ number, symbol, name })]));

/** @param {string} s */
const norm = (s) => s.toLowerCase().replace(/[\s_-]+/g, '');

/** @type {Map<string, number>} */
const BY_TEXT = new Map();
for (const [number, symbol, name] of GAS_TABLE) {
    BY_TEXT.set(norm(symbol), number);
    BY_TEXT.set(norm(name), number);
}
BY_TEXT.set('nitrogen', 8);
BY_TEXT.set('air', 0);

/**
 * Describe a gas number as reported by the device.
 * @param {number} number
 */
function describeGas(number) {
    const known = BY_NUMBER.get(number);
    if (known) {
        return known;
    }
    if (number >= MIX_FIRST && number <= MIX_LAST) {
        return { number, symbol: `Mix ${number}`, name: `COMPOSER mix ${number}` };
    }
    return { number, symbol: `Gas ${number}`, name: `Gas ${number}` };
}

/**
 * Resolve a user value (number, numeric string, symbol or name) to a gas number.
 * @param {number | string} value
 */
function resolveGas(value) {
    if (typeof value === 'number' || (typeof value === 'string' && /^\s*\d+\s*$/.test(value))) {
        const n = Number(value);
        if (Number.isInteger(n) && n >= 0 && n <= 255) {
            return n;
        }
    } else if (typeof value === 'string') {
        const n = BY_TEXT.get(norm(value));
        if (n !== undefined) {
            return n;
        }
        const mix = /^mix\s*(\d+)$/i.exec(value.trim());
        if (mix && Number(mix[1]) >= MIX_FIRST && Number(mix[1]) <= MIX_LAST) {
            return Number(mix[1]);
        }
    }
    throw new AlicatError('EINVALIDARG', `Unknown gas "${String(value)}". Use a gas number 0–255, a symbol (N2) or a name (Nitrogen).`);
}

/** Gas list for editor dropdowns. */
function listGases() {
    return GAS_TABLE.map(([number, symbol, name]) => ({ number, symbol, name }));
}

module.exports = { GAS_TABLE, describeGas, resolveGas, listGases, MIX_FIRST, MIX_LAST };
