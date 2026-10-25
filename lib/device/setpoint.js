'use strict';

const { AlicatError, failedWriteOutcome, withOutcome } = require('../errors');
const { Priority } = require('../PriorityQueue');
const codec = require('../alicat/codec');
const firmware = require('../alicat/firmware');
const statistics = require('../alicat/statistics');
const { REG } = require('../alicat/registers');
const { COMMANDS } = require('../alicat/commands');
const { unitLabel } = require('../alicat/units');
const { setpointTolerance, withinTolerance } = require('../alicat/setpoint');
const { sleep, pollUntil } = require('../util/timers');
const { readStatus } = require('./commands');

/**
 * Setpoints and control modes.
 *
 * @typedef {import('./types').Identity} Identity
 * @typedef {import('./types').DeviceSettings} DeviceSettings
 * @typedef {import('./types').DeviceHost} DeviceHost
 * @typedef {import('./types').SetpointResult} SetpointResult
 * @typedef {import('./types').SwitchResult} SwitchResult
 * @typedef {{outOfRange?: 'reject' | 'clamp', verify?: boolean, owner?: unknown}} WriteOptions
 */

/** Gen-1 refreshes its data frame on the device cycle, so a read-back may take a few tries. */
const READBACK = Object.freeze({ attempts: 4, intervalMs: 100 });
/** Gen-2 info blocks may show a new mode a device cycle or two after the command completes. */
const MODE_CONFIRM = Object.freeze({ attempts: 6, intervalMs: 200 });

/**
 * Units of the setpoint in the current mode: from the Gen-2 info blocks, or
 * the Gen-1 configured labels.
 * @param {Identity | null} id
 * @param {DeviceSettings} settings
 */
function setpointUnits(id, settings) {
    if (!id) return '';
    if (id.generation === 'gen2') {
        const sp = id.readings.find((r) => r.key === 'setpoint');
        if (!sp) return '';
        const stat = statistics.statistic(id.setpointType);
        return unitLabel(stat.category, sp.unitsCode ?? 0, stat.reference ?? null);
    }
    const labels = settings.unitLabels || {};
    return labels.setpoint || (id.controlledVariable ? labels[id.controlledVariable] || '' : '');
}

/**
 * The setpoint range in the current mode, if known: Gen-2 info block, or the
 * Gen-1 configured limits.
 * @param {Identity | null} id
 * @param {DeviceSettings} settings
 * @returns {{min: number, max: number, decimals: number | null} | null}
 */
function setpointRange(id, settings) {
    if (!id) return null;
    if (id.generation === 'gen2') {
        const sp = id.readings.find((r) => r.key === 'setpoint');
        return sp && sp.min !== null && sp.max !== null ? { min: sp.min, max: sp.max, decimals: sp.decimals } : null;
    }
    const limits = settings.setpointLimits || {};
    const l = id.controlledVariable ? limits[id.controlledVariable] : undefined;
    return l ? { min: l.min, max: l.max, decimals: null } : null;
}

/**
 * The value to write: `value` itself, or (when allowed) clamped to the range.
 * Out of range and not clamped: EINVALIDARG, nothing sent.
 * @param {number} value
 * @param {{min: number, max: number} | null} range
 * @param {string} units for the message
 * @param {'reject' | 'clamp' | undefined} outOfRange
 */
function planTarget(value, range, units, outOfRange) {
    if (!range || (value >= range.min && value <= range.max)) {
        return { target: value, clamped: false };
    }
    if (outOfRange !== 'clamp') {
        throw new AlicatError('EINVALIDARG',
            `Setpoint ${value} is outside the device range ${range.min}…${range.max}${units ? ` ${units}` : ''}`, { outcome: 'not-sent' });
    }
    return { target: Math.min(Math.max(value, range.min), range.max), clamped: true };
}

/**
 * Read the setpoint back a few times until it matches.
 * @param {DeviceHost} host
 * @param {number} register where the setpoint reads back
 * @param {(value: number | null) => boolean} matches
 * @param {unknown} owner
 * @returns {Promise<number | null>} the last value read
 */
async function readBack(host, register, matches, owner) {
    let actual = null;
    for (let attempt = 0; attempt < READBACK.attempts; attempt++) {
        const words = await host.client.readInputRegisters(host.unitId, register, 2, { priority: Priority.CONTROL, owner });
        actual = codec.f32(words, 0);
        if (matches(actual)) break;
        await sleep(READBACK.intervalMs);
    }
    return actual;
}

/**
 * Write a setpoint in the current mode and confirm it by reading it back.
 * @param {DeviceHost} host
 * @param {number} value
 * @param {WriteOptions} opts
 * @returns {Promise<SetpointResult>}
 */
async function writeSetpoint(host, value, opts) {
    const id = /** @type {Identity} */ (host.identity());
    const settings = host.settings();
    const range = setpointRange(id, settings);
    const units = setpointUnits(id, settings);
    const { target, clamped } = planTarget(value, range, units, opts.outOfRange);
    const seq = host.nextSetpointSeq();
    const base = { requested: value, written: target, variable: id.controlledVariable, units };
    let res;
    try {
        res = await host.client.writeRegisters(host.unitId, REG.SETPOINT, codec.encodeF32(target), {
            priority: Priority.CONTROL, replaceKey: `sp:${host.unitId}`, idempotent: true, owner: opts.owner
        });
    } catch (err) {
        throw withOutcome(err, failedWriteOutcome(err));
    }
    if ('superseded' in res) {
        return { ...base, actual: null, clamped, verified: false, superseded: true, outcome: 'not-sent' };
    }
    const register = id.generation === 'gen2'
        ? REG.STD_FLOAT_BASE
        : (id.readings.find((r) => r.key === 'setpoint') || { register: 0 }).register;
    if (opts.verify === false || !register) {
        return { ...base, actual: null, clamped, verified: false, outcome: 'accepted' };
    }
    const tolerance = setpointTolerance(range, target);
    let actual;
    try {
        actual = await readBack(host, register, (v) => withinTolerance(v, target, tolerance), opts.owner);
    } catch (err) {
        throw withOutcome(err, 'accepted'); // the device acknowledged the write; only the read-back failed
    }
    const verified = withinTolerance(actual, target, tolerance);
    if (seq !== host.setpointSeq()) {
        return { ...base, actual, clamped, verified, superseded: true, outcome: verified ? 'executed' : 'accepted' };
    }
    // A read-back that differs (the device limited it, or another master changed it) is not a confirmation.
    return { ...base, actual, clamped, verified, outcome: verified ? 'executed' : 'unknown' };
}

/**
 * Switch what the setpoint controls. Bumpless by default: hold the valve,
 * switch, write the setpoint (if given), then resume, unless an operator's
 * valve command arrived meanwhile.
 * @param {DeviceHost} host
 * @param {string} variable
 * @param {WriteOptions & {switchMode?: 'bumpless' | 'direct', setpoint?: number | undefined}} opts
 * @returns {Promise<SwitchResult>}
 */
async function switchControlVariable(host, variable, opts) {
    const def = statistics.controlVariable(variable);
    const id = await host.ready();
    if (def.minFirmware && id.firmware && !firmware.atLeast(id.firmware, def.minFirmware)) {
        throw new AlicatError('EUNSUPPORTED', `${def.label} control needs firmware ≥ ${def.minFirmware}; device has ${id.firmware}`);
    }
    const { lane } = host;
    const previous = id.controlledVariable;
    let held = false;
    let urgentBefore = 0;
    if (opts.switchMode !== 'direct') {
        const status = await readStatus(host, opts.owner);
        if (!status.flags.holding) {
            await lane.run({ id: COMMANDS.valve.id, arg: COMMANDS.valve.args.holdCurrent, label: 'hold valve for mode switch', owner: opts.owner, retryIfDropped: true });
            held = true;
            urgentBefore = lane.urgentRequests;
        }
    }
    try {
        const useQuery = id.generation === 'gen2' && firmware.supports(id.firmware, 'loopVariableQuery');
        const command = await lane.run({
            id: useQuery ? COMMANDS.loopControlVariable.id : COMMANDS.setLoopVariable.id,
            arg: def.loopArg,
            label: `set control variable to ${variable}`,
            owner: opts.owner,
            retryIfDropped: true
        });
        /** @type {'accepted' | 'executed'} */
        let outcome = 'accepted';
        if (id.generation === 'gen2') {
            const switched = await pollUntil(async () => {
                const fresh = await host.refreshMetadata();
                return fresh !== null && fresh.controlledVariable === variable;
            }, MODE_CONFIRM);
            if (!switched) {
                const current = host.identity();
                const reported = current ? current.controlledVariable : null; // as refreshMetadata() last read it
                throw new AlicatError('ECOMMAND', `Device reports control variable ${reported} after switching to ${variable}`, { outcome: 'unknown' });
            }
            outcome = 'executed';
        } else {
            host.declareVariable(variable);
        }
        const setpoint = opts.setpoint === undefined ? null : await writeSetpoint(host, opts.setpoint, opts);
        return { variable, previous, outcome, bumpless: held, command, setpoint };
    } finally {
        if (held && lane.urgentRequests !== urgentBefore) {
            // An operator's valve command (hold, exhaust, resume) arrived during the switch: it wins.
            host.warn('Not resuming the valve after the mode switch: a valve command was sent meanwhile');
        } else if (held) {
            await lane.run({ id: COMMANDS.valve.id, arg: COMMANDS.valve.args.resume, label: 'resume after mode switch', owner: opts.owner, retryIfDropped: true })
                .catch((err) => host.warn(`Could not resume the valve after a mode switch: ${err.message}`));
        }
    }
}

module.exports = { setpointUnits, setpointRange, writeSetpoint, switchControlVariable };
