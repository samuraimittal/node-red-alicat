#!/usr/bin/env node
'use strict';

// Simulated Alicat instrument on Modbus TCP, for developing flows without hardware.
//   npm run sim -- --port 5020 --profile 10v20-mfc --max-connections 1

const { AlicatSimulator } = require('./sim/AlicatSimulator');
const { parseCli, numberOption, choiceOption } = require('./cli');

const OPTIONS = /** @type {const} */ ({
    port: { type: 'string' }, host: { type: 'string' }, profile: { type: 'string' },
    'max-connections': { type: 'string' }, 'idle-timeout': { type: 'string' }, help: { type: 'boolean' }, list: { type: 'boolean' }
});

async function main() {
    const { values: args } = parseCli(process.argv.slice(2), OPTIONS);
    if (args.help || args.list) {
        console.log('Usage: alicat-sim [--port 5020] [--host 127.0.0.1] [--profile NAME] [--max-connections 1] [--idle-timeout 20000]\n');
        console.log('Profiles:');
        for (const [name, description] of Object.entries(AlicatSimulator.profiles)) {
            console.log(`  ${name.padEnd(14)} ${description}`);
        }
        return;
    }
    const port = numberOption(args, 'port', { fallback: 5020, min: 0, max: 65535 });
    const host = typeof args.host === 'string' ? args.host : '127.0.0.1';
    const maxConnections = numberOption(args, 'max-connections', { fallback: 1, min: 1, max: 1000 });
    // Default matches real 10v20 hardware: idle connections are closed after ~20 s.
    const idleTimeoutMs = numberOption(args, 'idle-timeout', { fallback: 20000, min: 0, max: 86400000 });
    const profile = choiceOption(args, 'profile', '10v20-mfc', Object.keys(AlicatSimulator.profiles));
    const sim = new AlicatSimulator({ profile, maxConnections, idleTimeoutMs });

    sim.server.on('connection', (socket) => {
        console.log(`[sim] connection from ${socket.remoteAddress}:${socket.remotePort} (open: ${sim.server.connectionCount})`);
        socket.once('close', () => console.log(`[sim] connection closed (open: ${sim.server.connectionCount})`));
    });
    sim.server.on('rejected', (socket) => {
        console.log(`[sim] REJECTED connection from ${socket.remoteAddress}:${socket.remotePort} — limit is ${maxConnections}`);
    });

    await sim.start(port, host);
    console.log(`[sim] ${sim.profileName} listening on ${host}:${sim.port} (max connections ${maxConnections})`);

    const shutdown = () => {
        sim.stop().then(() => process.exit(0));
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}

main().catch((err) => {
    console.error(`[sim] ${err.message}`);
    process.exit(1);
});
