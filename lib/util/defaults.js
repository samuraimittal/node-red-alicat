'use strict';

/**
 * `defaults` overlaid with the values in `update`. Keys that `defaults` doesn't
 * have are ignored, and so are undefined values, so an absent setting always
 * means its default (a plain spread would copy the undefined).
 * @template {object} T
 * @param {Readonly<T>} defaults
 * @param {{[K in keyof T]?: T[K] | undefined}} update
 * @returns {T}
 */
function withDefaults(defaults, update) {
    const result = /** @type {T} */ ({ ...defaults });
    for (const [key, value] of Object.entries(update)) {
        if (value !== undefined && Object.hasOwn(defaults, key)) {
            /** @type {Record<string, unknown>} */ (result)[key] = value;
        }
    }
    return result;
}

module.exports = { withDefaults };
