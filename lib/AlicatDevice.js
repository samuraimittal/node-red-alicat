'use strict';

const { EventEmitter } = require('events');
const { AlicatError, isModbusException } = require('./errors');
const { Priority } = require('./PriorityQueue');
const { CommandLane } = require('./CommandLane');
const { toAddress } = require('./alicat/registers');
const { ILLEGAL_DATA_ADDRESS } = require('./modbus/exceptions');
const pdu = require('./modbus/pdu');
const { withDefaults } = require('./util/defaults');
const { unref } = require('./util/timers');
const { DEFAULTS, MAP_MODES, validateSettings, splitOptions, identifySettingsDiffer } = require('./device/options');
const { identifyDevice, readInfoBlocks, identityChanged, metadataChanged } = require('./device/identify');
const { decodeSnapshot } = require('./device/live');
const { LivePoller } = require('./device/poller');
const setpoints = require('./device/setpoint');
const commands = require('./device/commands');
const statistics = require('./alicat/statistics');

/**
 * The device's types live in lib/device/types.js; these aliases keep
 * `import('./AlicatDevice').Snapshot` and friends working.
 * @typedef {import('./device/types').DeviceSettings} DeviceSettings
 * @typedef {import('./device/types').DeviceSettingsUpdate} DeviceSettingsUpdate
 * @typedef {import('./device/types').DeviceOptions} DeviceOptions
 * @typedef {import('./device/types').ReadingInfo} ReadingInfo
 * @typedef {import('./device/types').Identity} Identity
 * @typedef {import('./device/types').Snapshot} Snapshot
 * @typedef {import('./device/types').DeviceState} DeviceState
 * @typedef {import('./device/types').DeviceEvents} DeviceEvents
 * @typedef {import('./device/types').ValveAction} ValveAction
 * @typedef {import('./device/types').SetpointResult} SetpointResult
 * @typedef {import('./device/types').SwitchResult} SwitchResult
 * @typedef {import('./device/types').ValveResult} ValveResult
 * @typedef {import('./device/types').GasResult} GasResult
 * @typedef {import('./device/types').PidGains} PidGains
 * @typedef {import('./device/types').DeviceHost} DeviceHost
 * @typedef {import('./CommandLane').CommandResult} CommandResult
 * @typedef {import('./CommandLane').CommandSpec} CommandSpec
 * @typedef {InstanceType<typeof import('./AlicatClient').AlicatClient>} Client
 */

const MAX_LISTENERS = 100;
/** How long ready() waits by default. */
const READY_TIMEOUT_MS = 10000;

/**
 * One Alicat instrument (one unit ID) on an AlicatClient: identifies the
 * firmware generation, decodes live data, and runs setpoint, control-mode,
 * valve, gas, tare and PID operations (lib/device/setpoint.js, commands.js).
 *
 * Events: 'identity' ({identity, changed}), 'state' (state), 'warning' (message).
 * @extends {EventEmitter<DeviceEvents>}
 */
class AlicatDevice extends EventEmitter {
    /**
     * @param {Client} client
     * @param {DeviceOptions} [options]
     */
    constructor(client, options = {}) {
        super();
        this.setMaxListeners(MAX_LISTENERS); // one status listener per node using the device; see AlicatClient
        this.client = client;
        // Per device, so closing one device never cancels another's identification on a shared client.
        this._identifyOwner = Symbol('alicat-identify');
        const { unitId, lane, settings } = splitOptions(options);
        this.unitId = unitId;
        this.options = settings;
        /** @type {DeviceState} */
        this.state = 'IDLE';
        /** @type {Identity | null} */
        this.identity = null;
        /** @type {Error | null} */
        this.lastError = null;
        /** @type {string | null} Gen-1: the mode this library last switched to */
        this._declaredVariable = null;
        /** @type {Promise<Identity> | null} */
        this._identifying = null;
        this._lastIdentifyAt = 0;
        this._setpointSeq = 0;
        /** @type {Record<'refresh' | 'retry', NodeJS.Timeout | null>} */
        this._timers = { refresh: null, retry: null };
        this.lane = new CommandLane({
            ...lane,
            client,
            unitId: this.unitId,
            useExtended: () => Boolean(this.identity && this.identity.extendedCommands),
            onWarning: (m) => this.emit('warning', m)
        });
        this._poller = new LivePoller({
            read: (opts) => this.readLive(opts),
            isOnline: () => this.client.isOnline,
            minIntervalMs: () => this.options.minPollMs,
            warn: (m) => this.emit('warning', m)
        });
        /** @type {DeviceHost} */
        this._host = {
            client,
            lane: this.lane,
            unitId: this.unitId,
            ready: () => this.ready(),
            identity: () => this.identity,
            settings: () => this.options,
            refreshMetadata: () => this.refreshMetadata(),
            declareVariable: (variable) => {
                this._declaredVariable = variable;
                if (this.identity) this.identity = { ...this.identity, controlledVariable: variable };
            },
            nextSetpointSeq: () => ++this._setpointSeq,
            setpointSeq: () => this._setpointSeq,
            warn: (m) => this.emit('warning', m)
        };
        this._onClientState = (/** @type {import('./AlicatClient').StateChange} */ change) => {
            if (change.state === 'ONLINE') {
                this.identify().catch(() => {});
            } else if (change.state === 'BACKOFF' || change.state === 'CLOSED') {
                this._poller.deliverQuality('offline', change.error);
            }
        };
        client.on('state', this._onClientState);
        if (client.isOnline) {
            this.identify().catch(() => {});
        }
    }

    /** The last snapshot the shared poll loop delivered (null before the first). */
    get lastSnapshot() {
        return this._poller.lastSnapshot;
    }

    /** How many owners subscribe to live data (diagnostics). */
    get subscriberCount() {
        return this._poller.size;
    }

    /**
     * Apply new settings (e.g. after a redeploy). Settings that change how the
     * device is decoded trigger a re-identification.
     * @param {DeviceSettingsUpdate} options
     */
    configure(options = {}) {
        validateSettings(options);
        const before = this.options;
        this.options = withDefaults(this.options, options);
        if (identifySettingsDiffer(before, this.options) && (this.state === 'READY' || this.state === 'FAILED') && this.client.isOnline) {
            this.identify().catch(() => {});
        }
    }

    // ------------------------------------------------------------ identification

    /**
     * Identify (or re-identify) the device. Concurrent calls share one run.
     * @returns {Promise<Identity>}
     */
    identify() {
        if (this.state === 'CLOSED') {
            return Promise.reject(new AlicatError('ECLOSED', 'Device is closed'));
        }
        if (this._identifying) {
            return this._identifying;
        }
        this._setState('IDENTIFYING');
        this._lastIdentifyAt = Date.now();
        // Clear the in-flight promise BEFORE announcing the result: listeners
        // (ready() callers) may call identify() again straight away and must get
        // a fresh run, not this finished one.
        const run = identifyDevice((register, quantity) => this._identRead(register, quantity), {
            settings: this.options, unitId: this.unitId, declaredVariable: this._declaredVariable
        }).then((identity) => {
            this._identifying = null;
            const changed = identityChanged(this.identity, identity);
            this.identity = identity;
            this.lastError = null;
            this._scheduleRefresh(); // before any listener runs, so a throwing listener can't skip it
            this._setState('READY');
            this.emit('identity', { identity, changed });
            return identity;
        }, (err) => {
            this._identifying = null;
            this.lastError = err;
            const fatal = err.code === 'EIDENTIFY';
            this._setState(fatal ? 'FAILED' : 'IDENTIFYING');
            if (!fatal && this.client.isOnline && this.state !== 'CLOSED') {
                this._scheduleRetry();
            }
            throw err;
        });
        this._identifying = run;
        return run;
    }

    /**
     * Resolve with the identity once the device is identified.
     * @param {number} [timeoutMs]
     * @returns {Promise<Identity>}
     */
    ready(timeoutMs = READY_TIMEOUT_MS) {
        if (this.state === 'READY' && this.identity) {
            return Promise.resolve(this.identity);
        }
        if (this.state === 'FAILED') {
            return Promise.reject(this.lastError || new AlicatError('EIDENTIFY', 'Device could not be identified'));
        }
        return new Promise((resolve, reject) => {
            // A pending ready() must not keep the process alive.
            const timer = unref(setTimeout(() => {
                cleanup();
                reject(this.lastError
                    ? new AlicatError(this.client.isOnline ? 'EIDENTIFY' : 'ENOTCONNECTED',
                        `Device not ready: ${this.lastError.message}`, { cause: this.lastError })
                    : new AlicatError('ENOTCONNECTED', 'Device not ready (not connected yet)'));
            }, timeoutMs));
            const onIdentity = () => { cleanup(); resolve(/** @type {Identity} */ (this.identity)); };
            /** @param {DeviceState} state */
            const onState = (state) => {
                if (state === 'FAILED') { cleanup(); reject(this.lastError); }
                if (state === 'CLOSED') { cleanup(); reject(new AlicatError('ECLOSED', 'Device is closed')); }
            };
            const cleanup = () => {
                clearTimeout(timer);
                this.removeListener('identity', onIdentity);
                this.removeListener('state', onState);
            };
            this.on('identity', onIdentity);
            this.on('state', onState);
        });
    }

    /** @param {number} register @param {number} quantity */
    _identRead(register, quantity) {
        return this.client.readInputRegisters(this.unitId, register, quantity,
            { priority: Priority.CONTROL, owner: this._identifyOwner, retries: 1 });
    }

    /** Gen-2: re-read info blocks (units, ranges, controlled variable). */
    async refreshMetadata() {
        const id = this.identity;
        if (!id || id.generation !== 'gen2') return id;
        const { readings, setpointType } = await readInfoBlocks((register, quantity) => this._identRead(register, quantity));
        const controlledVariable = statistics.controlledVariableFromSetpointType(setpointType);
        const changed = metadataChanged(id, readings, controlledVariable);
        this.identity = { ...id, readings, setpointType, controlledVariable };
        if (changed) {
            this.emit('identity', { identity: this.identity, changed: false, metadataChanged: true });
        }
        return this.identity;
    }

    // ------------------------------------------------------------ live data

    /**
     * Read one decoded snapshot.
     * @param {{priority?: 0 | 1 | 2, owner?: unknown}} [opts]
     * @returns {Promise<Snapshot>}
     */
    async readLive(opts = {}) {
        const id = await this.ready();
        let res;
        try {
            res = await this.client.request(this.unitId,
                pdu.buildReadInputRegisters(toAddress(id.liveBlock.start), id.liveBlock.quantity), {
                    priority: opts.priority ?? Priority.POLL,
                    coalesceKey: `live:${this.unitId}`,
                    owner: opts.owner
                });
        } catch (err) {
            if (isModbusException(err, ILLEGAL_DATA_ADDRESS) && Date.now() - this._lastIdentifyAt >= this.options.reidentifyMinMs) {
                // The data frame or firmware changed under us.
                this.identify().catch(() => {});
            }
            throw err;
        }
        return decodeSnapshot(/** @type {Identity} */ (this.identity), res.registers, this.getSetpointUnits(), res.rttMs);
    }

    /**
     * Live data on an interval. One poll loop at the fastest interval any
     * subscriber asks for serves them all (N read nodes = 1 wire read per cycle).
     * @param {unknown} owner
     * @param {{intervalMs?: number}} options
     * @param {(snapshot: Snapshot) => void} callback
     * @returns {() => void} unsubscribe
     */
    subscribe(owner, options, callback) {
        return this._poller.subscribe(owner, options.intervalMs, callback);
    }

    // ------------------------------------------------------------ setpoint & control mode

    /** The setpoint range in the current mode, if known: Gen-2 info block or Gen-1 configured limits. */
    getSetpointRange() {
        return setpoints.setpointRange(this.identity, this.options);
    }

    /** Units label of the setpoint in the current mode. */
    getSetpointUnits() {
        return setpoints.setpointUnits(this.identity, this.options);
    }

    /**
     * Write a setpoint in the device's current mode, or switch mode first.
     * @param {number} value
     * @param {{variable?: string, switchMode?: 'bumpless' | 'direct', outOfRange?: 'reject' | 'clamp',
     *          verify?: boolean, owner?: unknown}} [opts]
     * @returns {Promise<SetpointResult>}
     */
    async setSetpoint(value, opts = {}) {
        if (typeof value !== 'number' || !Number.isFinite(value)) {
            throw new AlicatError('EINVALIDARG', `Setpoint must be a finite number, got ${String(value)}`);
        }
        const id = await this.ready();
        if (opts.variable && opts.variable !== 'current' && opts.variable !== id.controlledVariable) {
            const switched = await this.setControlVariable(opts.variable, { ...opts, setpoint: value });
            return /** @type {SetpointResult} */ (switched.setpoint); // given a setpoint, the switch always writes it
        }
        return setpoints.writeSetpoint(this._host, value, opts);
    }

    /**
     * Switch what the setpoint controls: mass flow, volumetric flow,
     * absolute/gauge/differential pressure or valve drive. Bumpless by default:
     * hold the valve, switch, write the setpoint (if given), then resume.
     * @param {string} variable
     * @param {{switchMode?: 'bumpless' | 'direct', setpoint?: number | undefined, outOfRange?: 'reject' | 'clamp', verify?: boolean, owner?: unknown}} [opts]
     * @returns {Promise<SwitchResult>}
     */
    setControlVariable(variable, opts = {}) {
        return setpoints.switchControlVariable(this._host, variable, opts);
    }

    // ------------------------------------------------------------ commands

    /**
     * Valve control (URGENT). Confirmed by effect: the HLD / EXH status bits.
     * @param {ValveAction} action
     * @param {{owner?: unknown, timeoutMs?: number, fallbackSetpointZero?: boolean}} [opts]
     * @returns {Promise<ValveResult>}
     */
    valve(action, opts = {}) {
        return commands.valve(this._host, action, opts);
    }

    /**
     * Run a catalog command or a raw {id, arg}.
     * @param {string | {id: number, arg?: number, argType?: import('./CommandLane').ArgType, returnType?: CommandSpec['returnType']}} which
     * @param {number} [arg]
     * @param {{owner?: unknown, timeoutMs?: number}} [opts]
     * @returns {Promise<CommandResult>}
     */
    command(which, arg, opts = {}) {
        return commands.runCommand(this._host, which, arg, opts);
    }

    /**
     * @param {number | string} gas number, symbol (N2) or name (Nitrogen)
     * @param {{owner?: unknown}} [opts]
     * @returns {Promise<GasResult>}
     */
    selectGas(gas, opts = {}) {
        return commands.selectGas(this._host, gas, opts);
    }

    /** @param {'flow' | 'absolutePressure' | 'gaugePressure'} kind @param {{owner?: unknown}} [opts] */
    tare(kind, opts = {}) {
        return commands.tare(this._host, kind, opts);
    }

    /** @param {1 | 2} which @param {{owner?: unknown}} [opts] */
    resetTotalizer(which = 1, opts = {}) {
        return commands.resetTotalizer(this._host, which, opts);
    }

    /** @param {boolean} locked @param {{owner?: unknown}} [opts] */
    displayLock(locked, opts = {}) {
        return commands.runCommand(this._host, 'displayLock', locked ? 1 : 0, opts);
    }

    /** Read P, D and I gains (command 14). @param {{owner?: unknown}} [opts] @returns {Promise<PidGains>} */
    readPid(opts = {}) {
        return commands.readPid(this._host, opts);
    }

    /**
     * Write any of P / D / I (0–65535), then read all three back.
     * @param {{p?: number | undefined, d?: number | undefined, i?: number | undefined}} gains
     * @param {{owner?: unknown}} [opts]
     */
    writePid(gains, opts = {}) {
        return commands.writePid(this._host, gains, opts);
    }

    // ------------------------------------------------------------ lifecycle

    /** Cancel everything belonging to `owner` (node close). @param {unknown} owner */
    cancelOwner(owner) {
        this._poller.remove(owner);
        this.lane.cancelOwner(owner);
        return this.client.cancelByOwner(owner);
    }

    close() {
        if (this.state === 'CLOSED') return;
        this._clearTimer('refresh');
        this._clearTimer('retry');
        this._poller.close();
        this.lane.close();
        this.client.removeListener('state', this._onClientState);
        this.client.cancelByOwner(this._identifyOwner);
        this._setState('CLOSED');
    }

    /** @param {DeviceState} state */
    _setState(state) {
        if (this.state === state || this.state === 'CLOSED') return;
        this.state = state;
        this.emit('state', state);
    }

    _scheduleRetry() {
        if (this._timers.retry) return;
        this._timers.retry = unref(setTimeout(() => {
            this._timers.retry = null;
            if (this.client.isOnline) this.identify().catch(() => {});
        }, this.options.identifyRetryMs));
    }

    _scheduleRefresh() {
        this._clearTimer('refresh');
        if (!this.identity || this.identity.generation !== 'gen2' || !this.options.refreshMs) return;
        this._timers.refresh = unref(setInterval(() => {
            if (this.client.isOnline && this.state === 'READY') {
                this.refreshMetadata().catch(() => {});
            }
        }, this.options.refreshMs));
    }

    /** @param {'refresh' | 'retry'} name */
    _clearTimer(name) {
        const t = this._timers[name];
        if (t) {
            clearTimeout(t);
            clearInterval(t);
            this._timers[name] = null;
        }
    }
}

module.exports = { AlicatDevice, DEFAULTS, MAP_MODES };
