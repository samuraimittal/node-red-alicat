'use strict';

/**
 * Look up `key` in a constant table, ignoring inherited properties. Keys come
 * from messages and configurations, and a name such as "constructor" or
 * "toString" must never resolve to something on Object.prototype.
 * @template T
 * @param {Readonly<Record<string, T>>} table
 * @param {unknown} key
 * @returns {T | undefined}
 */
function own(table, key) {
    return typeof key === 'string' && Object.hasOwn(table, key) ? table[key] : undefined;
}

module.exports = { own };
