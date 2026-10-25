'use strict';

/**
 * Let the process exit while `timer` is pending: it only paces or guards work
 * that something else keeps alive (a socket, a pending request).
 * @template {NodeJS.Timeout} T
 * @param {T} timer
 * @returns {T}
 */
function unref(timer) {
    if (timer && typeof timer.unref === 'function') {
        timer.unref();
    }
    return timer;
}

/**
 * Wait `ms`. With a signal, an abort ends the wait early with an error.
 * @param {number} ms
 * @param {AbortSignal} [signal]
 * @returns {Promise<void>}
 */
function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
        if (!signal) {
            setTimeout(resolve, ms);
            return;
        }
        if (signal.aborted) {
            reject(new Error('aborted'));
            return;
        }
        const timer = setTimeout(() => {
            signal.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        const onAbort = () => {
            clearTimeout(timer);
            reject(new Error('aborted'));
        };
        signal.addEventListener('abort', onAbort, { once: true });
    });
}

/**
 * Call `check` until it returns true: at once, then every `intervalMs`, for at
 * most `attempts` calls or until `timeoutMs` has passed after a failed check.
 * @param {() => Promise<boolean>} check
 * @param {{intervalMs: number, attempts?: number, timeoutMs?: number}} options
 * @returns {Promise<boolean>} whether a check succeeded
 */
async function pollUntil(check, { intervalMs, attempts = Infinity, timeoutMs = Infinity }) {
    const until = Date.now() + timeoutMs;
    for (let calls = 1; ; calls++) {
        if (await check()) return true;
        if (calls >= attempts || Date.now() >= until) return false;
        await sleep(intervalMs);
    }
}

module.exports = { unref, sleep, pollUntil };
