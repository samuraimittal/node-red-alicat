'use strict';

/**
 * Exponential reconnect backoff with equal jitter:
 *   d = min(maxMs, initialMs × factor^(attempt − 1));  delay = d/2 + random(0, d/2)
 * Half the delay is guaranteed, so retries never collapse to zero, and the
 * other half is random, so many clients restarting together don't reconnect
 * in lock-step.
 */
class Backoff {
    /**
     * @param {{initialMs?: number, maxMs?: number, factor?: number, random?: () => number}} [options]
     */
    constructor(options = {}) {
        this.initialMs = options.initialMs ?? 1000;
        this.maxMs = options.maxMs ?? 30000;
        this.factor = options.factor ?? 2;
        this.random = options.random || Math.random;
    }

    /** @param {number} attempt 1 for the first retry */
    ceiling(attempt) {
        return Math.min(this.maxMs, this.initialMs * this.factor ** Math.max(0, attempt - 1));
    }

    /** @param {number} attempt 1 for the first retry */
    delay(attempt) {
        const d = this.ceiling(attempt);
        return Math.round(d / 2 + this.random() * (d / 2));
    }
}

module.exports = { Backoff };
