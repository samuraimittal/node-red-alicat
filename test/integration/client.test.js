'use strict';

const assert = require('node:assert/strict');
const { AlicatClient } = require('../../lib/AlicatClient');
const { AlicatSimulator } = require('../../tools/sim/AlicatSimulator');
const codec = require('../../lib/alicat/codec');
const { BLOCKS, REG } = require('../../lib/alicat/registers');
const { delay, until } = require('../helpers/wait');

// Real sockets against the simulator, with timings scaled down.
const FAST = {
    requestTimeoutMs: 150,
    connectTimeoutMs: 500,
    backoffInitialMs: 40,
    backoffMaxMs: 200,
    lateReplyGraceMs: 20,
    interFrameDelayMs: 0,
    heartbeatMs: 0
};

describe('AlicatClient ↔ simulator (real TCP)', () => {
    /** @type {InstanceType<typeof AlicatSimulator>} */
    let sim;
    /** @type {InstanceType<typeof AlicatClient>} */
    let client;

    /** @param {Record<string, unknown>} [simOptions] @param {Record<string, unknown>} [clientOptions] */
    async function setup(simOptions = {}, clientOptions = {}) {
        sim = await new AlicatSimulator(simOptions).start();
        client = new AlicatClient({ host: '127.0.0.1', port: sim.port, strict: true, ...FAST, ...clientOptions });
        client.start();
        await until(() => client.isOnline);
    }

    afterEach(async () => {
        if (client) await client.stop();
        if (sim) await sim.stop();
    });

    it('reads and writes through the queue', async () => {
        await setup();
        await client.writeRegisters(1, REG.SETPOINT, codec.encodeF32(12.5), { idempotent: true });
        const words = await client.readInputRegisters(1, BLOCKS.STD_FLOAT.start, BLOCKS.STD_FLOAT.quantity);
        assert.equal(codec.f32(words, 4), 12.5); // setpoint at 1350
        assert.equal(sim.stats.peakConnections, 1);
    });

    it('recovers after the device drops the connection', async () => {
        await setup();
        sim.server.dropConnections();
        await until(() => client.state === 'BACKOFF' || client.state === 'CONNECTING');
        await until(() => client.isOnline);
        assert.deepEqual(await client.readInputRegisters(1, REG.OPT_GAS, 1), [8]);
        assert.equal(sim.stats.totalConnections, 2);
        assert.equal(sim.stats.peakConnections, 1, 'the old socket is gone before the new one connects');
    });

    it('detects a silent (half-open) device and reconnects when it answers again', async () => {
        await setup();
        sim.faults.silent = true;
        const reads = [1, 2, 3].map(() => client.readInputRegisters(1, REG.OPT_GAS, 1, { retries: 0 }).catch((e) => e.code));
        assert.deepEqual(await Promise.all(reads), ['ETIMEDOUT', 'ETIMEDOUT', 'ETIMEDOUT']);
        await until(() => client.stats().linkSuspects === 1);
        sim.faults.silent = false;
        await until(() => client.isOnline);
        assert.deepEqual(await client.readInputRegisters(1, REG.OPT_GAS, 1), [8]);
    });

    it('keeps the link alive across the device idle timeout with the heartbeat', async () => {
        await setup({ idleTimeoutMs: 300 }, { heartbeatMs: 100 });
        await delay(1000);
        assert.equal(sim.stats.idleDisconnects, 0);
        assert.equal(sim.stats.totalConnections, 1);
        assert.ok(client.stats().ok >= 5, 'heartbeats were sent');
    });

    it('without a heartbeat the device drops the idle link and the client reconnects', async () => {
        await setup({ idleTimeoutMs: 200 });
        await until(() => sim.stats.idleDisconnects >= 1, 2000);
        await until(() => client.isOnline && sim.stats.totalConnections >= 2, 2000);
    });

    it('a reset in the middle of a reply fails that request and reconnects', async () => {
        await setup();
        sim.faults.rstMidFrame = true;
        await assert.rejects(client.readInputRegisters(1, BLOCKS.STD_FLOAT.start, 26), (e) => /** @type {any} */ (e).code === 'ELINKDOWN');
        await until(() => client.isOnline && sim.stats.totalConnections === 2);
    });

    it('an exception storm fails requests but keeps the link (no LINK_SUSPECT)', async () => {
        await setup();
        sim.faults.exceptionCode = 4;
        for (let i = 0; i < 5; i++) {
            await assert.rejects(client.readInputRegisters(1, REG.OPT_GAS, 1), (e) => /** @type {any} */ (e).exceptionCode === 4);
        }
        assert.equal(client.state, 'ONLINE');
        assert.equal(client.stats().linkSuspects, 0);
    });

    it('a refusing device keeps the client in backoff with ECONNECT', async () => {
        sim = await new AlicatSimulator().start();
        sim.faults.refuseConnections = true;
        client = new AlicatClient({ host: '127.0.0.1', port: sim.port, ...FAST });
        /** @type {any[]} */
        const changes = [];
        client.on('state', (s) => changes.push(s));
        client.start();
        await until(() => changes.filter((s) => s.state === 'BACKOFF').length >= 2);
        const err = changes.find((s) => s.state === 'BACKOFF').error;
        assert.ok(['ECONNECT', 'ELINKDOWN'].includes(err.code), err.code);
        sim.faults.refuseConnections = false;
        await until(() => client.isOnline);
    });

    it('stop() closes the socket and leaves no handles behind (200 cycles)', async function () {
        this.timeout(30000);
        sim = await new AlicatSimulator().start();
        // @ts-ignore — Node ≥17
        const resources = () => process.getActiveResourcesInfo().filter((r) => r !== 'TTYWrap' && r !== 'Timeout').length;
        const baseline = resources();
        for (let i = 0; i < 200; i++) {
            const c = new AlicatClient({ host: '127.0.0.1', port: sim.port, ...FAST });
            c.start();
            await until(() => c.isOnline);
            await c.readInputRegisters(1, REG.OPT_GAS, 1);
            await c.stop();
            assert.equal(c.listenerCount('state'), 0);
        }
        await until(() => sim.server.connectionCount === 0);
        await delay(50);
        assert.ok(resources() <= baseline + 1, `resources ${resources()} vs baseline ${baseline}`);
        assert.equal(sim.stats.peakConnections, 1);
        assert.equal(sim.stats.totalConnections, 200);
        client = /** @type {any} */ (null);
    });
});
