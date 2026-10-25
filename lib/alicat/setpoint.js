'use strict';

/**
 * When a setpoint read back from the device counts as the one written: within
 * half of the device's last decimal place, with a small relative and absolute
 * floor for devices that don't report decimals. Setpoints travel as float32,
 * so the target is compared after rounding to float32 too.
 */

/**
 * @param {{decimals: number | null} | null} range the setpoint range, if known
 * @param {number} target
 */
function setpointTolerance(range, target) {
    const step = range && range.decimals !== null ? 0.5 * 10 ** -range.decimals : 0;
    return Math.max(step, 1e-6 * Math.abs(target), 1e-6);
}

/**
 * @param {number | null} actual the value read back
 * @param {number} target the value written
 * @param {number} tolerance
 */
function withinTolerance(actual, target, tolerance) {
    return actual !== null && Math.abs(actual - Math.fround(target)) <= tolerance;
}

module.exports = { setpointTolerance, withinTolerance };
