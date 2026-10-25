'use strict';

const net = require('net');
const { listGases } = require('../alicat/gases');
const { LAYOUT_PRESETS, SLOT_KEYS, DEVICE_TYPES, validateLayout } = require('../alicat/profiles/legacy');
const { CONTROL_VARIABLES } = require('../alicat/statistics');
const { MAP_MODES } = require('../AlicatDevice');
const { errorInfo } = require('./message');

const REGISTERED = Symbol.for('alicat-modbus.admin-api.v1');
/** Tests running at once, across all devices. */
const MAX_CONCURRENT_PROBES = 2;
const MODBUS_PORT = 502;

/**
 * @typedef {import('./types').NodeRedRuntime} NodeRedRuntime
 * @typedef {import('./types').AdminRequest} AdminRequest
 * @typedef {import('./types').AdminResponse} AdminResponse
 * @typedef {InstanceType<typeof import('../ConnectionRegistry').Lease>} Lease
 * @typedef {import('../AlicatDevice').Identity} Identity
 */

/**
 * Ports the editor may test. Only the Modbus port by default, so the endpoint
 * can't be used to probe arbitrary services; more via settings.js
 * `alicatModbus: {probePorts: [5020]}` (e.g. a simulator or a NAT'd device).
 * @param {NodeRedRuntime} RED @param {number} port
 */
function probePortAllowed(RED, port) {
    const extra = RED.settings && RED.settings.alicatModbus && RED.settings.alicatModbus.probePorts;
    return port === MODBUS_PORT || (Array.isArray(extra) && extra.includes(port));
}

/**
 * The identification settings in a probe request, checked like a deployed configuration's.
 * @param {{[key: string]: unknown}} body
 * @returns {{mapMode: string, deviceType: string, layout: string | string[] | null} | string} the settings, or what is wrong
 */
function probeSettings(body) {
    const mapMode = body.mapMode || 'auto';
    const deviceType = body.deviceType || 'auto';
    // validateLayout() rejects anything that is not a preset name or a list of reading names.
    const layout = /** @type {string | string[] | null} */ (body.layout || null);
    if (typeof mapMode !== 'string' || !MAP_MODES.includes(mapMode)) return `mapMode must be one of ${MAP_MODES.join(', ')}`;
    if (typeof deviceType !== 'string' || !DEVICE_TYPES.includes(deviceType)) return `deviceType must be one of ${DEVICE_TYPES.join(', ')}`;
    if (layout !== null) {
        try {
            validateLayout(layout);
        } catch (err) {
            return /** @type {Error} */ (err).message;
        }
    }
    return { mapMode, deviceType, layout };
}

/** @param {string} host */
function privateHint(host) {
    if (net.isIP(host) !== 4) return null;
    const [a = 0, b = 0] = host.split('.').map(Number); // a valid IPv4 address always has both
    const isPrivate = a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || a === 127;
    return isPrivate ? null : `${host} is not a private (RFC 1918) address; check the IP plan before routing this network`;
}

/**
 * Wait for a probe lease to identify, but give up as soon as its connection
 * attempt fails, with the real reason (refused, timeout) instead of a generic
 * "not ready". Probe leases never retry, so waiting longer can't help.
 * @param {Lease} lease
 * @param {number} timeoutMs
 * @returns {Promise<Identity>}
 */
function readyOrDown(lease, timeoutMs) {
    return new Promise((resolve, reject) => {
        /** @param {import('../AlicatClient').StateChange} change */
        const onState = (change) => {
            if (change.state !== 'BACKOFF') return;
            cleanup();
            reject(change.error || lease.client.lastError);
        };
        const cleanup = () => lease.client.removeListener('state', onState);
        lease.client.on('state', onState);
        lease.device.ready(timeoutMs).then(
            (identity) => { cleanup(); resolve(identity); },
            (err) => { cleanup(); reject(err); }
        );
    });
}

/**
 * @typedef {{host: string, port: number, unitId: number, settings: {mapMode: string, deviceType: string, layout: string | string[] | null}}} ProbeTarget
 * @typedef {InstanceType<typeof import('../ConnectionRegistry').ConnectionRegistry>} Registry
 */

/** How long a test may take to identify the device. */
const PROBE_READY_MS = 8000;
/** The test's own connection: quick to give up, no heartbeat, no reconnect. */
const PROBE_CLIENT = Object.freeze({ connectTimeoutMs: 4000, requestTimeoutMs: 1500, heartbeatMs: 0, backoffInitialMs: 60000 });

/**
 * The device a probe request names, checked; or what is wrong with it.
 * @param {unknown} rawBody
 * @returns {ProbeTarget | string}
 */
function probeTarget(rawBody) {
    const body = /** @type {{[key: string]: unknown}} */ (rawBody && typeof rawBody === 'object' ? rawBody : {});
    const host = String(body.host || '').trim();
    const port = Number(body.port || MODBUS_PORT);
    const unitId = Number(body.unitId ?? 1);
    const validPort = Number.isInteger(port) && port >= 1 && port <= 65535;
    const validUnit = Number.isInteger(unitId) && unitId >= 0 && unitId <= 247;
    if (!host || /[/\s]/.test(host) || !validPort || !validUnit) {
        return 'host, port (1–65535) and unit ID (0–247) are required';
    }
    const settings = probeSettings(body);
    return typeof settings === 'string' ? settings : { host, port, unitId, settings };
}

/**
 * Identify the device and read it once: through the live connection if one
 * exists, otherwise over a connection of the test's own, closed straight after.
 * @param {Registry} registry
 * @param {ProbeTarget} target
 * @returns {Promise<object>} the response body
 */
async function runProbe(registry, target) {
    const { host, port, unitId, settings } = target;
    const started = Date.now();
    const live = registry.find(host, port);
    /** @type {Lease | null} */
    let lease = null;
    try {
        let device;
        /** @type {Promise<Identity>} */
        let ready;
        if (live) {
            device = live.device;
            ready = device.ready(PROBE_READY_MS);
        } else {
            lease = registry.acquire({ host, port, unitId, owner: 'editor-probe', clientOptions: PROBE_CLIENT, deviceOptions: settings });
            device = lease.device;
            ready = readyOrDown(lease, PROBE_READY_MS);
        }
        const identity = await ready;
        const snapshot = await device.readLive();
        return {
            ok: true,
            reused: Boolean(live),
            elapsedMs: Date.now() - started,
            hint: privateHint(host),
            identity: {
                generation: identity.generation, firmware: identity.firmware, serial: identity.serial,
                controlledVariable: identity.controlledVariable, readings: identity.readings.map((r) => r.key)
            },
            snapshot: { values: snapshot.values, units: snapshot.units, gas: snapshot.gas, status: snapshot.status.active, rttMs: snapshot.rttMs }
        };
    } catch (err) {
        return { ok: false, ...errorInfo(err), hint: privateHint(host) };
    } finally {
        // Close the test's own connection now (unless a node started using it meanwhile).
        if (lease) lease.release({ immediate: true });
    }
}

/**
 * Editor-side endpoints:
 * - POST /alicat-modbus/probe: the config editor's "Test connection". It
 *   reuses the live connection if one exists, so it never opens a second socket.
 * - GET /alicat-modbus/gases and /alicat-modbus/meta: dropdown data.
 * @param {NodeRedRuntime} RED
 * @param {Registry} registry
 */
function registerAdminApi(RED, registry) {
    const app = RED.httpAdmin;
    if (!app || app[REGISTERED]) return;
    app[REGISTERED] = true;
    /** @type {Set<string>} */
    const inflight = new Set();

    app.post('/alicat-modbus/probe', RED.auth.needsPermission('alicat-device.write'), async (req, res) => {
        const target = probeTarget(req.body);
        if (typeof target === 'string') {
            res.status(400).json({ ok: false, code: 'EINVALIDARG', message: target });
            return;
        }
        const { host, port } = target;
        if (!probePortAllowed(RED, port) && !registry.find(host, port)) { // a live connection opens nothing new
            res.status(403).json({ ok: false, code: 'EFORBIDDEN',
                message: `Test connection only uses port ${MODBUS_PORT}; allow port ${port} with alicatModbus.probePorts in settings.js` });
            return;
        }
        const key = `${host.toLowerCase()}:${port}`;
        if (inflight.has(key)) {
            res.status(409).json({ ok: false, code: 'EBUSY', message: 'A test of this device is already running' });
            return;
        }
        if (inflight.size >= MAX_CONCURRENT_PROBES) {
            res.status(429).json({ ok: false, code: 'EBUSY', message: 'Other connection tests are running; try again in a few seconds' });
            return;
        }
        inflight.add(key);
        try {
            res.json(await runProbe(registry, target));
        } finally {
            inflight.delete(key);
        }
    });

    app.get('/alicat-modbus/gases', RED.auth.needsPermission('alicat-device.read'), (_req, res) => {
        res.json(listGases());
    });

    app.get('/alicat-modbus/meta', RED.auth.needsPermission('alicat-device.read'), (_req, res) => {
        res.json({
            layouts: LAYOUT_PRESETS,
            slotKeys: Object.keys(SLOT_KEYS),
            controlVariables: Object.fromEntries(Object.entries(CONTROL_VARIABLES).map(([k, v]) => [k, v.label]))
        });
    });
}

module.exports = { registerAdminApi, privateHint };
