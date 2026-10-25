#!/usr/bin/env node
'use strict';

// Runtime compatibility smoke test with no dev dependencies: only Node-RED
// (whichever version is installed) and the bundled simulator. CI runs it on
// every supported Node / Node-RED pair, including Node 18 + Node-RED 4.1,
// where the dev toolchain (mocha, c8, eslint) no longer runs.
//
//   npm run test:compat
//   node test/compat/runtime-smoke.js --package <dir>   e.g. an unpacked `npm pack` tarball
//
// It deploys every node type against a Gen-2 and a Gen-1 simulator, checks
// readings, a setpoint, valve hold/resume, a PID read and a converged control
// node, then checks that a redeploy keeps the connections and Stop closes them.
// With --package, Node-RED loads the nodes from that directory, so the test
// covers exactly the files that get published.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { AlicatSimulator } = require('../../tools/sim/AlicatSimulator');

const ARG = process.argv.indexOf('--package');
const ROOT = ARG > 0 && process.argv[ARG + 1] ? path.resolve(/** @type {string} */ (process.argv[ARG + 1])) : path.join(__dirname, '..', '..');
const PACKAGE_NAME = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).name;
const TIMEOUT_MS = 30000;

const delay = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));

/** @param {() => boolean} predicate @param {string} what */
async function until(predicate, what) {
    const start = Date.now();
    while (!predicate()) {
        if (Date.now() - start > TIMEOUT_MS) throw new Error(`timed out waiting for ${what}`);
        await delay(50);
    }
}

/**
 * @param {number} portA @param {number} portB
 * @returns {{id: string, type: string, z?: string, [key: string]: unknown}[]}
 */
function flows(portA, portB) {
    // The name must not equal a config node id: the runtime would read it as a dependency.
    const device = (/** @type {string} */ id, /** @type {number} */ port, /** @type {Record<string, string>} */ extra) => ({
        id, type: 'alicat-device', name: `compat ${id}`, host: '127.0.0.1', port: String(port), unitId: '1', mapMode: 'auto', deviceType: 'auto',
        layout: 'auto', customLayout: '', controlVariable: 'unknown', unitLabels: '', requestTimeout: '1000', connectTimeout: '5000',
        interFrameDelay: '20', heartbeat: '5000', backoffMax: '30000', maxQueue: '200', trace: false, ...extra
    });
    const once = (/** @type {string} */ id, /** @type {number} */ afterS, /** @type {string} */ payload, /** @type {string} */ payloadType, /** @type {string} */ target) => ({
        id, type: 'inject', z: 'tab', props: [{ p: 'payload' }], repeat: '', crontab: '', once: true, onceDelay: afterS,
        topic: '', payload, payloadType, wires: [[target]]
    });
    const sink = (/** @type {string} */ id) => ({ id, type: 'debug', z: 'tab', active: false, tosidebar: false, console: false, tostatus: false, complete: 'false', wires: [] });
    /** @type {{id: string, type: string, z?: string, [key: string]: unknown}[]} */
    const nodes = [
        { id: 'tab', type: 'tab', label: 'compat' },
        device('devA', portA, {}),
        device('devB', portB, { layout: 'extended-7', controlVariable: 'massFlow' }),
        { id: 'readA', type: 'alicat-read', z: 'tab', device: 'devA', trigger: 'interval', interval: '200', dataset: 'live', output: 'object', emit: 'always', wires: [['sinkA']] },
        { id: 'readB', type: 'alicat-read', z: 'tab', device: 'devB', trigger: 'interval', interval: '200', dataset: 'live', output: 'object', emit: 'always', wires: [['sinkB']] },
        { id: 'sp', type: 'alicat-setpoint', z: 'tab', device: 'devA', value: 'payload', valueType: 'msg', variable: 'current', switchMode: 'bumpless', outOfRange: 'reject', verify: true, wires: [['sinkSp']] },
        { id: 'hold', type: 'alicat-command', z: 'tab', device: 'devA', command: 'holdClosed', wires: [['sinkHold']] },
        { id: 'resume', type: 'alicat-command', z: 'tab', device: 'devA', command: 'resume', wires: [['sinkResume']] },
        { id: 'pid', type: 'alicat-pid', z: 'tab', device: 'devA', action: 'read', wires: [['sinkPid']] },
        { id: 'ctl', type: 'alicat-control', z: 'tab', device: 'devB', interval: '200', correctionMs: '200', wires: [['sinkCtl']] },
        { id: 'status', type: 'alicat-status', z: 'tab', device: 'devA', wires: [['sinkStatus']] },
        { id: 'catch', type: 'catch', z: 'tab', scope: null, wires: [['sinkErr']] },
        once('i-sp', 1, '5', 'num', 'sp'),
        once('i-hold', 2, '', 'date', 'hold'),
        once('i-resume', 4, '', 'date', 'resume'),
        once('i-pid', 6, '', 'date', 'pid'), // after resume: an urgent valve command would pre-empt it
        once('i-ctl', 1, '{"setpoint": 100, "valve": "auto"}', 'json', 'ctl'),
        ...['sinkA', 'sinkB', 'sinkSp', 'sinkHold', 'sinkResume', 'sinkPid', 'sinkCtl', 'sinkStatus', 'sinkErr'].map(sink)
    ];
    return nodes.map((n, i) => (n.z ? { x: 200, y: 40 + i * 40, ...n } : n)); // the runtime treats a node without x/y as a config node
}

async function main() {
    const simA = await new AlicatSimulator({ profile: '10v20-mfc', maxConnections: 2 }).start();
    const simB = await new AlicatSimulator({ profile: '9v07-bench', maxConnections: 2 }).start();
    const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alicat-compat-'));
    const link = path.join(userDir, 'node_modules', PACKAGE_NAME);
    fs.mkdirSync(path.dirname(link), { recursive: true }); // a scoped name needs its @scope folder
    fs.symlinkSync(ROOT, link, 'junction');

    /** @type {Record<string, any[]>} */
    const seen = {};
    /** @type {string[]} */
    const problems = [];
    const RED = require('node-red');
    RED.init({
        userDir, flowFile: 'flows.json', credentialSecret: false, httpAdminRoot: false, httpNodeRoot: false,
        editorTheme: { projects: { enabled: false } },
        logging: {
            check: {
                level: 'warn', metrics: false, audit: false,
                handler: () => (/** @type {any} */ m) => {
                    if (m.level <= 20 || /alicat/.test(String(m.type))) problems.push(`[log ${m.level}] ${m.type || ''} ${m.msg}`);
                }
            }
        }
    });
    RED.hooks.add('onReceive.compat', (/** @type {any} */ evt) => {
        const id = evt.destination && evt.destination.id;
        if (id && id.startsWith('sink')) (seen[id] ||= []).push(evt.msg);
    });
    const step = (/** @type {string} */ name) => console.log(`[compat] ok: ${name}`);
    try {
        await RED.start();
        const version = typeof RED.version === 'function' ? RED.version() : RED.version;
        console.log(`[compat] Node ${process.version}, Node-RED ${version}`);
        await RED.runtime.flows.setFlows({ flows: { flows: flows(simA.port, simB.port) }, deploymentType: 'full' });

        const good = (/** @type {string} */ id) => (seen[id] || []).filter((m) => m.alicat && m.alicat.quality === 'good');
        await until(() => good('sinkA').length >= 3 && good('sinkB').length >= 3, 'good readings from both devices');
        if (typeof good('sinkA')[0].payload.massFlow !== 'number') throw new Error('Gen-2 reading has no massFlow');
        if (typeof good('sinkB')[0].payload.absolutePressure !== 'number') throw new Error('Gen-1 reading has no absolutePressure');
        step('readings (Gen-2 and Gen-1)');
        await until(() => Boolean(seen.sinkSp), 'the setpoint');
        if (seen.sinkSp[0].payload !== 5 || simA.model.state.setpoint !== 5) throw new Error(`setpoint: ${JSON.stringify(seen.sinkSp[0].payload)}`);
        step('setpoint');
        await until(() => Boolean(seen.sinkHold && seen.sinkResume), 'hold and resume');
        for (const id of ['sinkHold', 'sinkResume']) {
            if (seen[id][0].payload.outcome !== 'executed') throw new Error(`${id}: ${JSON.stringify(seen[id][0].payload)}`);
        }
        step('valve hold and resume');
        await until(() => Boolean(seen.sinkPid), 'the PID read');
        if (typeof seen.sinkPid[0].payload.p !== 'number') throw new Error(`pid: ${JSON.stringify(seen.sinkPid[0].payload)}`);
        step('PID read');
        await until(() => (seen.sinkCtl || []).some((m) => m.topic === 'converged'), 'the control node to converge');
        step('control converged');
        await until(() => (seen.sinkStatus || []).some((m) => m.payload && m.payload.online), 'status online');
        step('status');
        if (seen.sinkErr) throw new Error(`unexpected errors: ${seen.sinkErr.map((m) => m.error && m.error.message).join('; ')}`);

        const connections = [simA.stats.totalConnections, simB.stats.totalConnections];
        await RED.runtime.flows.setFlows({ flows: { flows: flows(simA.port, simB.port) }, deploymentType: 'full' });
        const before = good('sinkA').length;
        await until(() => good('sinkA').length > before + 2, 'readings after the redeploy');
        if (simA.stats.totalConnections !== connections[0] || simB.stats.totalConnections !== connections[1]) {
            throw new Error(`redeploy reconnected: ${connections} -> ${[simA.stats.totalConnections, simB.stats.totalConnections]}`);
        }
        step('redeploy kept both connections');

        await RED.stop();
        await until(() => simA.server.connectionCount === 0 && simB.server.connectionCount === 0, 'connections to close on stop');
        step('stop closed every connection');
        if (problems.length) throw new Error(`unexpected log lines:\n${problems.join('\n')}`);
        console.log('[compat] PASS');
        return 0;
    } catch (err) {
        console.error(`[compat] FAIL: ${/** @type {Error} */ (err).message}`);
        for (const p of problems) console.error(p);
        for (const m of seen.sinkErr || []) console.error(`[caught] ${m.error && m.error.source && m.error.source.id}: ${m.error && m.error.message}`);
        return 1;
    } finally {
        await simA.stop();
        await simB.stop();
        try {
            fs.unlinkSync(link); // the link only, never the repo behind it
            fs.rmSync(userDir, { recursive: true, force: true });
        } catch {
            // best effort
        }
    }
}

main().then((code) => process.exit(code), (err) => {
    console.error(err);
    process.exit(2);
});
