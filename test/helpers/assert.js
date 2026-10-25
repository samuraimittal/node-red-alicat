'use strict';

const assert = require('node:assert/strict');

/** @param {unknown} err */
const codeOf = (err) => /** @type {{code?: unknown}} */ (err).code;

/**
 * Assert that `promise` rejects with an error whose code is `code`.
 * @param {Promise<unknown>} promise @param {string} code
 */
async function rejectsCode(promise, code) {
    await assert.rejects(promise, (err) => {
        assert.equal(codeOf(err), code, /** @type {Error} */ (err).message);
        return true;
    });
}

/**
 * Assert that `fn` throws an error whose code is `code`.
 * @param {() => unknown} fn @param {string} code
 */
function throwsCode(fn, code) {
    assert.throws(fn, (err) => {
        assert.equal(codeOf(err), code, /** @type {Error} */ (err).message);
        return true;
    });
}

/**
 * The error a promise rejects with (fails the test if it resolves).
 * @param {Promise<unknown>} promise
 * @returns {Promise<any>}
 */
const failure = (promise) => promise.then(() => assert.fail('expected a rejection'), (err) => err);

module.exports = { rejectsCode, throwsCode, failure };
