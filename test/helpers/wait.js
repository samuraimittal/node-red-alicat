'use strict';

/** @param {number} ms */
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Wait until `predicate` holds, checking every 5 ms.
 * @param {() => boolean} predicate
 * @param {number} [timeoutMs]
 * @param {string} [what] named in the error, to tell timeouts apart
 */
async function until(predicate, timeoutMs = 4000, what = 'condition') {
    const start = Date.now();
    while (!predicate()) {
        if (Date.now() - start > timeoutMs) throw new Error(`${what} not met within ${timeoutMs} ms`);
        await delay(5);
    }
}

module.exports = { delay, until };
