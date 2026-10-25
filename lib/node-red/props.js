'use strict';

const { AlicatError } = require('../errors');

/**
 * Evaluate a TypedInput property. Uses the callback form, so persistent
 * (async) context stores work.
 * @param {import('./types').NodeRedRuntime} RED
 * @param {import('./types').NodeRedNode} node
 * @param {import('./types').NodeMessage} msg
 * @param {string} value
 * @param {string} type
 * @returns {Promise<unknown>}
 */
function evaluate(RED, node, msg, value, type) {
    return new Promise((resolve, reject) => {
        const fail = (/** @type {Error} */ err) =>
            reject(new AlicatError('EINVALIDARG', `Could not read ${type}.${value}: ${err.message}`, { cause: err }));
        try {
            RED.util.evaluateNodeProperty(value, type, node, msg, (err, result) => {
                if (err) fail(err);
                else resolve(result);
            });
        } catch (err) {
            fail(/** @type {Error} */ (err)); // e.g. a malformed msg property path throws synchronously
        }
    });
}

/**
 * The TypedInput value to evaluate. An empty `msg` property means msg.payload;
 * any other empty field is an error, because Node-RED would evaluate an empty
 * number as 0 (an empty setpoint must not write 0).
 * @param {unknown} value @param {unknown} type @param {string} name
 * @returns {string}
 */
function propertyValue(value, type, name) {
    if (typeof value === 'string' && value !== '') return value;
    if (type === undefined || type === '' || type === 'msg') return 'payload';
    throw new AlicatError('EINVALIDARG', `${name} is empty`);
}

/** @param {unknown} value */
function describe(value) {
    if (value === undefined) return 'nothing';
    if (typeof value === 'number') return String(value); // JSON.stringify(NaN) would say "null"
    return JSON.stringify(value) ?? String(value);
}

/**
 * Numbers and numeric strings → number; anything else → EINVALIDARG.
 * @param {unknown} value
 * @param {string} name
 */
function toNumber(value, name) {
    const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
    if (typeof n !== 'number' || !Number.isFinite(n)) {
        throw new AlicatError('EINVALIDARG', `${name} must be a number, got ${describe(value)}`);
    }
    return n;
}

/**
 * "massFlow=SCCM, setpoint=SCCM" → {massFlow: 'SCCM', setpoint: 'SCCM'}
 * @param {unknown} text
 */
function parseLabels(text) {
    /** @type {Record<string, string>} */
    const out = {};
    if (typeof text !== 'string') return out;
    for (const part of text.split(/[,;\n]/)) {
        const [k, v] = part.split('=').map((s) => s.trim());
        if (k && v) out[k] = v;
    }
    return out;
}

module.exports = { evaluate, propertyValue, toNumber, parseLabels };
