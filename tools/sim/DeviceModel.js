'use strict';

/**
 * @typedef {{
 *   setpoint: number,
 *   massFlow: number,
 *   volumetricFlow: number,
 *   absolutePressure: number,
 *   gaugePressure: number,
 *   barometricPressure: number,
 *   temperature: number,
 *   valveDrive: number,
 *   totalMass: number,
 *   gas: number,
 *   alarms: number
 * }} DeviceState
 * @typedef {'massFlow' | 'volumetricFlow' | 'absolutePressure' | 'gaugePressure' | 'differentialPressure' | 'valveDrive'} ControlVariable
 */

/**
 * Deterministic process model of an Alicat controller. What the setpoint
 * drives depends on the loop control variable:
 * - massFlow / volumetricFlow: flow follows the setpoint (first-order, tau).
 * - valveDrive: the valve follows the setpoint (%), and flow follows the valve.
 * - pressure modes: gauge pressure follows the setpoint.
 * Valve commands override control: hold closed (valve 0, no flow), hold
 * current (freeze), exhaust (dual-valve only: pressure vents). No noise,
 * advanced lazily from an injectable clock.
 */
class DeviceModel {
    /**
     * @param {{clock?: (() => number) | undefined, tauMs?: number | undefined, gas?: number, controlVariable?: ControlVariable,
     *          setpointRanges?: Partial<Record<ControlVariable, {min: number, max: number}>>,
     *          flowFullScale?: number, dualValve?: boolean, state?: Partial<DeviceState>,
     *          gains?: {P: number, D: number, I: number}}} [options]
     */
    constructor(options = {}) {
        this.clock = options.clock || Date.now;
        this.tauMs = options.tauMs ?? 200;
        this.flowFullScale = options.flowFullScale ?? 20;
        this.dualValve = Boolean(options.dualValve);
        /** @type {ControlVariable} */
        this.controlVariable = options.controlVariable || 'massFlow';
        this.setpointRanges = options.setpointRanges || { massFlow: { min: 0, max: this.flowFullScale } };
        this.frozen = false;
        /** @type {null | 'closed' | 'current'} */
        this.hold = null;
        this.exhausting = false;
        this.displayLocked = false;
        this.algorithm = 1;
        this.gains = { ...(options.gains || { P: 720, D: 610, I: 250 }) };
        /** @type {DeviceState} */
        this.state = {
            setpoint: 0,
            massFlow: 0,
            volumetricFlow: 0,
            absolutePressure: 14.7,
            gaugePressure: 0,
            barometricPressure: 14.7,
            temperature: 23.5,
            valveDrive: 0,
            totalMass: 0,
            gas: options.gas ?? 8, // N2
            alarms: 0,
            ...(options.state || {})
        };
        this._lastAdvance = this.clock();
    }

    /**
     * A state value by reading name; null for a name the model doesn't simulate.
     * @param {string | null | undefined} key
     * @returns {number | null}
     */
    reading(key) {
        if (!key || !Object.hasOwn(this.state, key)) return null;
        const value = this.state[/** @type {keyof DeviceState} */ (key)];
        return Number.isFinite(value) ? value : null;
    }

    /** Device status bits: 8 = HLD, 10 = EXH (as verified on hardware). */
    get status() {
        return (this.hold ? 1 << 8 : 0) | (this.exhausting ? 1 << 10 : 0);
    }

    advance() {
        const now = this.clock();
        const dt = Math.max(0, now - this._lastAdvance);
        this._lastAdvance = now;
        if (this.frozen || dt === 0) {
            return;
        }
        const s = this.state;
        const alpha = 1 - Math.exp(-dt / this.tauMs);
        /** @param {number} from @param {number} to */
        const approach = (from, to) => (Math.abs(to - from) < 1e-6 ? to : from + (to - from) * alpha);
        const previousFlow = s.massFlow;

        if (this.exhausting) {
            s.valveDrive = approach(s.valveDrive, 0);
            s.massFlow = approach(s.massFlow, 0);
            s.gaugePressure = approach(s.gaugePressure, 0);
        } else if (this.hold === 'closed') {
            s.valveDrive = approach(s.valveDrive, 0);
            s.massFlow = approach(s.massFlow, 0);
        } else if (this.hold === 'current') {
            // valve frozen: nothing moves
        } else if (this.controlVariable === 'valveDrive') {
            s.valveDrive = approach(s.valveDrive, s.setpoint);
            s.massFlow = approach(s.massFlow, (s.valveDrive / 100) * this.flowFullScale);
        } else if (this.controlVariable === 'massFlow' || this.controlVariable === 'volumetricFlow') {
            const target = this.controlVariable === 'massFlow' ? s.setpoint : s.setpoint / 1.05;
            s.massFlow = approach(s.massFlow, target);
            s.valveDrive = s.setpoint === 0 && Math.abs(s.massFlow) < 1e-3 ? 0 : 25 + (Math.abs(s.massFlow) / this.flowFullScale) * 50;
        } else {
            const gaugeTarget = this.controlVariable === 'absolutePressure' ? s.setpoint - s.barometricPressure : s.setpoint;
            s.gaugePressure = approach(s.gaugePressure, gaugeTarget);
            s.valveDrive = Math.min(100, Math.max(0, 30 + s.gaugePressure / 2));
        }
        s.absolutePressure = s.barometricPressure + s.gaugePressure;
        s.volumetricFlow = s.massFlow * 1.05;
        s.totalMass += ((previousFlow + s.massFlow) / 2) * (dt / 60000);
    }

    /**
     * Apply a setpoint the way the instrument does: clamp to the range of the
     * current control variable.
     * @param {number | null} value
     * @returns {number} the setpoint actually applied
     */
    setSetpoint(value) {
        this.advance();
        const v = value === null || !Number.isFinite(value) ? this.state.setpoint : value;
        const range = this.setpointRanges[this.controlVariable];
        this.state.setpoint = Math.fround(range ? Math.min(Math.max(v, range.min), range.max) : v);
        return this.state.setpoint;
    }

    /** @param {ControlVariable} variable */
    setControlVariable(variable) {
        this.advance();
        this.controlVariable = variable;
        const range = this.setpointRanges[variable];
        if (range) {
            this.state.setpoint = Math.fround(Math.min(Math.max(this.state.setpoint, range.min), range.max));
        }
    }

    /** @param {Partial<DeviceState>} values */
    set(values) {
        this.advance();
        Object.assign(this.state, values);
    }
}

module.exports = { DeviceModel };
