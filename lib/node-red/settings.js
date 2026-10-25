'use strict';

/**
 * Reading a node's editor settings. The ranges live in one table, used by the
 * runtime check here and by the editor's validators, so the two can't disagree.
 *
 * @typedef {{min: number, max: number, default: number, integer: boolean}} Bounds
 * @typedef {ReturnType<typeof settingsReader>} SettingsReader
 */

/** @param {number} min @param {number} max @param {number} fallback @param {boolean} [integer] @returns {Readonly<Bounds>} */
const range = (min, max, fallback, integer = true) => Object.freeze({ min, max, default: fallback, integer });

const BOUNDS = Object.freeze({
    device: Object.freeze({
        port: range(1, 65535, 502),
        unitId: range(0, 247, 1), // 248–255 are reserved in Modbus, and 9v07 hardware doesn't answer 255
        requestTimeout: range(100, 30000, 1000),
        connectTimeout: range(500, 60000, 5000),
        interFrameDelay: range(0, 1000, 20),
        heartbeat: range(0, 15000, 5000),
        backoffMax: range(1000, 300000, 30000),
        maxQueue: range(10, 10000, 200)
    }),
    read: Object.freeze({
        interval: range(100, 3600000, 1000)
    }),
    control: Object.freeze({
        interval: range(100, 60000, 500),
        correctionMs: range(100, 10000, 1000),
        maxAttempts: range(1, 1000, 5)
    }),
    status: Object.freeze({
        periodic: range(0, 86400, 0, false) // seconds; 0 = off
    })
});

/** @param {unknown} value */
const isEmpty = (value) => value === undefined || value === null || value === '';

/**
 * Reads one node's settings. Every problem is collected rather than thrown at
 * the first, so the node can report them all at once. An absent or empty
 * setting means its default (flows saved by older versions lack newer fields).
 * @param {{[key: string]: unknown}} config
 */
function settingsReader(config) {
    /** @type {string[]} */
    const problems = [];
    return {
        problems,

        /**
         * A number within `bounds`.
         * @param {string} key @param {Readonly<Bounds>} bounds @param {string} label
         */
        number(key, bounds, label) {
            const raw = config[key];
            if (isEmpty(raw)) return bounds.default;
            const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
            const whole = bounds.integer ? 'an integer' : 'a number';
            if (!Number.isFinite(n) || (bounds.integer && !Number.isInteger(n)) || n < bounds.min || n > bounds.max) {
                problems.push(`${label} must be ${whole} ${bounds.min}–${bounds.max} (got ${JSON.stringify(raw)})`);
                return bounds.default;
            }
            return n;
        },

        /**
         * A number ≥ `min`, or null when empty (e.g. "automatic" tolerance).
         * @param {string} key @param {number} min @param {string} label
         * @returns {number | null}
         */
        optionalNumber(key, min, label) {
            const raw = config[key];
            if (isEmpty(raw)) return null;
            const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
            if (!Number.isFinite(n) || n < min) {
                problems.push(`${label} must be empty or a number ≥ ${min} (got ${JSON.stringify(raw)})`);
                return null;
            }
            return n;
        },

        /**
         * One of `choices`; an unknown value is a problem, not silently replaced.
         * @template {string} T
         * @param {string} key @param {readonly T[]} choices @param {T} fallback @param {string} label
         * @returns {T}
         */
        choice(key, choices, fallback, label) {
            const raw = config[key];
            if (isEmpty(raw)) return fallback;
            if (typeof raw === 'string' && /** @type {readonly string[]} */ (choices).includes(raw)) return /** @type {T} */ (raw);
            problems.push(`${label} must be one of ${choices.join(', ')} (got ${JSON.stringify(raw)})`);
            return fallback;
        },

        /** @param {string} key @param {string} [fallback] */
        text(key, fallback = '') {
            const raw = config[key];
            return typeof raw === 'string' && raw !== '' ? raw : isEmpty(raw) ? fallback : String(raw);
        },

        /**
         * Text that may be missing: undefined when absent, '' when cleared on purpose.
         * @param {string} key
         * @returns {string | undefined}
         */
        optionalText(key) {
            const raw = config[key];
            return raw === undefined || raw === null ? undefined : String(raw);
        },

        /** A checkbox; flows edited by hand may hold "true". @param {string} key @param {boolean} fallback */
        flag(key, fallback) {
            const raw = config[key];
            if (raw === undefined || raw === null || raw === '') return fallback;
            return raw === true || raw === 'true';
        }
    };
}

module.exports = { BOUNDS, settingsReader };
