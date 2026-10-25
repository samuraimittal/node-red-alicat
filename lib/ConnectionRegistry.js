'use strict';

const { AlicatError } = require('./errors');
const { AlicatClient, DEFAULTS: CLIENT_DEFAULTS } = require('./AlicatClient');
const { AlicatDevice } = require('./AlicatDevice');
const { unref } = require('./util/timers');

const REGISTRY_KEY = Symbol.for('alicat-modbus.registry.v1');

const DEFAULTS = Object.freeze({
    lingerMs: 1000, // release outside a deploy
    deployFallbackMs: 20000 // Node-RED's 15 s close timeout + 5 s, in case flows:started never arrives
});

/**
 * @typedef {InstanceType<typeof AlicatClient>} Client
 * @typedef {InstanceType<typeof AlicatDevice>} Device
 * @typedef {import('./AlicatClient').ClientOptions} ClientOptions
 * @typedef {import('./AlicatClient').ClientSettingsUpdate} ClientSettingsUpdate
 * @typedef {import('./AlicatDevice').DeviceOptions} DeviceOptions
 * @typedef {import('./AlicatDevice').DeviceSettingsUpdate} DeviceSettingsUpdate
 */

/**
 * @typedef {{key: string, host: string, port: number, unitId: number, options: ClientSettingsUpdate, deviceOptions: DeviceSettingsUpdate}} EntrySpec
 *   What an acquire asks for.
 * @typedef {{
 *   key: string,
 *   host: string,
 *   port: number,
 *   unitId: number,
 *   options: ClientSettingsUpdate,
 *   deviceOptions: DeviceSettingsUpdate,
 *   client: Client,
 *   device: Device,
 *   leases: Map<symbol, Lease>,
 *   state: 'ACTIVE' | 'PARKED' | 'CLOSING',
 *   timer: NodeJS.Timeout | null,
 *   closed: Promise<void> | null
 * }} Entry
 */

/** A config node's claim on a device connection. `release()` is idempotent. */
class Lease {
    /**
     * @param {ConnectionRegistry} registry
     * @param {Entry} entry
     * @param {string} [owner]
     */
    constructor(registry, entry, owner) {
        this.token = Symbol(owner || 'alicat-lease');
        this.owner = owner || '';
        this.client = entry.client;
        this.device = entry.device;
        this.key = entry.key;
        this.released = false;
        this._registry = registry;
        this._entry = entry;
    }

    /**
     * @param {{immediate?: boolean}} [options] `immediate`: close the connection now if
     *   nobody else uses it, instead of lingering for a quick re-acquire (outside deploys only)
     */
    release(options = {}) {
        if (this.released) {
            return;
        }
        this.released = true;
        this._registry._release(this, this._entry, options.immediate === true);
    }
}

/**
 * Process-wide owner of every device connection. This is what prevents socket
 * collisions:
 * - One client (one socket) per host:port, shared by every config node that
 *   names it.
 * - Deploy-aware: Node-RED closes every old node before it constructs any new
 *   one, and closing can take up to 15 s. So a release during a deploy PARKS
 *   the live socket, and the new instance re-acquires it with zero reconnects.
 *   Parked entries are torn down on `flows:started`, or straight away on
 *   shutdown or Stop flows.
 * - Alias-safe: before connecting, each client claims its resolved IP:port.
 *   A second configuration that resolves to the same device gets EDUPLICATE
 *   and never opens a socket.
 * - A new client for a key that is still closing waits until the old socket
 *   has fully closed.
 */
class ConnectionRegistry {
    /**
     * @param {{createClient?: (options: ClientOptions) => Client, createDevice?: (client: Client, options: DeviceOptions) => Device,
     *          lingerMs?: number, deployFallbackMs?: number, onWarning?: (message: string) => void}} [options]
     */
    constructor(options = {}) {
        this._createClient = options.createClient || ((o) => new AlicatClient(o));
        this._createDevice = options.createDevice || ((c, o) => new AlicatDevice(c, o));
        this.lingerMs = options.lingerMs ?? DEFAULTS.lingerMs;
        this.deployFallbackMs = options.deployFallbackMs ?? DEFAULTS.deployFallbackMs;
        /**
         * Options every new device starts from, under its configuration's own. Empty in
         * production; tests set faster command-lane timings to match a simulator's
         * 20 ms device cycle.
         * @type {DeviceOptions}
         */
        this.deviceDefaults = {};
        this._warn = options.onWarning || (() => {});
        /** @type {Map<string, Entry>} */
        this._entries = new Map();
        /** @type {Map<string, Entry>} `${address}|${port}` → entry */
        this._claims = new Map();
        this._deploying = false;
        /** @type {WeakSet<object>} */
        this._attached = new WeakSet();
    }

    /** @param {string} host @param {number} port */
    static keyOf(host, port) {
        return JSON.stringify([String(host).trim().toLowerCase(), Number(port)]);
    }

    get deploying() {
        return this._deploying;
    }

    /**
     * Listen to Node-RED runtime events (RED.events). Safe to call repeatedly.
     * @param {import('events').EventEmitter} events
     */
    attach(events) {
        if (!events || this._attached.has(events)) {
            return;
        }
        this._attached.add(events);
        events.on('flows:stopping', () => {
            this._deploying = true;
        });
        events.on('flows:started', () => {
            this._deploying = false;
            this._teardownParked();
        });
        events.on('runtime-event', (/** @type {{id?: string, payload?: {state?: string, deploy?: boolean}} | null} */ event) => {
            const payload = event && event.id === 'runtime-state' ? event.payload : null;
            if (payload && payload.state === 'stop' && !payload.deploy) {
                // Shutdown or "Stop flows": nothing will re-acquire, so free the device now.
                this._deploying = false;
                this._teardownParked();
            }
        });
    }

    /**
     * @param {{host: string, port?: number, unitId?: number, owner?: string,
     *          clientOptions?: ClientSettingsUpdate, deviceOptions?: DeviceSettingsUpdate,
     *          onWarning?: (message: string) => void}} params `onWarning`: where warnings about this acquire go
     * @returns {Lease}
     */
    acquire(params) {
        const warn = params.onWarning || this._warn;
        const host = String(params.host || '').trim();
        if (!host) {
            throw new AlicatError('EINVALIDARG', 'host is required');
        }
        const port = params.port ?? 502;
        const unitId = params.unitId ?? 1;
        // Every acquire states the complete client settings, so taking over a parked or
        // lingering entry never keeps what its previous holder set: another config
        // node's trace, or the editor test's long backoff and disabled heartbeat.
        /** @type {EntrySpec} */
        const spec = {
            key: ConnectionRegistry.keyOf(host, port),
            host,
            port,
            unitId,
            options: { ...CLIENT_DEFAULTS, trace: null, ...(params.clientOptions || {}), heartbeatUnitId: unitId },
            deviceOptions: params.deviceOptions || {}
        };
        const entry = this._entryFor(spec, warn);
        const lease = new Lease(this, entry, params.owner);
        entry.leases.set(lease.token, lease);
        return lease;
    }

    /**
     * The entry an acquire gets: a new one, or the existing one taken over.
     * @param {EntrySpec} spec
     * @param {(message: string) => void} warn
     * @returns {Entry}
     */
    _entryFor(spec, warn) {
        const entry = this._entries.get(spec.key);
        if (!entry) {
            return this._createEntry(spec, null);
        }
        if (entry.state === 'CLOSING') {
            return this._createEntry(spec, entry.closed);
        }
        if (entry.unitId !== spec.unitId) {
            if (entry.leases.size > 0) {
                throw new AlicatError('EDUPLICATE',
                    `${spec.host}:${spec.port} is already configured with unit ID ${entry.unitId}; native Ethernet has one device per IP`);
            }
            // Parked or lingering, with nobody using it (e.g. the unit ID was changed and redeployed): replace it.
            return this._createEntry(spec, this._teardown(entry));
        }
        this._takeOver(entry, spec, warn);
        return entry;
    }

    /**
     * Use an existing entry with this acquire's settings. They are applied before
     * taking it over: if they are invalid this throws, and a parked entry stays
     * parked with its teardown timer.
     * @param {Entry} entry @param {EntrySpec} spec @param {(message: string) => void} warn
     */
    _takeOver(entry, spec, warn) {
        if (entry.leases.size > 0 && JSON.stringify(entry.options) !== JSON.stringify(spec.options)) {
            warn(`Two configurations of ${spec.host}:${spec.port} have different settings; using the most recent`);
        }
        entry.client.configure(spec.options);
        if (JSON.stringify(entry.deviceOptions) !== JSON.stringify(spec.deviceOptions)) {
            entry.device.configure(spec.deviceOptions);
            entry.deviceOptions = spec.deviceOptions;
        }
        entry.options = spec.options;
        if (entry.state === 'PARKED') {
            this._clearTimer(entry);
            entry.state = 'ACTIVE';
        }
    }

    /** Snapshot for diagnostics and tests. */
    list() {
        return [...this._entries.values()].map((e) => ({
            key: e.key,
            host: e.host,
            port: e.port,
            unitId: e.unitId,
            state: e.state,
            leases: e.leases.size,
            client: e.client.state,
            device: e.device.state
        }));
    }

    /**
     * The live device for host:port, if one is leased or parked (used by the
     * editor's probe so it never opens a second socket).
     * @param {string} host @param {number} port
     */
    find(host, port) {
        const entry = this._entries.get(ConnectionRegistry.keyOf(host, port));
        return entry && entry.state !== 'CLOSING' ? { client: entry.client, device: entry.device } : null;
    }

    /** Tear down everything (tests, process exit). */
    async closeAll() {
        await Promise.all([...this._entries.values()].map((e) => this._teardown(e)));
    }

    /**
     * @param {EntrySpec} spec
     * @param {Promise<void> | null} startAfter connect once this settles (an old socket closing)
     * @returns {Entry}
     */
    _createEntry(spec, startAfter) {
        const { key, host, port, unitId } = spec;
        // The client claims its address only once started, after `entry` exists.
        const client = this._createClient({ ...spec.options, host, port, claimAddress: (address, p) => this._claim(entry, address, p) });
        const device = this._createDevice(client, { ...this.deviceDefaults, ...spec.deviceOptions, unitId });
        /** @type {Entry} */
        const entry = { ...spec, client, device, leases: new Map(), state: 'ACTIVE', timer: null, closed: null };
        this._entries.set(key, entry);
        const start = () => {
            if (this._entries.get(key) === entry && entry.state !== 'CLOSING') {
                entry.client.start();
            }
        };
        if (startAfter) {
            startAfter.then(start, start);
        } else {
            start();
        }
        return entry;
    }

    /**
     * @param {Lease} lease
     * @param {Entry} entry
     * @param {boolean} immediate
     */
    _release(lease, entry, immediate) {
        entry.leases.delete(lease.token);
        if (entry.leases.size > 0 || entry.state !== 'ACTIVE') {
            return;
        }
        if (immediate && !this._deploying) {
            this._teardown(entry);
            return;
        }
        entry.state = 'PARKED';
        const ms = this._deploying ? this.deployFallbackMs : this.lingerMs;
        entry.timer = unref(setTimeout(() => this._teardown(entry), ms));
    }

    /** @param {Entry} entry */
    _teardown(entry) {
        if (entry.state === 'CLOSING' && entry.closed) {
            return entry.closed;
        }
        this._clearTimer(entry);
        entry.state = 'CLOSING';
        entry.device.close();
        entry.closed = entry.client.stop().then(() => {
            for (const [k, holder] of this._claims) {
                if (holder === entry) {
                    this._claims.delete(k);
                }
            }
            if (this._entries.get(entry.key) === entry) {
                this._entries.delete(entry.key);
            }
        });
        return entry.closed;
    }

    _teardownParked() {
        for (const entry of [...this._entries.values()]) {
            if (entry.state === 'PARKED') {
                this._teardown(entry);
            }
        }
    }

    /**
     * @param {Entry} entry
     * @param {string} address
     * @param {number} port
     */
    _claim(entry, address, port) {
        const k = `${address}|${port}`;
        const holder = this._claims.get(k);
        if (holder && holder !== entry) {
            return false;
        }
        for (const [claimed, e] of this._claims) {
            if (e === entry && claimed !== k) {
                this._claims.delete(claimed);
            }
        }
        this._claims.set(k, entry);
        return true;
    }

    /** @param {Entry} entry */
    _clearTimer(entry) {
        if (entry.timer) {
            clearTimeout(entry.timer);
            entry.timer = null;
        }
    }
}

/** The process-wide registry (shared even if two copies of this module are loaded). */
function getRegistry() {
    const g = /** @type {{[REGISTRY_KEY]?: ConnectionRegistry}} */ (globalThis);
    if (!g[REGISTRY_KEY]) {
        g[REGISTRY_KEY] = new ConnectionRegistry();
    }
    return g[REGISTRY_KEY];
}

module.exports = { ConnectionRegistry, Lease, getRegistry, REGISTRY_KEY, DEFAULTS };
