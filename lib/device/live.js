'use strict';

const { errorSummary } = require('../errors');
const { describeGas } = require('../alicat/gases');
const { decodeStatus, decodeAlarms } = require('../alicat/status-bits');
const modern = require('../alicat/profiles/modern');
const legacy = require('../alicat/profiles/legacy');

/**
 * @typedef {import('./types').Identity} Identity
 * @typedef {import('./types').Snapshot} Snapshot
 */

/**
 * Freeze a snapshot and everything in it: one snapshot object is shared by every
 * subscriber, so a flow changing it must not change what other nodes receive.
 * @param {Snapshot} snapshot
 * @returns {Snapshot}
 */
function freezeSnapshot(snapshot) {
    for (const part of [snapshot.values, snapshot.gas, snapshot.units, snapshot.alarms, snapshot.error,
        snapshot.status.active, snapshot.status.flags, snapshot.status.unknownBits, snapshot.status]) {
        if (part) Object.freeze(part);
    }
    return Object.freeze(snapshot);
}

/**
 * Decode one read of the live block.
 * @param {Identity} id
 * @param {number[]} words the live block
 * @param {string} setpointUnits units of the setpoint in the current mode
 * @param {number | null} rttMs this read's own round trip
 * @returns {Snapshot}
 */
function decodeSnapshot(id, words, setpointUnits, rttMs) {
    const decoded = id.generation === 'gen2'
        ? modern.decodeLive(words, id.readings)
        : { ...legacy.decodeLive(words, id.layout), alarmsRaw: undefined };
    /** @type {Record<string, string>} */
    const units = {};
    for (const r of id.readings) {
        units[r.key] = r.key === 'setpoint' ? setpointUnits : r.units;
    }
    return freezeSnapshot({
        values: decoded.values,
        setpoint: decoded.values.setpoint ?? null,
        controlledVariable: id.controlledVariable,
        gas: describeGas(decoded.gas),
        status: decodeStatus(decoded.statusRaw, id.generation),
        alarms: decoded.alarmsRaw === undefined ? null : decodeAlarms(decoded.alarmsRaw),
        units,
        ts: Date.now(),
        quality: 'good',
        ageMs: 0,
        rttMs: rttMs !== null && Number.isFinite(rttMs) ? rttMs : null,
        generation: id.generation,
        firmware: id.firmware
    });
}

/**
 * The last good snapshot, marked stale or offline: the values stay, so a
 * reader sees what was last known and how old it is.
 * @param {Snapshot} last
 * @param {'stale' | 'offline'} quality
 * @param {Error | null | undefined} error why
 * @returns {Snapshot}
 */
function degradedSnapshot(last, quality, error) {
    return freezeSnapshot({
        ...last,
        quality,
        ageMs: Date.now() - last.ts,
        ...(error ? { error: errorSummary(error) } : {})
    });
}

module.exports = { freezeSnapshot, decodeSnapshot, degradedSnapshot };
