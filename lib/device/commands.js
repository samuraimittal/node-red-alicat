'use strict';

const { AlicatError } = require('../errors');
const { Priority } = require('../PriorityQueue');
const codec = require('../alicat/codec');
const firmware = require('../alicat/firmware');
const { REG } = require('../alicat/registers');
const { COMMANDS, assertRawCommand } = require('../alicat/commands');
const { describeGas, resolveGas } = require('../alicat/gases');
const { decodeStatus, isValveState } = require('../alicat/status-bits');
const { own } = require('../util/own');
const { sleep, pollUntil } = require('../util/timers');

/**
 * Device commands over the command lane, each confirmed where the device
 * allows: valve state by the status bits, gas by the gas register, PID gains
 * by reading them back.
 *
 * @typedef {import('./types').DeviceHost} DeviceHost
 * @typedef {import('./types').ValveAction} ValveAction
 * @typedef {import('./types').ValveResult} ValveResult
 * @typedef {import('./types').GasResult} GasResult
 * @typedef {import('./types').PidGains} PidGains
 * @typedef {import('./types').Status} Status
 * @typedef {import('../CommandLane').CommandResult} CommandResult
 * @typedef {import('../CommandLane').CommandSpec} CommandSpec
 * @typedef {import('../alicat/commands').CommandDef} CommandDef
 * @typedef {{owner?: unknown}} OwnerOption
 */

/** How often to re-read a register while waiting for a command's effect. */
const EFFECT_POLL_MS = 100;
/** A valve command waits at most this long, including a running command it is queued behind. */
const VALVE_TIMEOUT_MS = 10000;

/**
 * @param {DeviceHost} host
 * @param {unknown} [owner]
 * @returns {Promise<Status>}
 */
async function readStatus(host, owner) {
    const id = await host.ready();
    const words = await host.client.readInputRegisters(host.unitId, REG.OPT_STATUS, 2, { priority: Priority.CONTROL, owner });
    return decodeStatus(codec.u32(words, 0), id.generation);
}

/**
 * Re-read the status until `predicate` holds, for at most effectTimeoutMs.
 * @param {DeviceHost} host
 * @param {(s: Status) => boolean} predicate
 * @param {unknown} owner
 */
function waitForStatus(host, predicate, owner) {
    return pollUntil(async () => predicate(await readStatus(host, owner)),
        { intervalMs: EFFECT_POLL_MS, timeoutMs: host.settings().effectTimeoutMs });
}

/**
 * Run a catalog command or a raw {id, arg}.
 * @param {DeviceHost} host
 * @param {string | {id: number, arg?: number, argType?: import('../CommandLane').ArgType, returnType?: CommandSpec['returnType']}} which
 * @param {number | undefined} arg
 * @param {{owner?: unknown, timeoutMs?: number}} opts
 * @returns {Promise<CommandResult>}
 */
async function runCommand(host, which, arg, opts) {
    const id = await host.ready();
    let spec;
    if (typeof which === 'string') {
        const def = own(/** @type {Readonly<Record<string, CommandDef>>} */ (COMMANDS), which);
        if (!def) throw new AlicatError('EINVALIDARG', `Unknown command "${which}"`);
        if (def.extendedOnly && !id.extendedCommands) {
            throw new AlicatError('EUNSUPPORTED', `${def.name} needs firmware ≥ ${def.minFirmware}`, { outcome: 'not-sent' });
        }
        if (def.minFirmware && id.firmware && !firmware.atLeast(id.firmware, def.minFirmware)) {
            throw new AlicatError('EUNSUPPORTED', `${def.name} needs firmware ≥ ${def.minFirmware}; device has ${id.firmware}`, { outcome: 'not-sent' });
        }
        spec = {
            id: def.id, arg: arg ?? 0, argType: def.argType === 'none' ? 'u16' : def.argType, returnType: def.returnType,
            priority: def.priority, label: def.name, retryIfDropped: Boolean(def.idempotent)
        };
    } else {
        assertRawCommand(which.id, which.arg ?? 0);
        spec = { id: which.id, arg: which.arg ?? 0, argType: which.argType, returnType: which.returnType || 'i32', label: `command ${which.id}` };
    }
    return host.lane.run({ ...spec, owner: opts.owner, timeoutMs: opts.timeoutMs });
}

/**
 * Valve control (URGENT). Confirmed by effect: the HLD / EXH status bits.
 * @param {DeviceHost} host
 * @param {ValveAction} action
 * @param {{owner?: unknown, timeoutMs?: number, fallbackSetpointZero?: boolean}} opts
 * @returns {Promise<ValveResult>}
 */
async function valve(host, action, opts) {
    const arg = own(COMMANDS.valve.args, action);
    if (arg === undefined) {
        throw new AlicatError('EINVALIDARG', `Unknown valve action "${action}". Use resume, holdClosed, holdCurrent or exhaust`);
    }
    await host.ready();
    /** @type {Promise<string | null> | null} */
    let fallback = null;
    const result = await host.lane.run({
        id: COMMANDS.valve.id, arg, priority: Priority.URGENT, label: `valve ${action}`, owner: opts.owner, retryIfDropped: true,
        timeoutMs: opts.timeoutMs ?? VALVE_TIMEOUT_MS,
        onQueuedBehind: (running) => {
            if (opts.fallbackSetpointZero && action === 'holdClosed') {
                fallback = host.client.writeRegisters(host.unitId, REG.SETPOINT, codec.encodeF32(0), { priority: Priority.URGENT, idempotent: true })
                    .then(() => 'setpoint-0', (err) => { host.warn(`Fallback setpoint 0 failed: ${err.message}`); return null; });
                host.warn(`Valve hold is queued behind running command ${running.id}; wrote setpoint 0 as fallback`);
            }
        }
    });
    if (result.superseded) {
        // A newer valve command replaced this one before it was sent: there is nothing to confirm.
        return { ...result, effect: false };
    }
    const confirmed = await waitForStatus(host, (s) => isValveState(s.flags, action), opts.owner);
    return {
        ...result,
        outcome: confirmed ? 'executed' : 'unknown',
        effect: confirmed,
        ...(fallback ? { fallback: await fallback } : {})
    };
}

/**
 * @param {DeviceHost} host
 * @param {number | string} gas number, symbol (N2) or name (Nitrogen)
 * @param {OwnerOption} opts
 * @returns {Promise<GasResult>}
 */
async function selectGas(host, gas, opts) {
    const number = resolveGas(gas);
    const result = await runCommand(host, 'selectGas', number, opts);
    let confirmed = false;
    const until = Date.now() + host.settings().effectTimeoutMs;
    while (!confirmed && Date.now() < until) {
        const [g] = await host.client.readInputRegisters(host.unitId, REG.OPT_GAS, 1, { priority: Priority.CONTROL, owner: opts.owner });
        confirmed = g === number;
        if (!confirmed) await sleep(EFFECT_POLL_MS);
    }
    return { ...result, gas: describeGas(number), outcome: confirmed ? 'executed' : 'unknown' };
}

/**
 * @param {DeviceHost} host
 * @param {'flow' | 'absolutePressure' | 'gaugePressure'} kind
 * @param {OwnerOption} opts
 */
function tare(host, kind, opts) {
    const arg = own(COMMANDS.tare.args, kind);
    if (arg === undefined) {
        return Promise.reject(new AlicatError('EINVALIDARG', `Unknown tare "${kind}". Use flow, absolutePressure or gaugePressure`));
    }
    return runCommand(host, 'tare', arg, opts);
}

/**
 * @param {DeviceHost} host
 * @param {1 | 2} which
 * @param {OwnerOption} opts
 */
async function resetTotalizer(host, which, opts) {
    const id = await host.ready();
    if (firmware.supports(id.firmware, 'totalizerSelect')) {
        return runCommand(host, 'resetTotalizer', which, opts);
    }
    if (which !== 1) {
        throw new AlicatError('EUNSUPPORTED', `Totalizer 2 reset needs firmware ≥ ${firmware.FEATURES.totalizerSelect}`, { outcome: 'not-sent' });
    }
    return runCommand(host, 'resetTotalizer1', 0, opts);
}

/**
 * Read P, D and I gains (command 14).
 * @param {DeviceHost} host
 * @param {OwnerOption} opts
 * @returns {Promise<PidGains>}
 */
async function readPid(host, opts) {
    const { P, D, I } = COMMANDS.readGain.args;
    const p = await runCommand(host, 'readGain', P, opts);
    const d = await runCommand(host, 'readGain', D, opts);
    const i = await runCommand(host, 'readGain', I, opts);
    return { p: p.returnValue, d: d.returnValue, i: i.returnValue };
}

/**
 * Write any of P / D / I (0–65535), then read all three back.
 * @param {DeviceHost} host
 * @param {{p?: number | undefined, d?: number | undefined, i?: number | undefined}} gains
 * @param {OwnerOption} opts
 * @returns {Promise<PidGains & {outcome: 'executed' | 'unknown'}>}
 */
async function writePid(host, gains, opts) {
    const map = /** @type {const} */ ([['p', 'setProportionalGain'], ['d', 'setDerivativeGain'], ['i', 'setIntegralGain']]);
    for (const [name] of map) {
        const value = gains[name];
        if (value === undefined || value === null) continue;
        if (!Number.isInteger(value) || value < 0 || value > 65535) {
            throw new AlicatError('EINVALIDARG', `${name.toUpperCase()} gain must be an integer 0–65535, got ${String(value)}`);
        }
    }
    for (const [name, key] of map) {
        const value = gains[name];
        if (value !== undefined && value !== null) await runCommand(host, key, value, opts);
    }
    const actual = await readPid(host, opts);
    const mismatch = map.filter(([name]) => gains[name] !== undefined && gains[name] !== null && actual[name] !== gains[name]);
    return { ...actual, outcome: mismatch.length === 0 ? 'executed' : 'unknown' };
}

module.exports = { readStatus, waitForStatus, runCommand, valve, selectGas, tare, resetTotalizer, readPid, writePid };
