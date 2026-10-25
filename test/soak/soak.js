#!/usr/bin/env node
'use strict';

// Soak test. The real Node-RED runtime runs embedded in this process and
// drives simulated instruments with a mixed workload. Faults, redeploys and
// stop/start cycles run on a schedule. Real units can be added; they are only
// read (plus an occasional forced reconnect), never written.
//
//   npm run soak -- --hours 24 --real 192.0.2.10 --real 192.0.2.11@extended-7
//   npm run soak -- --minutes 10 --fault-every 20 --redeploy-every 90 --stop-start-every 240 --sample-every 10
//
// Output in soak-results/<start time>/:
//   metrics.jsonl  one sample per --sample-every seconds (memory, handles, queues, latency, message counts)
//   events.jsonl   faults, recoveries, deploys, warnings and invariant violations
//   summary.md / summary.json
// Exit code 0 when every invariant held (and, for runs with ≥ 2 h after
// warm-up, memory and handle counts stayed flat).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { monitorEventLoopDelay } = require('perf_hooks');
const { AlicatSimulator } = require('../../tools/sim/AlicatSimulator');
const { getRegistry } = require('../../lib/ConnectionRegistry');
const { parseCli, numberOption } = require('../../tools/cli');

const ROOT = path.join(__dirname, '..', '..');
const PACKAGE_NAME = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).name;

// ------------------------------------------------------------------ options

const SECONDS = /** @type {const} */ (['fault-every', 'redeploy-every', 'stop-start-every', 'reconnect-real-every', 'sample-every', 'warmup', 'recovery-limit']);
const OPTIONS = {
    hours: { type: 'string' }, minutes: { type: 'string' }, devices: { type: 'string' }, real: { type: 'string', multiple: true },
    out: { type: 'string' }, 'heap-snapshots': { type: 'string' }, help: { type: 'boolean' },
    ...Object.fromEntries(SECONDS.map((k) => [k, { type: 'string' }]))
};

/** @param {string[]} argv */
function parseArgs(argv) {
    const { values } = parseCli(argv, /** @type {any} */ (OPTIONS));
    const seconds = (/** @type {string} */ k, /** @type {number} */ d, min = 1) => numberOption(values, k, { fallback: d, min, max: 7 * 86400, integer: false }) * 1000;
    const durationMs = values.minutes !== undefined
        ? numberOption(values, 'minutes', { fallback: 0, min: 0.1, max: 7 * 1440, integer: false }) * 60e3
        : numberOption(values, 'hours', { fallback: 24, min: 0.01, max: 7 * 24, integer: false }) * 3600e3;
    return {
        help: Boolean(values.help),
        durationMs,
        devices: numberOption(values, 'devices', { fallback: 20, min: 0, max: 500 }),
        real: /** @type {string[]} */ (values.real || []).map(parseReal),
        faultEveryMs: seconds('fault-every', 300),
        redeployEveryMs: seconds('redeploy-every', 900),
        stopStartEveryMs: seconds('stop-start-every', 3600),
        reconnectRealEveryMs: seconds('reconnect-real-every', 3600),
        sampleEveryMs: seconds('sample-every', 60),
        warmupMs: values.warmup !== undefined ? seconds('warmup', 0, 0) : Math.min(30 * 60e3, durationMs * 0.1),
        recoveryLimitMs: seconds('recovery-limit', 90),
        // Minutes at which to write a V8 heap snapshot (after a full GC), e.g. "5,60". For leak hunting.
        heapSnapshotsMin: String(values['heap-snapshots'] || '').split(',').filter(Boolean).map((m) => {
            const n = Number(m);
            if (!Number.isFinite(n) || n <= 0) throw new Error(`--heap-snapshots needs minutes such as 5,60, got ${JSON.stringify(m)}`);
            return n;
        }),
        out: typeof values.out === 'string' ? values.out : path.join(ROOT, 'soak-results')
    };
}

/** "host[:port][@layout]" @param {string} spec */
function parseReal(spec) {
    const [address = '', layout] = spec.split('@');
    const [host = '', port] = address.split(':');
    const portNumber = Number(port || 502);
    if (!host || !Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535) {
        throw new Error(`--real needs host[:port][@layout], got ${JSON.stringify(spec)}`);
    }
    return { host, port: portNumber, layout: layout || 'auto' };
}

// ----------------------------------------------------------- small helpers

/** Latency histogram: 1 ms buckets to 1 s, then 100 ms buckets to 10 s. */
class Histogram {
    constructor() {
        this.counts = new Uint32Array(1091);
        this.n = 0;
        this.max = 0;
    }

    /** @param {number} ms */
    add(ms) {
        if (!Number.isFinite(ms) || ms < 0) return;
        const i = ms < 1000 ? Math.floor(ms) : Math.min(1090, 1000 + Math.floor((ms - 1000) / 100));
        this.counts[i]++;
        this.n++;
        if (ms > this.max) this.max = ms;
    }

    /** Upper bound of the bucket holding the p-th percentile. @param {number} p 0–100 */
    pct(p) {
        if (this.n === 0) return null;
        const target = Math.ceil((p / 100) * this.n);
        let seen = 0;
        for (let i = 0; i < this.counts.length; i++) {
            seen += this.counts[i];
            if (seen >= target) return i < 1000 ? i + 1 : 1000 + (i - 999) * 100;
        }
        return this.max;
    }

    /** @param {Histogram} other */
    merge(other) {
        for (let i = 0; i < this.counts.length; i++) this.counts[i] += other.counts[i];
        this.n += other.n;
        this.max = Math.max(this.max, other.max);
    }
}

/** Least-squares slope of y over x. @param {number[]} xs @param {number[]} ys */
function slope(xs, ys) {
    const n = xs.length;
    if (n < 3) return null;
    const mx = xs.reduce((a, b) => a + b, 0) / n;
    const my = ys.reduce((a, b) => a + b, 0) / n;
    let num = 0;
    let den = 0;
    for (let i = 0; i < n; i++) {
        num += (xs[i] - mx) * (ys[i] - my);
        den += (xs[i] - mx) ** 2;
    }
    return den === 0 ? null : num / den;
}

/** @param {Record<string, number>} counter @param {string} key @param {number} [by] */
const bump = (counter, key, by = 1) => { counter[key] = (counter[key] || 0) + by; };
const delay = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));
const mb = (/** @type {number} */ bytes) => Math.round((bytes / 1048576) * 10) / 10;
const hms = (/** @type {number} */ ms) => new Date(ms).toISOString().slice(11, 19);

// ------------------------------------------------------------------ workload

/** One kind per device, cycling; each sim profile gets setpoints inside its range. */
const KINDS = [
    { profile: '10v20-mfc', workload: 'control', spMax: 18, layout: 'auto', controlVariable: 'unknown' },
    { profile: '10v20-mfc', workload: 'commands', spMax: 18, layout: 'auto', controlVariable: 'unknown' },
    { profile: '10v20-bench', workload: 'commands', spMax: 50, layout: 'auto', controlVariable: 'unknown' },
    { profile: '9v07-bench', workload: 'control', spMax: 1500, layout: 'extended-7', controlVariable: 'massFlow' }
];

/**
 * Faults, applied in turn to the simulated devices. `apply` returns how long
 * the fault lasts (0 = one-shot, consumed by the next request); `clear` ends it.
 * `errorWindowMs`: how long after recovery errors still count as caused by the
 * fault (default 10 s).
 * @type {{name: string, apply: (sim: any) => number | Promise<number>, clear?: (sim: any) => void | Promise<void>, errorWindowMs?: number}[]}
 */
const FAULTS = [
    { name: 'silent-20s', apply: (s) => { s.faults.silent = true; return 20000; }, clear: (s) => { s.faults.silent = false; } },
    { name: 'rst-mid-frame', apply: (s) => { s.faults.rstMidFrame = true; return 0; } },
    { name: 'garbage-frame', apply: (s) => { s.faults.garbageNextResponse = true; return 0; } },
    {
        name: 'refuse-30s',
        apply: (s) => { s.faults.refuseConnections = true; s.server.dropConnections(); return 30000; },
        clear: (s) => { s.faults.refuseConnections = false; }
    },
    { name: 'busy-exception-15s', apply: (s) => { s.faults.exceptionCode = 6; return 15000; }, clear: (s) => { s.faults.exceptionCode = 0; } },
    {
        name: 'restart-10s',
        apply: async (s) => { await s.stop(); return 10000; },
        clear: async (s) => {
            for (let attempt = 0; ; attempt++) {
                try {
                    await s.start(s.port, '127.0.0.1');
                    return;
                } catch (err) {
                    if (attempt >= 15) throw err;
                    await delay(2000); // port still held by the OS
                }
            }
        }
    },
    { name: 'drop-3-responses', apply: (s) => { s.faults.dropResponses = 3; return 0; } },
    { name: 'slow-800ms-30s', apply: (s) => { s.faults.responseDelayMs = 800; return 30000; }, clear: (s) => { s.faults.responseDelayMs = 0; } },
    { name: 'split-frames-60s', apply: (s) => { s.faults.splitResponses = true; return 60000; }, clear: (s) => { s.faults.splitResponses = false; } },
    // Two drops in a row defeat the lane's single resend: that command times out after its 10 s deadline.
    { name: 'drop-2-commands', apply: (s) => { s.engine.dropNextCommands = 2; return 0; }, errorWindowMs: 20000 }
];

/** The watch runs every second; a gap longer than this means the host slept or the process was suspended. */
const HOST_SUSPEND_GAP_MS = 30000;

/**
 * @typedef {{name: string, host: string, port: number, layout: string, controlVariable: string,
 *            kind: typeof KINDS[number] | null, real: boolean, sim: any, readMs: number}} DeviceSpec
 */

/**
 * The flows for every device: one tab each. `variant` changes one tab's slow
 * read interval, so a "flows" deploy has something to restart. (Timed work
 * longer than the redeploy interval would never fire, because a full deploy
 * restarts every inject; the harness drives that work itself.)
 * @param {DeviceSpec[]} devices
 * @param {number} variant
 */
function buildFlows(devices, variant) {
    /** @type {any[]} */
    const flows = [];
    devices.forEach((d, index) => {
        const id = d.name;
        const z = `tab-${id}`;
        const sink = (/** @type {string} */ kind) => `sink-${id}-${kind}`;
        let y = 40;
        const at = () => ({ z, x: 200, y: (y += 60) });
        flows.push({ id: z, type: 'tab', label: id });
        flows.push({
            id: `dev-${id}`, type: 'alicat-device', name: id, host: d.host, port: String(d.port), unitId: '1',
            mapMode: 'auto', deviceType: 'auto', layout: d.layout, customLayout: '', controlVariable: d.controlVariable, unitLabels: '',
            requestTimeout: '1000', connectTimeout: '5000', interFrameDelay: '20', heartbeat: '5000', backoffMax: '30000',
            maxQueue: '200', trace: false
        });
        for (const kind of ['read', 'status', 'catch', 'control', 'cmd']) {
            flows.push({ id: sink(kind), type: 'debug', ...at(), active: false, tosidebar: false, console: false, tostatus: false, complete: 'false', wires: [] });
        }
        const read = (/** @type {string} */ rid, /** @type {number} */ interval) => ({
            id: rid, type: 'alicat-read', ...at(), device: `dev-${id}`, trigger: 'interval', interval: String(interval), dataset: 'live',
            output: 'object', reading: 'massFlow', emit: 'always', topic: '', contextScope: 'global', contextKey: '', contextStore: '',
            wires: [[sink('read')]]
        });
        flows.push(read(`rd-${id}`, d.readMs));
        if (!d.real) flows.push(read(`rs-${id}`, variant % devices.length === index && variant % 2 === 1 ? 6000 : 5000));
        flows.push({ id: `st-${id}`, type: 'alicat-status', ...at(), device: `dev-${id}`, periodic: '0', wires: [[sink('status')]] });
        flows.push({ id: `ca-${id}`, type: 'catch', ...at(), scope: null, uncaught: false, wires: [[sink('catch')]] });

        const inject = (/** @type {string} */ iid, /** @type {number} */ everyS, /** @type {number} */ offsetS,
            /** @type {string} */ payload, /** @type {string} */ payloadType, /** @type {string} */ target) => ({
            id: iid, type: 'inject', ...at(), props: [{ p: 'payload' }], repeat: String(everyS), crontab: '',
            once: offsetS > 0, onceDelay: offsetS, topic: '', payload, payloadType, wires: [[target]]
        });

        if (d.real) return; // read-only: no workload
        const kind = /** @type {typeof KINDS[number]} */ (d.kind);
        const randomSp = `$round($random() * ${kind.spMax}, 2)`;
        if (kind.workload === 'control') {
            flows.push({
                id: `ct-${id}`, type: 'alicat-control', ...at(), device: `dev-${id}`, interval: '500', tolerance: '', correctionMs: '1000',
                maxAttempts: '5', onExternalChange: 'revert', switchMode: 'bumpless', wires: [[sink('control')]]
            });
            flows.push(inject(`ij-${id}-sp`, 20, 1, `{"setpoint": ${randomSp}, "valve": "auto"}`, 'jsonata', `ct-${id}`));
            flows.push(inject(`ij-${id}-hold`, 300, 150, '{"valve":"hold-closed"}', 'json', `ct-${id}`));
        } else {
            const cmd = (/** @type {string} */ cid, /** @type {string} */ command) => ({
                id: cid, type: 'alicat-command', ...at(), device: `dev-${id}`, command, arg: 'payload', argType: 'msg', allowRaw: false,
                rawId: '', rawArg: '', fallbackSetpointZero: false, wires: [[sink('cmd')]]
            });
            flows.push({
                id: `sp-${id}`, type: 'alicat-setpoint', ...at(), device: `dev-${id}`, value: 'payload', valueType: 'msg', variable: 'current',
                switchMode: 'bumpless', outOfRange: 'clamp', verify: true, savePowerUp: false, wires: [[sink('cmd')]]
            });
            flows.push(inject(`ij-${id}-sp`, 10, 1, randomSp, 'jsonata', `sp-${id}`));
            flows.push(cmd(`hold-${id}`, 'holdClosed'), inject(`ij-${id}-hold`, 45, 5, '', 'date', `hold-${id}`));
            flows.push(cmd(`resume-${id}`, 'resume'), inject(`ij-${id}-resume`, 45, 8, '', 'date', `resume-${id}`));
            flows.push(cmd(`tare-${id}`, 'tareFlow'), inject(`ij-${id}-tare`, 120, 20, '', 'date', `tare-${id}`));
            flows.push(cmd(`gas-${id}`, 'selectGas'), inject(`ij-${id}-gas`, 300, 30, '$random() < 0.5 ? 0 : 8', 'jsonata', `gas-${id}`));
            flows.push({ id: `pid-${id}`, type: 'alicat-pid', ...at(), device: `dev-${id}`, action: 'read', algorithm: 'PDF', wires: [[sink('cmd')]] });
            flows.push(inject(`ij-${id}-pid`, 180, 40, '', 'date', `pid-${id}`));
        }
    });
    return flows;
}

// --------------------------------------------------------------------- soak

async function main() {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.help) {
        console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(2, 18).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
        return 0;
    }
    if (!(opts.durationMs > 0)) throw new Error('--hours or --minutes must be > 0');
    if (typeof global.gc !== 'function') {
        console.warn('[soak] run with node --expose-gc (npm run soak does) for meaningful heap numbers');
    }

    const startedAt = Date.now();
    const runDir = path.join(opts.out, new Date(startedAt).toISOString().replace(/[:.]/g, '-'));
    fs.mkdirSync(runDir, { recursive: true });
    // Node-RED's user directory lives in the system temp folder, not under the results: it
    // holds a link back to this repository, which tools scanning the repo must not follow.
    const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alicat-soak-'));
    fs.mkdirSync(path.join(userDir, 'node_modules', path.dirname(PACKAGE_NAME)), { recursive: true }); // with the @scope folder
    fs.symlinkSync(ROOT, path.join(userDir, 'node_modules', PACKAGE_NAME), 'junction');
    const metricsFile = path.join(runDir, 'metrics.jsonl');
    const eventsFile = path.join(runDir, 'events.jsonl');

    /** @type {any[]} */
    const violations = [];
    /** @param {string} type @param {Record<string, unknown>} [data] */
    const event = (type, data = {}) => {
        fs.appendFileSync(eventsFile, `${JSON.stringify({ t: Date.now(), type, ...data })}\n`);
    };
    /** @param {string} kind @param {Record<string, unknown>} [data] */
    const violation = (kind, data = {}) => {
        violations.push({ t: Date.now(), kind, ...data });
        event('violation', { kind, ...data });
        console.log(`[soak ${hms(Date.now() - startedAt)}] VIOLATION ${kind} ${JSON.stringify(data)}`);
    };
    process.on('unhandledRejection', (reason) => violation('unhandled-rejection', { error: String(/** @type {any} */ (reason)?.stack || reason) }));
    process.on('uncaughtException', (err) => violation('uncaught-exception', { error: String(err.stack || err) }));

    // ---- simulators
    /** @type {DeviceSpec[]} */
    const devices = [];
    for (let i = 0; i < opts.devices; i++) {
        const kind = KINDS[i % KINDS.length];
        const sim = await new AlicatSimulator({ profile: kind.profile, maxConnections: 2, idleTimeoutMs: 20000, serial: 900000 + i }).start(0, '127.0.0.1');
        const spec = {
            name: `sim-${String(i + 1).padStart(2, '0')}`, host: '127.0.0.1', port: sim.port, layout: kind.layout,
            controlVariable: kind.controlVariable, kind, real: false, sim, readMs: i % 2 === 0 ? 200 : 1000
        };
        // Allow 2 connections so a collision is visible as a second accepted socket, not just a refusal.
        sim.server.on('connection', () => {
            if (sim.server.connectionCount >= 2) violation('socket-collision', { device: spec.name, open: sim.server.connectionCount });
        });
        sim.server.on('rejected', () => {
            if (!sim.faults.refuseConnections) violation('unexpected-rejection', { device: spec.name });
        });
        devices.push(spec);
    }
    opts.real.forEach((r, i) => devices.push({
        name: `real-${i + 1}-${r.host}`, host: r.host, port: r.port, layout: r.layout, controlVariable: 'unknown',
        kind: null, real: true, sim: null, readMs: 1000
    }));
    const sims = devices.filter((d) => !d.real);

    // ---- per-device and window state
    /**
     * @typedef {{lastGoodAt: number, good: number, stale: number, offline: number, errors: Record<string, number>,
     *            maxGapMs: number, staleEpisode: boolean}} DeviceState
     */
    /** @type {Map<string, DeviceState>} */
    const state = new Map(devices.map((d) => [d.name, { lastGoodAt: Date.now(), good: 0, stale: 0, offline: 0, errors: {}, maxGapMs: 0, staleEpisode: false }]));
    const totalLatency = new Histogram();
    /** @type {Histogram[]} */
    const hourlyLatency = [];
    let window = newWindow();
    const totals = { reads: 0, good: 0, stale: 0, offline: 0, errors: /** @type {Record<string, number>} */ ({}),
        outcomes: /** @type {Record<string, number>} */ ({}), control: /** @type {Record<string, number>} */ ({}), warnings: 0, logErrors: 0 };
    /** @type {{t: number, device: string, code: string, source: string, message: string}[]} */
    const errorLog = [];
    /** @type {Record<string, {count: number, sample: string}>} */
    const warnings = {};
    /** @type {{device: string, fault: string, start: number, end: number, recoveredAt: number | null, deadline: number, reported: boolean, errorWindowMs: number}[]} */
    const faults = [];
    /** @type {Set<string>} devices with a fault in progress */
    const faulted = new Set();
    let lastStopStartAt = 0;
    /** @type {Map<string, number>} */
    const realReconnectAt = new Map();
    /** Latency is only measured on healthy devices; a fault like "slow responses" would swamp it. @param {string} name */
    const underFault = (name) => faulted.has(name) || faults.some((f) => f.device === name && f.recoveredAt === null);

    function newWindow() {
        return { latency: new Histogram(), reads: 0, good: 0, stale: 0, offline: 0, errors: /** @type {Record<string, number>} */ ({}),
            outcomes: /** @type {Record<string, number>} */ ({}), control: /** @type {Record<string, number>} */ ({}), warnings: 0 };
    }

    /** @param {string} name @param {string} kind @param {any} msg */
    function record(name, kind, msg) {
        const now = Date.now();
        const st = /** @type {DeviceState} */ (state.get(name));
        const a = msg.alicat || {};
        if (kind === 'read') {
            window.reads++;
            totals.reads++;
            if (a.quality === 'good') {
                window.good++;
                totals.good++;
                st.good++;
                st.maxGapMs = Math.max(st.maxGapMs, now - st.lastGoodAt);
                st.lastGoodAt = now;
                st.staleEpisode = false;
                if (Number.isFinite(a.rttMs) && !underFault(name)) {
                    window.latency.add(a.rttMs);
                    totalLatency.add(a.rttMs);
                    const hour = Math.floor((now - startedAt) / 3600e3);
                    (hourlyLatency[hour] ||= new Histogram()).add(a.rttMs);
                }
            } else if (a.quality === 'offline') {
                window.offline++; totals.offline++; st.offline++;
            } else {
                window.stale++; totals.stale++; st.stale++;
            }
        } else if (kind === 'catch') {
            const code = (a.error && a.error.code) || (msg.error && msg.error.code) || 'ERROR';
            bump(window.errors, code);
            bump(totals.errors, code);
            bump(st.errors, code);
            if (errorLog.length < 50000) {
                errorLog.push({ t: now, device: name, code, source: msg.error && msg.error.source ? msg.error.source.type : '?', message: String(msg.error && msg.error.message).slice(0, 200) });
            }
        } else if (kind === 'cmd') {
            const outcome = (msg.payload && msg.payload.outcome) || (a.outcome) || 'ok';
            bump(window.outcomes, outcome);
            bump(totals.outcomes, outcome);
        } else if (kind === 'control') {
            bump(window.control, String(msg.topic || (msg.payload && msg.payload.event)));
            bump(totals.control, String(msg.topic || (msg.payload && msg.payload.event)));
        }
    }

    // ---- Node-RED, embedded
    const RED = require('node-red');
    RED.init({
        userDir,
        flowFile: 'flows.json',
        credentialSecret: false,
        httpAdminRoot: false,
        httpNodeRoot: false,
        runtimeState: { enabled: true },
        editorTheme: { projects: { enabled: false } },
        logging: {
            soak: {
                level: 'warn',
                metrics: false,
                audit: false,
                handler: () => (/** @type {any} */ msg) => {
                    const text = `${msg.type ? `[${msg.type}${msg.name ? `:${msg.name}` : ''}] ` : ''}${msg.msg}`;
                    if (msg.level <= 20) totals.logErrors++;
                    totals.warnings++;
                    window.warnings++;
                    const key = String(msg.msg).replace(/\d+/g, '#').slice(0, 120);
                    if (!warnings[key]) warnings[key] = { count: 0, sample: text.slice(0, 300) };
                    warnings[key].count++;
                    if (warnings[key].count <= 3) event('log', { level: msg.level, text: text.slice(0, 500) });
                }
            }
        }
    });
    /** @type {Map<string, {device: string, kind: string}>} */
    const sinks = new Map();
    for (const d of devices) {
        for (const kind of ['read', 'status', 'catch', 'control', 'cmd']) sinks.set(`sink-${d.name}-${kind}`, { device: d.name, kind });
    }
    RED.hooks.add('onReceive.soak', (/** @type {any} */ evt) => {
        const s = sinks.get(evt.destination && evt.destination.id);
        if (s) record(s.device, s.kind, evt.msg);
    });
    await RED.start();
    const registry = getRegistry();

    // ---- deploy helpers
    let variant = 0;
    /** @type {{t: number, kind: string, windowMs?: number}[]} */
    const disruptions = []; // deploys, stop/start, host sleep: errors during them are expected (default window 30 s)
    /** @param {'full' | 'flows'} type */
    async function deploy(type) {
        disruptions.push({ t: Date.now(), kind: `deploy-${type}` });
        if (type === 'flows') variant++;
        await RED.runtime.flows.setFlows({ flows: { flows: buildFlows(devices, variant) }, deploymentType: type });
        event('deploy', { deploymentType: type, variant });
    }

    // ---- leak baselines: listener and subscriber counts per device after the first deploy settles
    /** @param {{eventNames(): (string | symbol)[], listenerCount(name: string | symbol): number}} emitter */
    const listeners = (emitter) => emitter.eventNames().reduce((n, e) => n + emitter.listenerCount(e), 0);
    /** @type {Map<string, {subscribers: number, listeners: number}>} */
    const baseline = new Map();
    /** Subscribers must match exactly; a few listeners may come and go (requests waiting for `ready`). */
    const LISTENER_SLACK = 5;
    function checkShapes(/** @type {string} */ after) {
        const entries = registry.list();
        if (entries.length !== devices.length) violation('registry-size', { after, expected: devices.length, actual: entries.length });
        for (const d of devices) {
            const entry = registry.find(d.host, d.port);
            if (!entry || entry.client.state !== 'ONLINE' || entry.device.state !== 'READY' || faulted.has(d.name)) continue;
            const now = { subscribers: entry.device.subscriberCount, listeners: listeners(entry.client) + listeners(entry.device) };
            const base = baseline.get(d.name);
            if (!base) {
                baseline.set(d.name, now);
            } else if (now.subscribers !== base.subscribers || now.listeners > base.listeners + LISTENER_SLACK) {
                violation('listener-or-subscriber-leak', { after, device: d.name, baseline: base, now });
            }
        }
    }

    await deploy('full');
    console.log(`[soak] ${sims.length} simulated + ${opts.real.length} real devices; running ${Math.round(opts.durationMs / 60e3)} min; results in ${runDir}`);
    event('start', { opts: { ...opts, real: opts.real }, node: process.version, nodeRed: RED.version(), pid: process.pid });
    setTimeout(() => checkShapes('first deploy'), 20000);

    // ---- fault injection and recovery tracking
    let faultCount = 0;
    async function injectFault() {
        if (sims.length === 0) return;
        const k = faultCount++;
        const fault = FAULTS[k % FAULTS.length];
        const d = sims[(k * 7) % sims.length];
        if (faulted.has(d.name)) return;
        faulted.add(d.name);
        const start = Date.now();
        try {
            const duration = await fault.apply(d.sim);
            event('fault', { device: d.name, fault: fault.name, durationMs: duration });
            if (duration > 0) await delay(duration);
            if (fault.clear) await fault.clear(d.sim);
        } catch (err) {
            violation('fault-harness-error', { device: d.name, fault: fault.name, error: String(/** @type {any} */ (err).message) });
        }
        const end = Date.now() + (fault.clear ? 0 : 2000);
        faults.push({
            device: d.name, fault: fault.name, start, end, recoveredAt: null, deadline: end + opts.recoveryLimitMs, reported: false,
            errorWindowMs: fault.errorWindowMs ?? 10000
        });
        faulted.delete(d.name);
    }

    let lastWatchAt = Date.now();
    let hostResumedAt = 0;
    function watch() {
        const now = Date.now();
        const gap = now - lastWatchAt;
        lastWatchAt = now;
        if (gap > HOST_SUSPEND_GAP_MS) {
            // This runs every second: a long gap means the PC slept or the process was suspended.
            hostResumedAt = now;
            disruptions.push({ t: now - gap, kind: 'host-suspended', windowMs: gap + opts.recoveryLimitMs });
            event('host-suspended', { gapMs: gap });
            for (const f of faults) if (f.recoveredAt === null) f.deadline += gap;
        }
        // Recovery: a good reading after the fault ended.
        for (const f of faults) {
            if (f.recoveredAt !== null) continue;
            const st = /** @type {DeviceState} */ (state.get(f.device));
            if (st.lastGoodAt > f.end) {
                f.recoveredAt = st.lastGoodAt;
                event('recovered', { device: f.device, fault: f.fault, afterMs: f.recoveredAt - f.end });
            } else if (now > f.deadline && !f.reported) {
                if (now - lastStopStartAt < opts.recoveryLimitMs) {
                    f.deadline += 30000; // the runtime was stopped meanwhile
                } else {
                    f.reported = true;
                    violation('no-recovery', { device: f.device, fault: f.fault, sinceFaultEndMs: now - f.end });
                }
            }
        }
        // Staleness without a reason (no fault, no stop/start, no forced reconnect).
        for (const d of devices) {
            const st = /** @type {DeviceState} */ (state.get(d.name));
            const quietFor = now - st.lastGoodAt;
            const excused = faulted.has(d.name)
                || faults.some((f) => f.device === d.name && f.recoveredAt === null)
                || now - lastStopStartAt < opts.recoveryLimitMs
                || now - (realReconnectAt.get(d.name) || 0) < opts.recoveryLimitMs
                || now - hostResumedAt < opts.recoveryLimitMs
                || now - startedAt < opts.recoveryLimitMs;
            if (quietFor > opts.recoveryLimitMs && !excused && !st.staleEpisode) {
                st.staleEpisode = true;
                const entry = registry.find(d.host, d.port);
                const client = entry ? {
                    state: entry.client.state, attempt: entry.client.stats().attempt,
                    lastError: entry.client.lastError ? entry.client.lastError.message : null
                } : null;
                violation(d.real ? 'real-device-stale' : 'stale-without-fault', { device: d.name, quietForMs: quietFor, client });
            }
        }
        // Stuck command lane: the same job active for more than 60 s.
        for (const d of devices) {
            const entry = registry.find(d.host, d.port);
            const active = entry && entry.device.lane.activeCommand;
            if (!active) continue;
            const first = laneSeen.get(active);
            if (first === undefined) laneSeen.set(active, now);
            else if (now - first > 60000 && !laneReported.has(active)) {
                laneReported.add(active);
                violation('stuck-command-lane', { device: d.name, command: active.label || `command ${active.id}`, activeForMs: now - first });
            }
        }
    }
    /** @type {WeakMap<object, number>} */
    const laneSeen = new WeakMap();
    /** @type {WeakSet<object>} */
    const laneReported = new WeakSet();

    async function stopStart() {
        lastStopStartAt = Date.now();
        disruptions.push({ t: lastStopStartAt, kind: 'stop-start' });
        await RED.runtime.flows.setState({ state: 'stop' });
        await delay(3000);
        const open = sims.filter((d) => d.sim.server.connectionCount > 0).map((d) => d.name);
        const entries = registry.list().length;
        event('stopped', { registryEntries: entries, simsWithOpenSockets: open });
        if (entries > 0 || open.length > 0) violation('stop-left-connections', { registryEntries: entries, simsWithOpenSockets: open });
        await delay(2000);
        await RED.runtime.flows.setState({ state: 'start' });
        lastStopStartAt = Date.now();
        event('started');
        setTimeout(() => checkShapes('stop/start'), 20000);
    }

    // ---- sampling
    const eld = monitorEventLoopDelay({ resolution: 20 });
    eld.enable();
    /** @type {{t: number, heap: number, rss: number, resources: number}[]} */
    const memSeries = [];
    let faultsSeen = 0;
    function sample() {
        if (typeof global.gc === 'function') global.gc();
        const now = Date.now();
        const mem = process.memoryUsage();
        /** @type {Record<string, number>} */
        const resources = {};
        // Node ≥ 17.3 (experimental); missing from @types/node 18.
        const proc = /** @type {NodeJS.Process & {getActiveResourcesInfo(): string[]}} */ (process);
        for (const r of proc.getActiveResourcesInfo()) bump(resources, r);
        const resourceCount = Object.values(resources).reduce((a, b) => a + b, 0);
        memSeries.push({ t: now, heap: mem.heapUsed, rss: mem.rss, resources: resourceCount });
        const perDevice = devices.map((d) => {
            const entry = registry.find(d.host, d.port);
            if (!entry) return { device: d.name, entry: null };
            const s = entry.client.stats();
            return {
                device: d.name, client: s.state, state: entry.device.state, attempt: s.attempt, depth: s.depth, inFlight: s.inFlight,
                lane: entry.device.lane ? entry.device.lane.depth : null, subscribers: entry.device.subscriberCount,
                sent: s.sent, ok: s.ok, timeouts: s.timeouts, exceptions: s.exceptions, rtt: s.rtt,
                sim: d.sim ? { open: d.sim.server.connectionCount, total: d.sim.stats.totalConnections, rejected: d.sim.stats.rejectedConnections } : undefined
            };
        });
        const line = {
            t: now, elapsedMs: now - startedAt,
            memory: { rss: mem.rss, heapUsed: mem.heapUsed, heapTotal: mem.heapTotal, external: mem.external, arrayBuffers: mem.arrayBuffers },
            resources, resourceCount,
            eventLoopDelayMs: { p99: eld.percentile(99) / 1e6, max: eld.max / 1e6 },
            window: {
                reads: window.reads, good: window.good, stale: window.stale, offline: window.offline,
                latencyMs: { p50: window.latency.pct(50), p99: window.latency.pct(99), max: window.latency.max },
                errors: window.errors, outcomes: window.outcomes, control: window.control, warnings: window.warnings
            },
            registryEntries: registry.list().length,
            devices: perDevice
        };
        fs.appendFileSync(metricsFile, `${JSON.stringify(line)}\n`);
        eld.reset();
        const recovered = faults.filter((f) => f.recoveredAt !== null);
        const maxRec = recovered.reduce((m, f) => Math.max(m, /** @type {number} */ (f.recoveredAt) - f.end), 0);
        faultsSeen = faults.length;
        console.log(`[soak ${hms(now - startedAt)}] rss ${mb(mem.rss)} MB, heap ${mb(mem.heapUsed)} MB, handles ${resourceCount}, ` +
            `reads ${window.reads} (${window.good} good), p99 ${window.latency.pct(99) ?? '-'} ms, errors ${Object.values(window.errors).reduce((a, b) => a + b, 0)}, ` +
            `faults ${faultsSeen} (recovered ${recovered.length}, max ${(maxRec / 1000).toFixed(1)} s), violations ${violations.length}`);
        window = newWindow();
    }

    // ---- schedule
    /** @type {NodeJS.Timeout[]} */
    const timers = [];
    let busy = Promise.resolve();
    /** Deploys, stop/start and faults never overlap with each other. @param {() => Promise<void>} job */
    const serial = (job) => { busy = busy.then(job).catch((err) => violation('harness-error', { error: String(err && err.stack || err) })); };
    // A fault can last up to 60 s; with a faster schedule, skip ticks instead of queueing faults without end.
    let faultQueued = false;
    timers.push(setInterval(() => {
        if (faultQueued) return;
        faultQueued = true;
        serial(() => injectFault().finally(() => { faultQueued = false; }));
    }, opts.faultEveryMs));
    let deployCount = 0;
    timers.push(setInterval(() => serial(async () => {
        await deploy(deployCount++ % 2 === 0 ? 'full' : 'flows');
        setTimeout(() => checkShapes('deploy'), 20000);
    }), opts.redeployEveryMs));
    timers.push(setInterval(() => serial(stopStart), opts.stopStartEveryMs));
    timers.push(setInterval(watch, 1000));
    timers.push(setInterval(sample, opts.sampleEveryMs));
    for (const minute of opts.heapSnapshotsMin) {
        timers.push(setTimeout(() => {
            if (typeof global.gc === 'function') global.gc();
            const file = require('v8').writeHeapSnapshot(path.join(runDir, `heap-${minute}min.heapsnapshot`));
            event('heap-snapshot', { minute, file, heapUsed: process.memoryUsage().heapUsed });
        }, minute * 60e3));
    }
    // Real devices: a forced reconnect now and then (what the alicat-status `reconnect` input does).
    // Offset by half an interval, so it doesn't land on a stop/start that has just closed the connection.
    const reconnectReal = () => {
        for (const d of devices) {
            const entry = d.real && registry.find(d.host, d.port);
            if (!entry) continue;
            realReconnectAt.set(d.name, Date.now());
            entry.client.reconnect();
            event('real-reconnect', { device: d.name });
        }
    };
    timers.push(setTimeout(() => {
        reconnectReal();
        timers.push(setInterval(reconnectReal, opts.reconnectRealEveryMs));
    }, opts.reconnectRealEveryMs / 2));

    // ---- finish
    let finishing = false;
    const finish = async (/** @type {string} */ why) => {
        if (finishing) return;
        finishing = true;
        for (const t of timers) clearInterval(t);
        await busy;
        sample();
        event('end', { why });
        try {
            await RED.stop();
        } catch (err) {
            violation('shutdown-error', { error: String(/** @type {any} */ (err).message) });
        }
        await Promise.all(sims.map((d) => d.sim.stop().catch(() => {})));
        const summary = summarize(why);
        fs.writeFileSync(path.join(runDir, 'summary.json'), JSON.stringify(summary, null, 2));
        fs.writeFileSync(path.join(runDir, 'summary.md'), renderSummary(summary));
        const link = path.join(userDir, 'node_modules', PACKAGE_NAME);
        try {
            fs.unlinkSync(link); // the link only, never the repo behind it
        } catch {
            // already gone
        }
        let linkGone = false;
        try {
            fs.lstatSync(link);
        } catch {
            linkGone = true;
        }
        // Delete the temporary user directory only once nothing in it points at the repository.
        if (linkGone) fs.rmSync(userDir, { recursive: true, force: true });
        console.log(renderSummary(summary));
        process.exit(summary.pass ? 0 : 1);
    };
    timers.push(setTimeout(() => finish('duration reached'), opts.durationMs));
    process.on('SIGINT', () => finish('interrupted'));
    process.on('SIGTERM', () => finish('terminated'));

    // ---- summary
    function summarize(/** @type {string} */ why) {
        const end = Date.now();
        const post = memSeries.filter((m) => m.t - startedAt >= opts.warmupMs);
        const hours = post.map((m) => (m.t - startedAt) / 3600e3);
        const judged = post.length >= 3 && (post[post.length - 1].t - post[0].t) >= 2 * 3600e3;
        const heapSlope = slope(hours, post.map((m) => m.heap / 1048576));
        const rssSlope = slope(hours, post.map((m) => m.rss / 1048576));
        const resFirst = post.slice(0, Math.max(1, Math.floor(post.length / 10)));
        const resLast = post.slice(-Math.max(1, Math.floor(post.length / 10)));
        const avg = (/** @type {number[]} */ xs) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
        const resourceGrowth = post.length ? avg(resLast.map((m) => m.resources)) / Math.max(1, avg(resFirst.map((m) => m.resources))) - 1 : null;

        /** @type {Record<string, {count: number, recovered: number, maxMs: number, recoveries: number[]}>} */
        const byFault = {};
        for (const f of faults) {
            const r = (byFault[f.fault] ||= { count: 0, recovered: 0, maxMs: 0, recoveries: [] });
            r.count++;
            if (f.recoveredAt !== null) {
                r.recovered++;
                r.maxMs = Math.max(r.maxMs, f.recoveredAt - f.end);
                r.recoveries.push(f.recoveredAt - f.end);
            }
        }
        // Errors outside every fault window (start → recovery + its error window) and outside every
        // disruption (deploys, stop/start, host sleep). EPREEMPTED is expected: the workload
        // deliberately overlaps hold-closed with tares.
        const unexpected = errorLog.filter((e) => {
            if (e.code === 'EPREEMPTED') return false;
            const inFault = faults.some((f) => f.device === e.device && e.t >= f.start - 1000 && e.t <= (f.recoveredAt ?? end) + f.errorWindowMs);
            const inDisruption = disruptions.some((x) => e.t >= x.t && e.t <= x.t + (x.windowMs ?? 30000));
            return !inFault && !inDisruption;
        });
        /** @type {Record<string, number>} */
        const violationCounts = {};
        for (const v of violations) bump(violationCounts, v.kind);

        const thresholds = { heapSlopeMbPerHour: 1, resourceGrowth: 0.1, p99LatencyMs: 250 };
        const checks = {
            invariants: violations.length === 0,
            heap: !judged || (heapSlope !== null && heapSlope <= thresholds.heapSlopeMbPerHour),
            resources: !judged || (resourceGrowth !== null && resourceGrowth <= thresholds.resourceGrowth),
            latency: (totalLatency.pct(99) ?? 0) <= thresholds.p99LatencyMs
        };
        return {
            pass: Object.values(checks).every(Boolean),
            why,
            checks,
            thresholds,
            run: {
                start: new Date(startedAt).toISOString(), end: new Date(end).toISOString(), hours: (end - startedAt) / 3600e3,
                simulated: sims.length, real: devices.filter((d) => d.real).map((d) => `${d.host}:${d.port}@${d.layout}`),
                node: process.version, nodeRed: RED.version(), gcExposed: typeof global.gc === 'function', runDir
            },
            memory: {
                judged, warmupMs: opts.warmupMs,
                heapSlopeMbPerHour: heapSlope, rssSlopeMbPerHour: rssSlope,
                heapMb: { first: post[0] && mb(post[0].heap), last: post.length ? mb(post[post.length - 1].heap) : null, max: post.length ? mb(Math.max(...post.map((m) => m.heap))) : null },
                rssMb: { first: post[0] && mb(post[0].rss), last: post.length ? mb(post[post.length - 1].rss) : null, max: post.length ? mb(Math.max(...post.map((m) => m.rss))) : null },
                resources: { first: post[0] && post[0].resources, last: post.length ? post[post.length - 1].resources : null, growth: resourceGrowth }
            },
            latencyMs: {
                p50: totalLatency.pct(50), p95: totalLatency.pct(95), p99: totalLatency.pct(99), max: totalLatency.max,
                hourlyP99: hourlyLatency.map((h) => (h ? h.pct(99) : null))
            },
            reads: { total: totals.reads, good: totals.good, stale: totals.stale, offline: totals.offline },
            faults: {
                injected: faults.length,
                recovered: faults.filter((f) => f.recoveredAt !== null).length,
                pendingAtEnd: faults.filter((f) => f.recoveredAt === null && !f.reported).length, // still inside their recovery limit
                byType: byFault
            },
            violations: { count: violations.length, byKind: violationCounts, first: violations.slice(0, 20) },
            errors: { byCode: totals.errors, unexpected: unexpected.length, unexpectedSamples: unexpected.slice(0, 20) },
            commandOutcomes: totals.outcomes,
            controlEvents: totals.control,
            log: { warnings: totals.warnings, errors: totals.logErrors, top: Object.values(warnings).sort((a, b) => b.count - a.count).slice(0, 15) },
            devices: devices.map((d) => {
                const st = /** @type {DeviceState} */ (state.get(d.name));
                return { device: d.name, real: d.real, good: st.good, stale: st.stale, offline: st.offline, maxGapMs: st.maxGapMs, errors: st.errors,
                    sim: d.sim ? { totalConnections: d.sim.stats.totalConnections, rejected: d.sim.stats.rejectedConnections, peak: d.sim.stats.peakConnections } : undefined };
            })
        };
    }
    return new Promise(() => {}); // runs until finish() exits the process
}

/** @param {any} s */
function renderSummary(s) {
    const ok = (/** @type {boolean} */ b) => (b ? '✅' : '❌');
    const num = (/** @type {number | null | undefined} */ v, digits = 2) => (v === null || v === undefined ? '–' : Number(v).toFixed(digits));
    const lines = [
        `# Soak test: ${s.pass ? 'PASS' : 'FAIL'}`,
        '',
        `${s.run.start} → ${s.run.end} (${num(s.run.hours)} h, ${s.why}). Node ${s.run.node}, Node-RED ${s.run.nodeRed}.`,
        `${s.run.simulated} simulated devices${s.run.real.length ? `; real (read-only): ${s.run.real.join(', ')}` : ''}.`,
        '',
        '| Check | Result |',
        '|---|---|',
        `| Invariants (collisions, recovery, stuck lanes, leaks, unhandled rejections) | ${ok(s.checks.invariants)} ${s.violations.count} violation(s) |`,
        `| Heap slope after warm-up | ${ok(s.checks.heap)} ${num(s.memory.heapSlopeMbPerHour, 3)} MB/h${s.memory.judged ? '' : ' (run too short to judge)'} |`,
        `| Handle growth after warm-up | ${ok(s.checks.resources)} ${s.memory.resources.growth === null ? '–' : `${num(s.memory.resources.growth * 100, 1)} %`}${s.memory.judged ? '' : ' (run too short to judge)'} |`,
        `| Read round-trip p99 | ${ok(s.checks.latency)} ${s.latencyMs.p99 ?? '–'} ms (limit ${s.thresholds.p99LatencyMs}) |`,
        '',
        '## Faults and recovery',
        '',
        `${s.faults.injected} injected, ${s.faults.recovered} recovered${s.faults.pendingAtEnd ? `, ${s.faults.pendingAtEnd} still recovering when the run ended (within the limit)` : ''}.`,
        '',
        '| Fault | Count | Recovered | Max recovery |',
        '|---|---|---|---|',
        ...Object.entries(s.faults.byType).map(([k, v]) => `| ${k} | ${/** @type {any} */ (v).count} | ${/** @type {any} */ (v).recovered} | ${num(/** @type {any} */ (v).maxMs / 1000, 1)} s |`),
        '',
        '## Memory and handles (after warm-up)',
        '',
        `- Heap: ${s.memory.heapMb.first} → ${s.memory.heapMb.last} MB (max ${s.memory.heapMb.max}); slope ${num(s.memory.heapSlopeMbPerHour, 3)} MB/h.`,
        `- RSS: ${s.memory.rssMb.first} → ${s.memory.rssMb.last} MB (max ${s.memory.rssMb.max}); slope ${num(s.memory.rssSlopeMbPerHour, 3)} MB/h.`,
        `- Active handles: ${s.memory.resources.first} → ${s.memory.resources.last}.`,
        '',
        '## Traffic',
        '',
        `- Reads: ${s.reads.total} (${s.reads.good} good, ${s.reads.stale} stale, ${s.reads.offline} offline).`,
        `- Round trip: p50 ${s.latencyMs.p50} ms, p95 ${s.latencyMs.p95} ms, p99 ${s.latencyMs.p99} ms, max ${num(s.latencyMs.max, 0)} ms.`,
        `- Command outcomes: ${JSON.stringify(s.commandOutcomes)}.`,
        `- Control events: ${JSON.stringify(s.controlEvents)}.`,
        `- Errors caught: ${JSON.stringify(s.errors.byCode)}; outside fault and deploy windows: ${s.errors.unexpected}.`,
        `- Log: ${s.log.warnings} warnings, ${s.log.errors} errors.`,
        ''
    ];
    if (s.violations.count) {
        lines.push('## Violations', '', ...s.violations.first.map((/** @type {any} */ v) => `- ${new Date(v.t).toISOString()} **${v.kind}** ${JSON.stringify({ ...v, t: undefined, kind: undefined })}`), '');
    }
    if (s.errors.unexpected) {
        lines.push('## Errors outside fault windows (first 20)', '', ...s.errors.unexpectedSamples.map((/** @type {any} */ e) => `- ${new Date(e.t).toISOString()} ${e.device} ${e.source} ${e.code}: ${e.message}`), '');
    }
    if (s.log.top.length) {
        lines.push('## Most frequent log lines', '', ...s.log.top.map((/** @type {any} */ w) => `- ${w.count}× ${w.sample}`), '');
    }
    const real = s.devices.filter((/** @type {any} */ d) => d.real);
    if (real.length) {
        lines.push('## Real devices', '', '| Device | Good reads | Stale | Offline | Longest gap |', '|---|---|---|---|---|',
            ...real.map((/** @type {any} */ d) => `| ${d.device} | ${d.good} | ${d.stale} | ${d.offline} | ${num(d.maxGapMs / 1000, 1)} s |`), '');
    }
    return lines.join('\n');
}

main().then((code) => { if (code !== undefined) process.exit(code); }, (err) => {
    console.error(`[soak] ${err.stack || err.message}`);
    process.exit(2);
});
