#!/usr/bin/env node
'use strict';

// Local development environment: simulated instruments plus a Node-RED with
// this package linked in, for trying the examples and checking the editor.
//   npm run dev                   editor on http://127.0.0.1:1880
//   npm run dev -- --port 1881
// Simulators: 5020 and 5021 (10v20 bench replica, the ports the examples use)
// and 5022 (9v07 Gen-1 replica). Each accepts one connection, so a socket
// collision shows up as a REJECTED line.
// The Node-RED user directory is .dev/node-red (git-ignored); delete it to start fresh.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { AlicatSimulator } = require('./sim/AlicatSimulator');
const { parseCli, numberOption } = require('./cli');

const ROOT = path.join(__dirname, '..');
const USER_DIR = path.join(ROOT, '.dev', 'node-red');
const PACKAGE_NAME = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).name;
const SIMULATORS = [
    { port: 5020, profile: '10v20-bench' },
    { port: 5021, profile: '10v20-bench' },
    { port: 5022, profile: '9v07-bench' }
];

const SETTINGS = `'use strict';
// Written by tools/dev.js on every start (edits are overwritten). Local development
// only: the editor has no login, so it listens on 127.0.0.1.
module.exports = {
    uiHost: '127.0.0.1',
    flowFile: 'flows.json',
    editorTheme: { projects: { enabled: false } },
    // Let the editor's Test connection reach the simulators.
    alicatModbus: { probePorts: [${SIMULATORS.map((s) => s.port).join(', ')}] }
};
`;

/** Create the user directory and link this package into its node_modules. */
function prepareUserDir() {
    fs.mkdirSync(path.join(USER_DIR, 'node_modules', path.dirname(PACKAGE_NAME)), { recursive: true }); // with the @scope folder
    fs.writeFileSync(path.join(USER_DIR, 'settings.js'), SETTINGS);
    const link = path.join(USER_DIR, 'node_modules', PACKAGE_NAME);
    let current = null;
    try {
        current = fs.realpathSync(link);
    } catch {
        // missing or dangling link
    }
    if (current === fs.realpathSync(ROOT)) return;
    try {
        fs.unlinkSync(link);
    } catch {
        // nothing to remove
    }
    fs.symlinkSync(ROOT, link, 'junction'); // 'junction' needs no admin rights on Windows; ignored elsewhere
}

/** @param {{port: number, profile: string}} spec */
async function startSimulator({ port, profile }) {
    const sim = new AlicatSimulator({ profile, maxConnections: 1, idleTimeoutMs: 20000 });
    const tag = `[sim:${port}]`;
    sim.server.on('connection', (socket) => {
        console.log(`${tag} connection from ${socket.remoteAddress}:${socket.remotePort} (open: ${sim.server.connectionCount})`);
        socket.once('close', () => console.log(`${tag} connection closed (open: ${sim.server.connectionCount})`));
    });
    sim.server.on('rejected', (socket) => {
        console.log(`${tag} REJECTED connection from ${socket.remoteAddress}:${socket.remotePort}: another socket is already open`);
    });
    await sim.start(port, '127.0.0.1');
    console.log(`${tag} ${sim.profileName} listening on 127.0.0.1:${sim.port}`);
    return sim;
}

async function main() {
    const { values } = parseCli(process.argv.slice(2), { port: { type: 'string' } });
    const uiPort = numberOption(values, 'port', { fallback: 1880, min: 1, max: 65535 });

    prepareUserDir();
    /** @type {InstanceType<typeof AlicatSimulator>[]} */
    const sims = [];
    for (const spec of SIMULATORS) sims.push(await startSimulator(spec));

    const red = spawn(process.execPath, [require.resolve('node-red/red.js'), '--userDir', USER_DIR, '--port', String(uiPort)], { stdio: 'inherit' });
    console.log(`[dev] Node-RED starting: open http://127.0.0.1:${uiPort}/ and import the examples from Menu → Import → Examples → ${PACKAGE_NAME}`);

    let stopping = false;
    const stop = async (/** @type {number} */ code) => {
        if (stopping) return;
        stopping = true;
        if (red.exitCode === null) {
            red.kill();
            await new Promise((resolve) => {
                red.once('exit', resolve);
                setTimeout(resolve, 5000).unref();
            });
        }
        await Promise.all(sims.map((s) => s.stop()));
        process.exit(code);
    };
    red.once('exit', (code) => { stop(code ?? 0); });
    process.on('SIGINT', () => { stop(0); });
    process.on('SIGTERM', () => { stop(0); });
}

main().catch((err) => {
    console.error(`[dev] ${err.message}`);
    process.exit(1);
});
