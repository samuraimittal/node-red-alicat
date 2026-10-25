'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const { ConnectionRegistry, getRegistry, REGISTRY_KEY } = require('../../lib/ConnectionRegistry');
const { AlicatSimulator } = require('../../tools/sim/AlicatSimulator');
const { REG } = require('../../lib/alicat/registers');
const { delay, until } = require('../helpers/wait');

const CLIENT = { requestTimeoutMs: 200, backoffInitialMs: 40, backoffMaxMs: 200, heartbeatMs: 0, interFrameDelayMs: 0 };

/** Mimics Node-RED's deploy sequence: stop everything, then start everything. */
function deploy(/** @type {EventEmitter} */ events, /** @type {() => void} */ stopNodes, /** @type {() => void} */ startNodes) {
    events.emit('flows:stopping', {});
    stopNodes();
    events.emit('runtime-event', { id: 'runtime-state', payload: { state: 'stop', deploy: true } });
    startNodes();
    events.emit('flows:started', {});
}

describe('ConnectionRegistry (simulator allows ONE connection)', () => {
    /** @type {InstanceType<typeof AlicatSimulator>} */
    let sim;
    /** @type {InstanceType<typeof ConnectionRegistry>} */
    let registry;
    /** @type {EventEmitter} */
    let events;
    /** @type {string[]} */
    let warnings;

    beforeEach(async () => {
        sim = await new AlicatSimulator({ maxConnections: 1 }).start();
        warnings = [];
        registry = new ConnectionRegistry({ lingerMs: 50, deployFallbackMs: 400, onWarning: (w) => warnings.push(w) });
        events = new EventEmitter();
        registry.attach(events);
        registry.attach(events); // idempotent
    });

    afterEach(async () => {
        await registry.closeAll();
        await sim.stop();
    });

    const params = (/** @type {Record<string, unknown>} */ extra = {}) =>
        ({ host: '127.0.0.1', port: sim.port, unitId: 1, clientOptions: { ...CLIENT }, ...extra });

    it('two configurations of one device share one client and one socket', async () => {
        const a = registry.acquire(params({ owner: 'cfg-a' }));
        const b = registry.acquire(params({ owner: 'cfg-b' }));
        assert.equal(a.client, b.client);
        assert.notEqual(a.token, b.token);
        await until(() => a.client.isOnline);
        await Promise.all([a.client.readInputRegisters(1, REG.OPT_GAS, 1), b.client.readInputRegisters(1, REG.OPT_GAS, 1)]);
        assert.equal(sim.stats.totalConnections, 1);
        assert.equal(sim.stats.rejectedConnections, 0);
        assert.equal(warnings.length, 0, 'same settings → no warning');
        a.release();
        assert.equal(registry.list()[0].state, 'ACTIVE', 'still leased by cfg-b');
        assert.equal(registry.list()[0].leases, 1);
    });

    it('moves an entry\'s address claim when DNS changes, and closeAll is idempotent', async () => {
        const lease = registry.acquire(params());
        const entry = /** @type {any} */ (registry)._entries.get(lease.key);
        assert.equal(/** @type {any} */ (registry)._claim(entry, '10.0.0.1', 502), true);
        assert.equal(/** @type {any} */ (registry)._claim(entry, '10.0.0.2', 502), true);
        assert.equal(/** @type {any} */ (registry)._claims.has('10.0.0.1|502'), false);
        const first = registry.closeAll();
        const second = registry.closeAll();
        await Promise.all([first, second]);
        assert.equal(registry.list().length, 0);
    });

    it('release is idempotent; the last release lingers, then closes the socket', async () => {
        const a = registry.acquire(params());
        await until(() => a.client.isOnline);
        a.release();
        a.release();
        assert.equal(registry.list()[0].state, 'PARKED');
        await until(() => registry.list().length === 0);
        await until(() => sim.server.connectionCount === 0);
        assert.equal(a.client.state, 'CLOSED');
    });

    it('an immediate release closes the socket now, but still parks it during a deploy', async () => {
        const lease = registry.acquire(params());
        await until(() => lease.client.isOnline);
        lease.release({ immediate: true });
        assert.equal(registry.list()[0] && registry.list()[0].state, 'CLOSING');
        await until(() => registry.list().length === 0, 500);
        const again = registry.acquire(params());
        await until(() => again.client.isOnline);
        events.emit('flows:stopping', {});
        again.release({ immediate: true });
        assert.equal(registry.list()[0].state, 'PARKED', 'a deploy may re-acquire it');
        events.emit('flows:started', {});
        await until(() => registry.list().length === 0);
    });

    it('re-acquiring within the linger reuses the live socket', async () => {
        const a = registry.acquire(params());
        await until(() => a.client.isOnline);
        a.release();
        const b = registry.acquire(params());
        assert.equal(b.client, a.client);
        assert.equal(registry.list()[0].state, 'ACTIVE');
        await delay(120);
        assert.equal(b.client.state, 'ONLINE');
        assert.equal(sim.stats.totalConnections, 1);
    });

    it('a deploy parks the socket even when other nodes take longer than the linger to close', async () => {
        registry.deployFallbackMs = 10000; // far beyond the wait below, however slow the machine
        let lease = registry.acquire(params({ owner: 'cfg' }));
        const client = lease.client;
        await until(() => client.isOnline);
        events.emit('flows:stopping', {});
        lease.release();
        await delay(250); // > lingerMs: a slow neighbour is still closing
        assert.equal(registry.list()[0].state, 'PARKED');
        assert.equal(client.state, 'ONLINE');
        lease = registry.acquire(params({ owner: 'cfg' }));
        events.emit('flows:started', {});
        assert.equal(lease.client, client);
        assert.equal(sim.stats.totalConnections, 1, 'zero reconnects across the deploy');
    });

    it('twenty redeploys in a row never open a second socket', async () => {
        let lease = registry.acquire(params());
        await until(() => lease.client.isOnline);
        for (let i = 0; i < 20; i++) {
            deploy(events, () => lease.release(), () => { lease = registry.acquire(params()); });
            await lease.client.readInputRegisters(1, REG.OPT_GAS, 1);
        }
        assert.equal(sim.stats.totalConnections, 1);
        assert.equal(sim.stats.rejectedConnections, 0);
    });

    it('flows:started tears down devices that no node re-acquired', async () => {
        const lease = registry.acquire(params());
        await until(() => lease.client.isOnline);
        events.emit('flows:stopping', {});
        lease.release();
        events.emit('flows:started', {});
        await until(() => registry.list().length === 0);
        await until(() => sim.server.connectionCount === 0);
    });

    it('shutdown / Stop flows frees the device immediately', async () => {
        const lease = registry.acquire(params());
        await until(() => lease.client.isOnline);
        events.emit('flows:stopping', {});
        lease.release();
        events.emit('runtime-event', { id: 'runtime-state', payload: { state: 'stop', deploy: false } });
        await until(() => sim.server.connectionCount === 0, 300);
        assert.equal(lease.client.state, 'CLOSED');
    });

    it('falls back to tearing down if flows:started never arrives', async () => {
        const lease = registry.acquire(params());
        await until(() => lease.client.isOnline);
        events.emit('flows:stopping', {});
        const releasedAt = Date.now();
        lease.release();
        assert.equal(registry.list()[0].state, 'PARKED');
        await until(() => registry.list().length === 0, 3000);
        // Timers never fire early, so this bound holds however loaded the machine is.
        assert.ok(Date.now() - releasedAt >= registry.deployFallbackMs - 5, 'kept for the deploy fallback, not torn down at the linger');
    });

    it('rejects a second unit ID on the same IP (one device per IP)', () => {
        registry.acquire(params({ unitId: 1 }));
        assert.throws(() => registry.acquire(params({ unitId: 2 })), (e) => /** @type {any} */ (e).code === 'EDUPLICATE');
    });

    it('a redeploy that changes the unit ID replaces the parked entry instead of refusing it', async () => {
        const old = registry.acquire(params({ unitId: 1 }));
        await until(() => old.client.isOnline);
        /** @type {any} */
        let replaced = null;
        deploy(events, () => old.release(), () => { replaced = registry.acquire(params({ unitId: 2 })); });
        assert.notEqual(replaced.client, old.client, 'a new client for the new unit ID');
        assert.equal(registry.list()[0].unitId, 2);
        await until(() => replaced.client.isOnline);
        assert.equal(old.client.state, 'CLOSED');
        assert.equal(sim.stats.rejectedConnections, 0, 'the old socket closed before the new one opened');
    });

    it('invalid settings on a takeover leave a parked entry parked, so it is still torn down', async () => {
        const lease = registry.acquire(params());
        await until(() => lease.client.isOnline);
        lease.release(); // lingers
        assert.throws(() => registry.acquire(params({ clientOptions: { ...CLIENT, backoffFactor: 0 } })),
            (e) => /** @type {any} */ (e).code === 'EINVALIDARG');
        assert.equal(registry.list()[0].state, 'PARKED');
        assert.equal(lease.client.options.backoffFactor, 2, 'nothing was half-applied');
        await until(() => registry.list().length === 0, 1000);
    });

    it("taking over an entry resets the previous holder's settings and trace", async () => {
        /** @type {string[]} */
        const traced = [];
        const probe = registry.acquire(params({ clientOptions: { ...CLIENT, backoffInitialMs: 60000, trace: () => traced.push('probe') } }));
        await until(() => probe.client.isOnline);
        await probe.client.readInputRegisters(1, REG.OPT_GAS, 1);
        assert.ok(traced.length > 0);
        probe.release();
        const node = registry.acquire(params({ clientOptions: { requestTimeoutMs: 200 } })); // within the linger
        assert.equal(node.client, probe.client, 'the same live socket');
        assert.equal(node.client.options.backoffInitialMs, 1000, 'back to the default');
        traced.length = 0;
        await node.client.readInputRegisters(1, REG.OPT_GAS, 1);
        assert.deepEqual(traced, [], 'the old trace is gone');
    });

    it('turns the frame trace on and off on a live connection', async () => {
        /** @type {string[]} */
        const traced = [];
        const a = registry.acquire(params());
        await until(() => a.client.isOnline);
        const b = registry.acquire(params({ clientOptions: { ...CLIENT, trace: (/** @type {string} */ dir) => traced.push(dir) } }));
        await a.client.readInputRegisters(1, REG.OPT_GAS, 1);
        assert.deepEqual(traced, ['tx', 'rx']);
        b.release();
        registry.acquire(params()); // trace off again
        await a.client.readInputRegisters(1, REG.OPT_GAS, 1);
        assert.deepEqual(traced, ['tx', 'rx']);
    });

    it('a host-name alias of a connected device gets EDUPLICATE and never opens a socket', async () => {
        const a = registry.acquire(params());
        await until(() => a.client.isOnline);
        const alias = registry.acquire(params({
            host: 'mfc-01.local',
            clientOptions: { ...CLIENT, lookup: async () => '127.0.0.1' }
        }));
        /** @type {any[]} */
        const changes = [];
        alias.client.on('state', (s) => changes.push(s));
        await until(() => changes.some((s) => s.error && s.error.code === 'EDUPLICATE'));
        assert.equal(sim.stats.totalConnections, 1);
        assert.equal(sim.stats.rejectedConnections, 0);
        assert.notEqual(alias.client.state, 'ONLINE');
    });

    it('a new client for a closing device waits until the old socket is gone', async () => {
        const a = registry.acquire(params());
        await until(() => a.client.isOnline);
        const closing = registry.closeAll(); // the entry turns CLOSING synchronously
        assert.equal(registry.list()[0].state, 'CLOSING');
        const b = registry.acquire(params());
        assert.notEqual(b.client, a.client);
        assert.equal(b.client.state, 'IDLE', 'the new client waits for the old socket');
        await closing;
        await until(() => b.client.isOnline);
        await b.client.readInputRegisters(1, REG.OPT_GAS, 1);
        assert.equal(sim.stats.peakConnections, 1);
        assert.equal(sim.stats.rejectedConnections, 0);
    });

    it('applies the most recent settings and warns once when they differ', async () => {
        const a = registry.acquire(params());
        registry.acquire(params({ clientOptions: { ...CLIENT, requestTimeoutMs: 900 } }));
        assert.equal(a.client.options.requestTimeoutMs, 900);
        assert.equal(warnings.length, 1);
        assert.match(warnings[0], /different settings/);
    });

    it("sends a warning about an acquire to that acquirer's handler when it has one", () => {
        registry.acquire(params());
        /** @type {string[]} */
        const mine = [];
        registry.acquire(params({ clientOptions: { ...CLIENT, requestTimeoutMs: 900 }, onWarning: (/** @type {string} */ w) => mine.push(w) }));
        assert.equal(mine.length, 1);
        assert.match(mine[0], /different settings/);
        assert.equal(warnings.length, 0, 'not the registry-wide handler');
    });

    it('validates the host and normalises keys', () => {
        assert.throws(() => registry.acquire(params({ host: ' ' })), (e) => /** @type {any} */ (e).code === 'EINVALIDARG');
        assert.equal(ConnectionRegistry.keyOf(' MFC-01.Local ', 502), ConnectionRegistry.keyOf('mfc-01.local', 502));
        assert.equal(ConnectionRegistry.keyOf('::1', 502), '["::1",502]');
    });
});

describe('getRegistry', () => {
    it('is a process-wide singleton stored on globalThis', () => {
        const a = getRegistry();
        assert.equal(getRegistry(), a);
        assert.equal(/** @type {any} */ (globalThis)[REGISTRY_KEY], a);
    });
});
