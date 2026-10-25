'use strict';

// Strict command-line parsing for the tools: unknown flags, missing values and
// out-of-range numbers are errors, never silently turned into `true` or 1.

const { parseArgs } = require('util');

/**
 * @typedef {Record<string, {type: 'string' | 'boolean', multiple?: boolean, short?: string}>} OptionSpec
 */

/**
 * @param {string[]} argv
 * @param {OptionSpec} options
 * @returns {{values: Record<string, string | boolean | string[] | undefined>, positionals: string[]}}
 */
function parseCli(argv, options) {
    try {
        const { values, positionals } = parseArgs({ args: argv, options, allowPositionals: true, strict: true });
        return { values: /** @type {Record<string, string | boolean | string[] | undefined>} */ (values), positionals };
    } catch (err) {
        throw new Error(/** @type {Error} */ (err).message.replace(/\. To specify a positional argument.*$/s, '.'), { cause: err });
    }
}

/**
 * A number option within [min, max], or `fallback` when it is absent.
 * @param {Record<string, unknown>} values @param {string} name
 * @param {{fallback: number, min: number, max: number, integer?: boolean}} range integers unless `integer: false`
 */
function numberOption(values, name, { fallback, min, max, integer = true }) {
    const raw = values[name];
    if (raw === undefined) return fallback;
    const n = Number(raw);
    if (typeof raw !== 'string' || raw.trim() === '' || !Number.isFinite(n) || (integer && !Number.isInteger(n)) || n < min || n > max) {
        throw new Error(`--${name} must be ${integer ? 'an integer' : 'a number'} from ${min} to ${max}, got ${JSON.stringify(raw)}`);
    }
    return n;
}

/**
 * A string option that must be one of `allowed`.
 * @param {Record<string, unknown>} values @param {string} name @param {string} fallback @param {readonly string[]} allowed
 */
function choiceOption(values, name, fallback, allowed) {
    const raw = values[name];
    if (raw === undefined) return fallback;
    if (typeof raw !== 'string' || !allowed.includes(raw)) {
        throw new Error(`--${name} must be one of ${allowed.join(', ')}, got ${JSON.stringify(raw)}`);
    }
    return raw;
}

/** The leading `//` comment block of a script, as help text. @param {string} file */
function usage(file) {
    const lines = require('fs').readFileSync(file, 'utf8').split('\n');
    const start = lines.findIndex((l) => l.startsWith('//'));
    const end = lines.findIndex((l, i) => i > start && !l.startsWith('//'));
    return lines.slice(start, end).map((l) => l.replace(/^\/\/ ?/, '')).join('\n');
}

module.exports = { parseCli, numberOption, choiceOption, usage };
