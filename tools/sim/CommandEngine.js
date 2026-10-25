'use strict';

const codec = require('../../lib/alicat/codec');
const { REG } = require('../../lib/alicat/registers');
const { describeGas, GAS_TABLE, MIX_FIRST, MIX_LAST } = require('../../lib/alicat/gases');

const KNOWN_GASES = new Set(GAS_TABLE.map(([n]) => n));
const LOOP_VARIABLES = ['massFlow', 'volumetricFlow', 'differentialPressure', 'absolutePressure', 'gaugePressure'];
/** Appendix A setpoint codes accepted by commands 11 (≥8v24) and 43. */
const SETPOINT_CODES = Object.freeze({ 37: 'massFlow', 36: 'volumetricFlow', 39: 'differentialPressure', 34: 'absolutePressure', 38: 'gaugePressure', 45: 'valveDrive' });
const VARIABLE_TO_CODE = Object.freeze(Object.fromEntries(Object.entries(SETPOINT_CODES).map(([code, v]) => [v, Number(code)])));

const STATUS = Object.freeze({ SUCCESS: 0, IN_PROGRESS: 1, INVALID_ID: 2, INVALID_ARGUMENT: 3, UNSUPPORTED: 4 });

/**
 * What a command did: its status, a return value, and how long it runs (timed commands).
 * @typedef {{status: number, ret?: number, durationMs?: number}} Outcome
 * @typedef {(engine: CommandEngine, arg: number) => Outcome} Handler
 */

/** @param {number} [ret] @returns {Outcome} */
const ok = (ret = 0) => ({ status: STATUS.SUCCESS, ret });
/** @returns {Outcome} */
const bad = () => ({ status: STATUS.INVALID_ARGUMENT });

/** Command 6: 0 resume, 1 hold closed, 2 hold current, 3 exhaust (dual valve only). @type {Handler} */
function valve({ model: m }, arg) {
    m.advance();
    if (arg < 0 || arg > 3) return bad();
    if (arg === 3 && !m.dualValve) return { status: STATUS.UNSUPPORTED };
    m.hold = arg === 1 ? 'closed' : arg === 2 ? 'current' : null;
    m.exhausting = arg === 3;
    return ok();
}

/** Commands 31–33: timed (tare-like) commands on the extended interface; `arg` = duration in ms. @type {Handler} */
function timed(engine, arg) {
    if (!engine.extended) return { status: STATUS.INVALID_ID };
    if (arg > 32767) return bad();
    return { status: STATUS.SUCCESS, durationMs: arg === 0 ? 256 : arg };
}

/** @type {Readonly<Record<number, Handler>>} */
const HANDLERS = Object.freeze({
    0: () => ok(),
    1: ({ model }, arg) => {
        if (!KNOWN_GASES.has(arg) && !(arg >= MIX_FIRST && arg <= MIX_LAST)) return bad();
        model.set({ gas: arg });
        return ok();
    },
    4: (_e, arg) => (arg <= 2 ? ok() : bad()),
    5: ({ model }) => { model.set({ totalMass: 0 }); return ok(); },
    6: valve,
    7: ({ model }, arg) => { model.displayLocked = arg !== 0; return ok(); },
    8: ({ model }, arg) => { model.gains.P = arg & 0xFFFF; return ok(); },
    9: ({ model }, arg) => { model.gains.D = arg & 0xFFFF; return ok(); },
    10: ({ model }, arg) => { model.gains.I = arg & 0xFFFF; return ok(); },
    11: (engine, arg) => engine._setLoop(arg),
    12: () => ok(),
    13: ({ model }, arg) => {
        if (arg !== 1 && arg !== 2) return bad();
        model.algorithm = arg;
        return ok();
    },
    14: ({ model }, arg) => (arg === 0 ? ok(model.gains.P) : arg === 1 ? ok(model.gains.D) : arg === 2 ? ok(model.gains.I) : bad()),
    20: () => ok(),
    31: timed,
    32: timed,
    33: timed,
    43: (engine, arg) => {
        if (!engine.query43) return { status: STATUS.INVALID_ID };
        if (arg === 65535) return ok(VARIABLE_TO_CODE[engine.model.controlVariable] ?? 0);
        return engine._setLoop(arg);
    },
    80: (engine, arg) => {
        if (!engine.query43) return { status: STATUS.INVALID_ID };
        if (arg !== 1 && arg !== 2) return bad();
        if (arg === 1) engine.model.set({ totalMass: 0 });
        return ok();
    }
});

/**
 * Alicat command-register behaviour, as measured on 10v20 and 9v07 hardware:
 * - Writes are sampled on a ~120 ms cycle. A write runs only if it differs
 *   from the PREVIOUS WRITE ON THE SAME INTERFACE (limited 1000–1001,
 *   extended 1002–1005).
 * - The echo is shared by both interfaces. Extended (1002–1009) shows the
 *   command currently executing (status 1) or last executed. Limited 1000
 *   shows the last COMPLETED command, and 1001 its result (0x8000 + status
 *   on error).
 * - A command written while another is IN_PROGRESS is queued and runs after it.
 */
class CommandEngine {
    /**
     * @param {{bank: InstanceType<typeof import('./RegisterBank').RegisterBank>,
     *          model: InstanceType<typeof import('./DeviceModel').DeviceModel>,
     *          extended: boolean, appendixALoopCodes?: boolean, query43?: boolean, cycleMs?: number | undefined,
     *          onLoopChange?: () => void, clock?: (() => number) | undefined}} options
     */
    constructor(options) {
        /** The simulator's clock (tests may inject one), used for running commands and the log. */
        this._now = options.clock || Date.now;
        this.bank = options.bank;
        this.model = options.model;
        this.extended = options.extended;
        this.appendixALoopCodes = options.appendixALoopCodes ?? true;
        this.query43 = options.query43 ?? options.extended;
        this.cycleMs = options.cycleMs ?? 120;
        this.onLoopChange = options.onLoopChange || (() => {});
        /** @type {Record<'limited' | 'extended', number[] | null>} */
        this._written = { limited: null, extended: null };
        /** @type {Record<'limited' | 'extended', string | null>} */
        this._lastProcessed = { limited: null, extended: null };
        /** @type {{id: number, arg: number}[]} */
        this._queue = [];
        /** @type {{id: number, arg: number, endAt: number} | null} */
        this._running = null;
        /** @type {NodeJS.Timeout | null} */
        this._timer = null;
        /** The most recent executed commands, for tests and diagnostics (bounded: simulators run for days). */
        this.log = /** @type {{id: number, arg: number, status: number, at: number}[]} */ ([]);
        this.maxLog = 1000;
        /** Fault: accept but never run the next N non-NOP commands (seen once on 9v07 hardware). */
        this.dropNextCommands = 0;
        /**
         * Test hook: sees each write when the device samples it, and may replace it
         * (another master overwriting the command registers).
         * @type {((iface: 'limited' | 'extended', words: number[]) => number[]) | null}
         */
        this.rewriteWrite = null;
        /**
         * Test hook: an outcome for a command instead of the simulated one
         * (undefined: run it as usual), e.g. a device that refuses a valve resume.
         * @type {((id: number, arg: number) => Outcome | undefined) | null}
         */
        this.commandHook = null;

        this.bank.group(REG.LIMITED_COMMAND_ID, 2, (w) => { this._written.limited = w; }, { store: false });
        if (this.extended) {
            this.bank.defineRange(REG.EXT_COMMAND_ID, 8);
            this.bank.group(REG.EXT_COMMAND_ID, 4, (w) => { this._written.extended = w; }, { store: false });
        }
    }

    start() {
        if (this._timer) return;
        this._timer = setInterval(() => this.cycle(), this.cycleMs);
        if (this._timer.unref) this._timer.unref();
    }

    stop() {
        if (this._timer) clearInterval(this._timer);
        this._timer = null;
    }

    /** The command executing now (a timed one), or null. */
    get running() {
        return this._running ? { id: this._running.id, arg: this._running.arg } : null;
    }

    /** One device cycle: sample writes, finish/start commands. Public for tests. */
    cycle() {
        for (const iface of /** @type {const} */ (['limited', 'extended'])) {
            let w = this._written[iface];
            if (!w) continue;
            if (this.rewriteWrite) w = this._written[iface] = this.rewriteWrite(iface, w);
            const key = w.join(',');
            if (key === this._lastProcessed[iface]) continue;
            this._lastProcessed[iface] = key;
            const id = iface === 'limited' ? codec.u16(w, 0) : codec.u32(w, 0);
            const arg = iface === 'limited' ? codec.u16(w, 1) : codec.u32(w, 2);
            if (this.dropNextCommands > 0 && id !== 0) {
                this.dropNextCommands--;
                continue;
            }
            this._queue.push({ id, arg });
        }
        const now = this._now();
        if (this._running && now >= this._running.endAt) {
            this._complete(this._running.id, this._running.arg, STATUS.SUCCESS, 0);
            this._running = null;
        }
        while (!this._running && this._queue.length > 0) {
            const { id, arg } = /** @type {{id: number, arg: number}} */ (this._queue.shift());
            const outcome = this._execute(id, arg);
            if (outcome.durationMs) {
                this._running = { id, arg, endAt: now + outcome.durationMs };
                this._echoExtended(id, arg, STATUS.IN_PROGRESS, 0);
            } else {
                this._complete(id, arg, outcome.status, outcome.ret ?? 0);
            }
        }
    }

    /** @param {number} id @param {number} arg @param {number} status @param {number} ret */
    _complete(id, arg, status, ret) {
        this.log.push({ id, arg, status, at: this._now() });
        if (this.log.length > this.maxLog) this.log.shift();
        this._echoExtended(id, arg, status, ret);
        this.bank.set(REG.LIMITED_COMMAND_ID, id & 0xFFFF);
        // Limited error codes are 0x8000 + status − 1: 0x8001 INVALID_ID, 0x8002 INVALID_ARGUMENT, 0x8003 UNSUPPORTED.
        this.bank.set(REG.LIMITED_COMMAND_ARG, status === STATUS.SUCCESS ? ret & 0xFFFF : 0x8000 + status - 1);
    }

    /** @param {number} id @param {number} arg @param {number} status @param {number} ret */
    _echoExtended(id, arg, status, ret) {
        if (!this.extended) return;
        this.bank.setU32(REG.EXT_COMMAND_ID, id);
        this.bank.setU32(REG.EXT_COMMAND_ARG, arg);
        this.bank.setU32(REG.EXT_COMMAND_STATUS, status);
        this.bank.setU32(REG.EXT_COMMAND_RETURN, ret >>> 0);
    }

    /**
     * @param {number} id
     * @param {number} arg
     * @returns {Outcome}
     */
    _execute(id, arg) {
        const hooked = this.commandHook ? this.commandHook(id, arg) : undefined;
        if (hooked) return hooked;
        const run = Object.hasOwn(HANDLERS, id) ? HANDLERS[id] : undefined;
        return run ? run(this, arg) : { status: STATUS.INVALID_ID };
    }

    /** @param {number} arg */
    _setLoop(arg) {
        const variable = arg < LOOP_VARIABLES.length ? LOOP_VARIABLES[arg]
            : (this.appendixALoopCodes ? /** @type {Record<number, string>} */ (SETPOINT_CODES)[arg] : undefined);
        if (!variable || !(variable in this.model.setpointRanges)) {
            return { status: STATUS.INVALID_ARGUMENT };
        }
        this.model.setControlVariable(/** @type {any} */ (variable));
        this.onLoopChange();
        return { status: STATUS.SUCCESS, ret: 0 };
    }

    /** Current gas description (for logs). */
    get gas() {
        return describeGas(this.model.state.gas);
    }
}

module.exports = { CommandEngine, STATUS, SETPOINT_CODES };
