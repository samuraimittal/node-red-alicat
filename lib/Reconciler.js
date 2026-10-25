'use strict';

const { EventEmitter } = require('events');
const { AlicatError, errorSummary } = require('./errors');
const statistics = require('./alicat/statistics');
const { isValveState } = require('./alicat/status-bits');
const { setpointTolerance, withinTolerance } = require('./alicat/setpoint');
const { withDefaults } = require('./util/defaults');

/**
 * @typedef {'auto' | 'hold-closed' | 'hold-current' | 'exhaust'} ValveState
 * @typedef {{setpoint?: number, variable?: string, valve?: ValveState}} DesiredState
 * @typedef {'variable' | 'valve' | 'setpoint'} Dimension
 * @typedef {{attempts: number, nextAllowedAt: number, converged: boolean, maintained: boolean, failedReported: boolean,
 *            lastError: Error | null}} DimensionState
 * @typedef {{
 *   event: 'accepted' | 'converged' | 'correcting' | 'drift' | 'failed' | 'released' | 'waiting',
 *   desired: DesiredState, actual: {setpoint: number | null, variable: string | null, valve: string | null},
 *   dimension?: Dimension, attempts?: number, sinceMs: number, error?: {code: string, message: string}
 * }} ReconcilerEvent
 * @typedef {{event: [ReconcilerEvent], warning: [message: string]}} ReconcilerEvents
 * @typedef {{
 *   intervalMs: number, tolerance: number | null, correctionMs: number, maxCorrectionMs: number,
 *   maxAttempts: number, onExternalChange: 'revert' | 'adopt' | 'report', switchMode: 'bumpless' | 'direct'
 * }} ReconcilerSettings
 * @typedef {{[K in keyof ReconcilerSettings]?: ReconcilerSettings[K] | undefined} & {owner?: unknown}} ReconcilerOptions
 */

/** @type {Readonly<ReconcilerSettings>} */
const DEFAULTS = Object.freeze({
    intervalMs: 500, tolerance: null, correctionMs: 1000, maxCorrectionMs: 10000, maxAttempts: 5,
    onExternalChange: 'revert', switchMode: 'bumpless'
});
/** @type {readonly ValveState[]} */
const VALVE_STATES = Object.freeze(['auto', 'hold-closed', 'hold-current', 'exhaust']);
/** @type {Readonly<Record<ValveState, import('./AlicatDevice').ValveAction>>} */
const VALVE_ACTION = Object.freeze({ auto: 'resume', 'hold-closed': 'holdClosed', 'hold-current': 'holdCurrent', exhaust: 'exhaust' });
/** Correct the control mode first (the setpoint means something else per mode), then the valve, then the setpoint. */
const ORDER = /** @type {const} */ (['variable', 'valve', 'setpoint']);

const newDimension = () => ({ attempts: 0, nextAllowedAt: 0, converged: false, maintained: true, failedReported: false, lastError: null });

/**
 * Keeps a device at a desired state: control mode, valve state and setpoint.
 * This replaces the production "global mailbox + inject loop" with:
 * - the desired state held in this object, never in a global;
 * - no action on stale or offline data;
 * - each dimension reconciled on its own, so a stuck valve never blocks
 *   setpoint corrections;
 * - corrections rate-limited (1 s, doubling to 10 s), with a 'failed' event
 *   after N attempts;
 * - external changes reported as 'drift', then reverted, adopted or only
 *   reported.
 *
 * Events: 'event' (ReconcilerEvent), 'warning' (message).
 * @extends {EventEmitter<ReconcilerEvents>}
 */
class Reconciler extends EventEmitter {
    /**
     * @param {InstanceType<typeof import('./AlicatDevice').AlicatDevice>} device
     * @param {ReconcilerOptions} [options]
     */
    constructor(device, options = {}) {
        super();
        this.device = device;
        const { owner, ...settings } = options;
        this.owner = owner ?? Symbol('reconciler');
        this.options = withDefaults(DEFAULTS, settings);
        if (!['revert', 'adopt', 'report'].includes(this.options.onExternalChange)) {
            throw new AlicatError('EINVALIDARG', `onExternalChange must be revert, adopt or report, got ${this.options.onExternalChange}`);
        }
        /** @type {DesiredState} */
        this.desired = {};
        /** @type {Record<Dimension, DimensionState>} */
        this._dims = { variable: newDimension(), valve: newDimension(), setpoint: newDimension() };
        /** @type {(() => void) | null} */
        this._unsubscribe = null;
        /** @type {import('./AlicatDevice').Snapshot | null} */
        this._snapshot = null;
        this._busy = false;
        this._closed = false;
        this._converged = false;
        this._waitingReported = false;
        this._since = Date.now();
    }

    get active() {
        return Object.keys(this.desired).length > 0;
    }

    /**
     * Set (part of) the desired state. Keys not given keep their desired value.
     * @param {DesiredState} partial
     */
    set(partial) {
        if (this._closed) {
            throw new AlicatError('ECLOSED', 'This control node has been closed');
        }
        const next = this._merge(partial);
        for (const dim of ORDER) {
            // A new value starts over; so does asking again for a dimension that a 'report' or
            // 'adopt' drift had stopped maintaining (otherwise it could never be resumed).
            if (next[dim] !== this.desired[dim] || (partial[dim] !== undefined && !this._dims[dim].maintained)) {
                this._dims[dim] = newDimension();
            }
        }
        this.desired = next;
        this._converged = false;
        this._waitingReported = false;
        this._since = Date.now();
        if (!this._unsubscribe) {
            this._unsubscribe = this.device.subscribe(this.owner, { intervalMs: this.options.intervalMs }, (s) => this._onSnapshot(s));
        }
        this._emit('accepted');
        if (this._snapshot) this._evaluateSafely();
    }

    /**
     * The desired state with `partial` applied, each given value checked
     * (throws EINVALIDARG).
     * @param {DesiredState} partial
     * @returns {DesiredState}
     */
    _merge(partial) {
        const next = { ...this.desired };
        if (partial.variable !== undefined) {
            statistics.controlVariable(partial.variable);
            next.variable = partial.variable;
        }
        if (partial.valve !== undefined) {
            if (!VALVE_STATES.includes(partial.valve)) {
                throw new AlicatError('EINVALIDARG', `valve must be one of ${VALVE_STATES.join(', ')}, got ${String(partial.valve)}`);
            }
            next.valve = partial.valve;
        }
        if (partial.setpoint !== undefined) {
            this._checkSetpoint(partial.setpoint, next.variable);
            next.setpoint = partial.setpoint;
        }
        return next;
    }

    /**
     * A desired setpoint must be a number within the device's range, when the
     * range is known for the mode it will apply in.
     * @param {unknown} setpoint @param {string | undefined} variable the desired mode, if any
     */
    _checkSetpoint(setpoint, variable) {
        if (typeof setpoint !== 'number' || !Number.isFinite(setpoint)) {
            throw new AlicatError('EINVALIDARG', `setpoint must be a finite number, got ${String(setpoint)}`);
        }
        const id = this.device.identity;
        const range = id && (!variable || variable === id.controlledVariable) ? this.device.getSetpointRange() : null;
        if (range && (setpoint < range.min || setpoint > range.max)) {
            throw new AlicatError('EINVALIDARG', `Desired setpoint ${setpoint} is outside the device range ${range.min}…${range.max}`);
        }
    }

    /** Stop maintaining; the device is left as it is. */
    release() {
        this.desired = {};
        this._dims = { variable: newDimension(), valve: newDimension(), setpoint: newDimension() };
        if (this._unsubscribe) this._unsubscribe();
        this._unsubscribe = null;
        this._converged = false;
        this._emit('released');
    }

    /** Stop for good (node close): no further corrections or events. */
    close() {
        this._closed = true;
        if (this._unsubscribe) this._unsubscribe();
        this._unsubscribe = null;
        this.desired = {};
        this.removeAllListeners();
    }

    /** @param {import('./AlicatDevice').Snapshot} snapshot */
    _onSnapshot(snapshot) {
        this._snapshot = snapshot;
        this._evaluateSafely();
    }

    /** Evaluate without letting an error escape as an unhandled rejection. */
    _evaluateSafely() {
        this._evaluate().catch((err) => {
            if (!this._closed) this.emit('warning', `Control evaluation failed: ${/** @type {Error} */ (err).message}`);
        });
    }

    _tolerance() {
        if (this.options.tolerance !== null) return this.options.tolerance;
        const range = this.device.identity ? this.device.getSetpointRange() : null;
        return setpointTolerance(range, this.desired.setpoint ?? 0);
    }

    /** @param {import('./AlicatDevice').Snapshot} s */
    _actual(s) {
        const id = this.device.identity;
        return {
            setpoint: s.setpoint,
            variable: id ? id.controlledVariable : null,
            valve: s.status.flags.exhausting ? 'exhaust' : s.status.flags.holding ? 'holding' : 'auto'
        };
    }

    /**
     * @param {Dimension} dim
     * @param {import('./AlicatDevice').Snapshot} s
     */
    _matches(dim, s) {
        const d = this.desired;
        if (dim === 'variable') {
            return !d.variable || (this.device.identity !== null && this.device.identity.controlledVariable === d.variable);
        }
        if (dim === 'valve') {
            return !d.valve || isValveState(s.status.flags, VALVE_ACTION[d.valve]);
        }
        if (d.setpoint === undefined) return true;
        return withinTolerance(s.setpoint, d.setpoint, this._tolerance());
    }

    async _evaluate() {
        const s = this._snapshot;
        if (this._busy || this._closed || !s || !this.active) return;
        if (!this._isFresh(s)) {
            if (!this._waitingReported) {
                this._waitingReported = true;
                this._emit('waiting');
            }
            return;
        }
        this._waitingReported = false;
        const mismatched = ORDER.filter((dim) => this._dims[dim].maintained && !this._matches(dim, s));
        if (mismatched.length === 0) {
            this._onConverged();
            return;
        }
        this._converged = false;
        for (const dim of mismatched) {
            const state = this._dims[dim];
            if (state.converged && !this._onDrift(dim, state)) continue;
            // The setpoint only means something once the control mode is right.
            if (dim === 'setpoint' && mismatched.includes('variable')) continue;
            if (Date.now() < state.nextAllowedAt) continue;
            await this._correct(dim, state);
            return; // one correction per evaluation; the next snapshot re-checks
        }
    }

    /**
     * Only good, recent data from an identified device is acted on.
     * @param {import('./AlicatDevice').Snapshot} s
     */
    _isFresh(s) {
        return s.quality === 'good' && Date.now() - s.ts < 3 * this.options.intervalMs && this.device.identity !== null;
    }

    /** Everything matches: report it once, and start each dimension's attempts afresh. */
    _onConverged() {
        if (this._converged) return;
        this._converged = true;
        for (const dim of ORDER) {
            Object.assign(this._dims[dim], { converged: true, attempts: 0, failedReported: false, lastError: null });
        }
        this._emit('converged');
    }

    /**
     * A dimension that had converged no longer matches: it was changed
     * elsewhere. Reports the drift, and says whether to correct it (revert);
     * adopt drops it from the desired state, report only stops maintaining it.
     * @param {Dimension} dim
     * @param {DimensionState} state
     */
    _onDrift(dim, state) {
        state.converged = false;
        this._emit('drift', { dimension: dim });
        if (this.options.onExternalChange === 'revert') return true;
        state.maintained = false;
        if (this.options.onExternalChange === 'adopt') delete this.desired[dim];
        return false;
    }

    /**
     * @param {Dimension} dim
     * @param {DimensionState} state
     */
    async _correct(dim, state) {
        this._busy = true;
        try {
            state.attempts++;
            this._emit('correcting', { dimension: dim, attempts: state.attempts });
            const d = this.desired;
            if (dim === 'variable') {
                await this.device.setControlVariable(/** @type {string} */ (d.variable), {
                    switchMode: this.options.switchMode, setpoint: d.setpoint, owner: this.owner
                });
            } else if (dim === 'valve') {
                await this.device.valve(VALVE_ACTION[/** @type {ValveState} */ (d.valve)], { owner: this.owner });
            } else {
                await this.device.setSetpoint(/** @type {number} */ (d.setpoint), { owner: this.owner });
            }
            state.lastError = null;
        } catch (err) {
            state.lastError = /** @type {Error} */ (err);
            if (state.attempts >= this.options.maxAttempts && !state.failedReported) {
                state.failedReported = true;
                this._emit('failed', { dimension: dim, attempts: state.attempts, error: state.lastError });
            }
        } finally {
            state.nextAllowedAt = Date.now() + Math.min(this.options.correctionMs * 2 ** (state.attempts - 1), this.options.maxCorrectionMs);
            this._busy = false;
        }
    }

    /**
     * @param {ReconcilerEvent['event']} event
     * @param {{dimension?: Dimension, attempts?: number, error?: Error}} [extra]
     */
    _emit(event, extra = {}) {
        if (this._closed) return;
        const s = this._snapshot;
        /** @type {ReconcilerEvent} */
        const payload = {
            event,
            desired: { ...this.desired },
            actual: s ? this._actual(s) : { setpoint: null, variable: null, valve: null },
            sinceMs: Date.now() - this._since,
            ...(extra.dimension ? { dimension: extra.dimension } : {}),
            ...(extra.attempts !== undefined ? { attempts: extra.attempts } : {}),
            ...(extra.error ? { error: errorSummary(extra.error) } : {})
        };
        try {
            this.emit('event', payload);
        } catch (err) {
            // A failing listener must not stall reconciliation or count as a failed correction.
            this.emit('warning', `A control event listener failed: ${/** @type {Error} */ (err).message}`);
        }
    }
}

module.exports = { Reconciler, VALVE_STATES };
