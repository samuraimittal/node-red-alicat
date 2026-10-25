'use strict';

const assert = require('node:assert/strict');
const sinon = require('sinon');
const { AlicatClient, TRANSITIONS, Priority } = require('../../lib/AlicatClient');
const { AlicatError } = require('../../lib/errors');
const { FakeDevice } = require('../helpers/fake-transport');
const { rejectsCode } = require('../helpers/assert');

const EVENTS = ['START', 'CONNECTED', 'CONNECT_FAILED', 'DOWN', 'LINK_SUSPECT', 'RECONNECT', 'RETRY', 'STOP', 'CLOSED'];

describe('AlicatClient (fake transport, fake timers)', () => {
    /** @type {sinon.SinonFakeTimers} */
    let clock;
    /** @type {InstanceType<typeof FakeDevice>} */
    let device;
    /** @type {InstanceType<typeof AlicatClient> | null} */
    let client;
    /** @type {any[]} */
    let changes;

    beforeEach(() => {
        clock = sinon.useFakeTimers({
            now: 1_000_000,
            toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'clearImmediate', 'Date']
        });
        device = new FakeDevice();
        client = null;
        changes = [];
    });

    afterEach(async () => {
        if (client) {
            const stopped = client.stop();
            await clock.tickAsync(500);
            await stopped;
        }
        clock.restore();
    });

    /** @param {Record<string, unknown>} [options] */
    function make(options = {}) {
        client = new AlicatClient({ host: '10.0.0.5', strict: true, createTransport: device.factory, random: () => 0, ...options });
        client.on('state', (s) => changes.push(s));
        return client;
    }

    async function online(/** @type {Record<string, unknown>} */ options = {}) {
        const c = make(options);
        c.start();
        await clock.tickAsync(5);
        assert.equal(c.state, 'ONLINE');
        return c;
    }

    describe('state machine', () => {
        it('allows exactly the transitions in the table (strict mode throws on the rest)', () => {
            for (const [from, allowed] of Object.entries(TRANSITIONS)) {
                for (const event of EVENTS) {
                    const c = new AlicatClient({ host: '10.0.0.5', strict: true, createTransport: device.factory });
                    /** @type {any} */ (c)._state = from;
                    const expected = /** @type {any} */ (allowed)[event];
                    if (expected) {
                        /** @type {any} */ (c)._transition(event);
                        assert.equal(c.state, expected, `${from} + ${event}`);
                    } else {
                        assert.throws(() => /** @type {any} */ (c)._transition(event), /Illegal transition/, `${from} + ${event}`);
                    }
                }
            }
        });

        it('in production mode an illegal transition is a warning, not a crash', () => {
            const c = new AlicatClient({ host: '10.0.0.5', createTransport: device.factory });
            /** @type {string[]} */
            const warnings = [];
            c.on('warning', (w) => warnings.push(w));
            assert.equal(/** @type {any} */ (c)._transition('DOWN'), false);
            assert.equal(c.state, 'IDLE');
            assert.match(warnings[0], /Illegal transition DOWN in state IDLE/);
        });

        it('goes IDLE → CONNECTING → ONLINE and serves a read', async () => {
            const c = await online();
            assert.deepEqual(changes.map((s) => s.state), ['CONNECTING', 'ONLINE']);
            const p = c.readInputRegisters(1, 1200, 2);
            await clock.tickAsync(10);
            assert.deepEqual(await p, [0, 0]);
            assert.equal(device.log[0].request.address, 1199, 'register 1200 → PDU address 1199');
        });

        it('requests made while CONNECTING wait for the connection', async () => {
            device.connectDelayMs = 100;
            const c = make();
            c.start();
            const p = c.readInputRegisters(1, 1200, 1);
            await clock.tickAsync(50);
            assert.equal(device.log.length, 0);
            await clock.tickAsync(100);
            assert.deepEqual(await p, [0]);
        });
    });

    describe('reconnect backoff', () => {
        it('backs off exponentially with equal jitter, capped at 30 s', async () => {
            device.connectBehaviour = 'refuse';
            const c = make();
            c.start();
            await clock.tickAsync(70000);
            const delays = changes.filter((s) => s.state === 'BACKOFF').map((s) => s.nextRetryInMs);
            assert.deepEqual(delays.slice(0, 7), [500, 1000, 2000, 4000, 8000, 15000, 15000]); // random() = 0 → d/2
            assert.ok(c.stats().attempt >= 7);
        });

        it('resets the attempt counter only after a stable link (≥10 s, success, no timeouts)', async () => {
            device.connectBehaviour = 'refuse';
            const c = make({ heartbeatMs: 2000 });
            let stable = 0;
            c.on('stable', () => stable++);
            c.start();
            await clock.tickAsync(1600); // three failures (t+1, t+502, t+1503); next retry at t+3503
            device.connectBehaviour = 'ok';
            await clock.tickAsync(2000);
            assert.equal(c.state, 'ONLINE');
            assert.ok(c.stats().attempt >= 2);
            await clock.tickAsync(5000);
            assert.ok(c.stats().attempt >= 2, 'not stable yet');
            await clock.tickAsync(6000);
            assert.equal(c.stats().attempt, 0);
            assert.equal(stable, 1);
        });

        it('reconnect() from ONLINE reconnects immediately without counting a failure', async () => {
            const c = await online();
            c.reconnect();
            await clock.tickAsync(5);
            assert.equal(c.state, 'ONLINE');
            assert.equal(device.transports.length, 2);
            assert.equal(c.stats().attempt, 0);
            assert.deepEqual(changes.map((s) => s.event), ['START', 'CONNECTED', 'RECONNECT', 'RETRY', 'CONNECTED']);
        });

        it('reconnect() from BACKOFF retries now', async () => {
            device.connectBehaviour = 'refuse';
            const c = make({ backoffInitialMs: 60000 });
            c.start();
            await clock.tickAsync(5);
            assert.equal(c.state, 'BACKOFF');
            device.connectBehaviour = 'ok';
            c.reconnect();
            await clock.tickAsync(5);
            assert.equal(c.state, 'ONLINE');
        });
    });

    describe('offline semantics', () => {
        it('fails queued CONTROL fast when the connection attempt fails', async () => {
            device.connectBehaviour = 'refuse';
            const c = make();
            c.start();
            const check = assert.rejects(c.writeRegisters(1, 1010, [0, 0]), (err) => {
                const e = /** @type {any} */ (err);
                return e.code === 'ENOTCONNECTED' && e.cause.code === 'ECONNECT';
            });
            await clock.tickAsync(5);
            await check;
        });

        it('in BACKOFF rejects new CONTROL immediately with the time to the next retry', async () => {
            device.connectBehaviour = 'refuse';
            const c = make();
            c.start();
            await clock.tickAsync(5);
            await assert.rejects(c.writeRegisters(1, 1010, [0, 0]), (err) => {
                const e = /** @type {any} */ (err);
                return e.code === 'ENOTCONNECTED' && e.nextRetryInMs > 0;
            });
        });

        it('with failFastWhenOffline=false, CONTROL waits through BACKOFF but polls do not', async () => {
            device.connectBehaviour = 'refuse';
            const c = make({ failFastWhenOffline: false });
            c.start();
            await clock.tickAsync(5);
            const write = c.writeRegisters(1, 1010, [0, 0]);
            await rejectsCode(c.readInputRegisters(1, 1200, 1), 'ENOTCONNECTED');
            device.connectBehaviour = 'ok';
            await clock.tickAsync(600);
            assert.equal(c.state, 'ONLINE');
            await clock.tickAsync(20);
            assert.deepEqual(await write, { fc: 16, address: 1009, quantity: 2, rttMs: 5 });
        });

        it('a dropped link rejects the in-flight request with ELINKDOWN and reconnects', async () => {
            device.latencyMs = 100;
            const c = await online();
            const p = c.readInputRegisters(1, 1200, 1);
            const check = rejectsCode(p, 'ELINKDOWN');
            await clock.tickAsync(10);
            device.current.drop();
            await check;
            assert.equal(c.state, 'BACKOFF');
            await clock.tickAsync(600);
            assert.equal(c.state, 'ONLINE');
            assert.equal(device.transports.length, 2);
        });

        it('ignores a late down event from a retired transport', async () => {
            const c = await online();
            c.reconnect();
            await clock.tickAsync(5);
            device.transports[0].emit('down', new Error('late'));
            assert.equal(c.state, 'ONLINE');
        });
    });

    describe('queue behaviour on the wire', () => {
        it('sends URGENT, then CONTROL, then POLL when issued together', async () => {
            const c = await online();
            const all = [
                c.readInputRegisters(1, 1200, 1),
                c.writeRegisters(1, 1010, [0, 0], { priority: Priority.CONTROL }),
                c.writeRegisters(1, 1000, [6, 1], { priority: Priority.URGENT })
            ];
            await clock.tickAsync(200);
            await Promise.all(all);
            assert.deepEqual(device.log.map((l) => l.request.address), [999, 1009, 1199]);
        });

        it('keeps at least interFrameDelayMs between requests', async () => {
            const c = await online({ interFrameDelayMs: 20 });
            const all = [c.readInputRegisters(1, 1200, 1), c.readInputRegisters(1, 1201, 1)];
            await clock.tickAsync(100);
            await Promise.all(all);
            assert.ok(device.log[1].at - device.log[0].at >= 25, `gap ${device.log[1].at - device.log[0].at}`);
        });

        it('coalesces identical reads into one wire request', async () => {
            const c = await online();
            const a = c.readInputRegisters(1, 1346, 26, { coalesceKey: 'live' });
            const b = c.readInputRegisters(1, 1346, 26, { coalesceKey: 'live' });
            await clock.tickAsync(20);
            assert.deepEqual(await a, await b);
            assert.equal(device.log.length, 1);
        });

        it('latest-wins: a newer queued setpoint supersedes the older one', async () => {
            device.latencyMs = 50;
            const c = await online();
            const blocker = c.readInputRegisters(1, 1200, 1);
            await clock.tickAsync(1);
            const first = c.writeRegisters(1, 1010, [0x4120, 0], { replaceKey: 'sp' });
            const second = c.writeRegisters(1, 1010, [0x4148, 0], { replaceKey: 'sp' });
            assert.deepEqual(await first, { superseded: true });
            await clock.tickAsync(200);
            await blocker;
            await second;
            const writes = device.log.filter((l) => l.request.fc === 16);
            assert.deepEqual(writes.map((l) => l.request.values), [[0x4148, 0]]);
            assert.equal(c.stats().queue.superseded, 1);
        });

        it('never sends a request after its deadline', async () => {
            device.latencyMs = 1000;
            const c = await online({ requestTimeoutMs: 2000 });
            const slow = c.readInputRegisters(1, 1200, 1);
            const late = c.readInputRegisters(1, 1201, 1, { deadlineMs: 100 });
            const check = rejectsCode(late, 'EQUEUETIMEOUT');
            await clock.tickAsync(1500);
            await slow;
            await check;
            assert.equal(device.log.length, 1);
        });

        it('rejects with EQUEUEFULL when the queue is full', async () => {
            device.latencyMs = 1000;
            const c = await online({ maxQueueDepth: 1, requestTimeoutMs: 2000 });
            const inflight = c.writeRegisters(1, 1010, [0, 0]);
            await clock.tickAsync(1);
            const queued = c.writeRegisters(1, 1010, [0, 1]);
            await rejectsCode(c.writeRegisters(1, 1010, [0, 2]), 'EQUEUEFULL');
            await clock.tickAsync(2100);
            await inflight;
            await queued;
        });

        it('cancelByOwner rejects queued and in-flight requests of that owner only', async () => {
            device.latencyMs = 100;
            const c = await online();
            const owner = Symbol('node-1');
            const inflight = c.readInputRegisters(1, 1200, 1, { owner });
            await clock.tickAsync(1);
            const queued = c.readInputRegisters(1, 1201, 1, { owner });
            const other = c.readInputRegisters(1, 1202, 1, { owner: 'someone-else' });
            const checks = [rejectsCode(inflight, 'ECANCELED'), rejectsCode(queued, 'ECANCELED')];
            assert.equal(c.cancelByOwner(owner), 2);
            await Promise.all(checks);
            await clock.tickAsync(300);
            assert.deepEqual(await other, [0]);
        });

        it('an AbortSignal cancels a queued request', async () => {
            device.latencyMs = 100;
            const c = await online();
            const blocker = c.readInputRegisters(1, 1200, 1);
            await clock.tickAsync(1);
            const controller = new AbortController();
            const p = c.readInputRegisters(1, 1201, 1, { signal: controller.signal });
            const check = rejectsCode(p, 'ECANCELED');
            controller.abort();
            await check;
            await rejectsCode(c.readInputRegisters(1, 1201, 1, { signal: controller.signal }), 'ECANCELED');
            await clock.tickAsync(200);
            await blocker;
            assert.equal(device.log.length, 1);
        });

        it('an AbortSignal rejects an in-flight request at once; the late reply is ignored', async () => {
            device.latencyMs = 100;
            const c = await online();
            const controller = new AbortController();
            const p = c.readInputRegisters(1, 1200, 1, { signal: controller.signal });
            const check = rejectsCode(p, 'ECANCELED');
            await clock.tickAsync(10);
            controller.abort();
            await check;
            await clock.tickAsync(200);
            assert.equal(c.state, 'ONLINE');
            assert.equal(c.stats().ok, 1, 'the wire request still completed');
        });

        it('retries an idempotent read in place after a timeout', async () => {
            let calls = 0;
            device.handler = (_u, req) => (++calls === 1 ? 'silent' : { fc: 4, registers: new Array(req.quantity).fill(7) });
            const c = await online({ requestTimeoutMs: 100 });
            const p = c.readInputRegisters(1, 1200, 1);
            await clock.tickAsync(200);
            assert.deepEqual(await p, [7]);
            assert.equal(calls, 2);
            assert.equal(c.stats().retries, 1);
        });

        it('never retries a non-idempotent write', async () => {
            device.handler = () => 'silent';
            const c = await online({ requestTimeoutMs: 100 });
            const check = rejectsCode(c.writeRegisters(1, 1000, [6, 1]), 'ETIMEDOUT');
            await clock.tickAsync(200);
            await check;
            assert.equal(device.log.length, 1);
        });

        it('retries a read on SERVER DEVICE BUSY', async () => {
            let calls = 0;
            device.handler = (_u, req) => (++calls === 1
                ? { error: new AlicatError('EMODBUS', 'busy', { exceptionCode: 6 }) }
                : { fc: 4, registers: new Array(req.quantity).fill(1) });
            const c = await online();
            const p = c.readInputRegisters(1, 1200, 1);
            await clock.tickAsync(50);
            assert.deepEqual(await p, [1]);
        });
    });

    describe('link supervision', () => {
        it('declares LINK_SUSPECT after 3 timeouts with no data, then reconnects', async () => {
            device.handler = () => 'silent';
            const c = await online({ requestTimeoutMs: 100, heartbeatMs: 0 });
            const reads = [1, 2, 3].map((n) => c.readInputRegisters(1, 1200 + n, 1, { retries: 0 }).catch((e) => e));
            await clock.tickAsync(400);
            const errors = await Promise.all(reads);
            assert.deepEqual(errors.map((e) => e.code), ['ETIMEDOUT', 'ETIMEDOUT', 'ETIMEDOUT']);
            const suspect = changes.find((s) => s.event === 'LINK_SUSPECT');
            assert.ok(suspect, 'LINK_SUSPECT transition');
            assert.equal(suspect.error.code, 'ELINKDOWN');
            assert.equal(c.stats().linkSuspects, 1);
        });

        it('exception replies prove the link is alive (no LINK_SUSPECT)', async () => {
            device.handler = () => ({ error: new AlicatError('EMODBUS', 'failure', { exceptionCode: 4 }) });
            const c = await online({ requestTimeoutMs: 100 });
            for (let i = 0; i < 5; i++) {
                const check = rejectsCode(c.readInputRegisters(1, 1200, 1), 'EMODBUS');
                await clock.tickAsync(50);
                await check;
            }
            assert.equal(c.state, 'ONLINE');
            assert.equal(c.stats().exceptions, 5);
        });

        it('sends a heartbeat read of register 1200 after 5 s idle', async () => {
            await online();
            await clock.tickAsync(4900);
            assert.equal(device.log.length, 0);
            await clock.tickAsync(200);
            assert.equal(device.log.length, 1);
            assert.equal(device.log[0].request.address, 1199);
            await clock.tickAsync(5100);
            assert.equal(device.log.length, 2);
        });

        it('after a silent heartbeat, probes every request timeout instead of every 5 s', async () => {
            device.handler = () => 'silent';
            await online({ requestTimeoutMs: 1000, linkSuspectTimeouts: 99 });
            await clock.tickAsync(5000 + 1000 + 1000 + 50);
            assert.equal(device.log.length, 2);
            assert.ok(Math.abs(device.log[1].at - device.log[0].at - 2000) <= 30, String(device.log[1].at - device.log[0].at));
        });

        it('clamps the heartbeat to 15 s (the device drops idle links after ~20 s)', () => {
            const c = make({ heartbeatMs: 60000 });
            assert.equal(c.options.heartbeatMs, 15000);
        });
    });

    describe('lifecycle', () => {
        it('stop() from ONLINE rejects queued work, then ECLOSED for new requests', async () => {
            device.latencyMs = 100;
            const c = await online();
            const inflight = c.readInputRegisters(1, 1200, 1).catch((e) => e);
            await clock.tickAsync(1);
            const queued = c.readInputRegisters(1, 1201, 1).catch((e) => e);
            const stopped = c.stop();
            assert.equal(c.state, 'CLOSING');
            await clock.tickAsync(10);
            await stopped;
            assert.equal(c.state, 'CLOSED');
            assert.equal((await inflight).code, 'ECANCELED');
            assert.equal((await queued).code, 'ECANCELED');
            await rejectsCode(c.readInputRegisters(1, 1200, 1), 'ECLOSED');
            assert.equal(c.stop(), c.closed, 'idempotent');
        });

        it('stop() from IDLE, CONNECTING and BACKOFF', async () => {
            const idle = make();
            await idle.stop();
            assert.equal(idle.state, 'CLOSED');

            device.connectBehaviour = 'hang';
            const connecting = make();
            connecting.start();
            await clock.tickAsync(5);
            await connecting.stop();
            assert.equal(connecting.state, 'CLOSED');

            device.connectBehaviour = 'refuse';
            const backoff = make();
            backoff.start();
            await clock.tickAsync(5);
            assert.equal(backoff.state, 'BACKOFF');
            const before = device.transports.length;
            await backoff.stop();
            await clock.tickAsync(60000);
            assert.equal(device.transports.length, before, 'no retry after stop');
            assert.equal(backoff.state, 'CLOSED');
        });

        it('claims the resolved address before connecting; a refused claim is EDUPLICATE and opens nothing', async () => {
            const c = make({ claimAddress: () => false });
            c.start();
            await clock.tickAsync(5);
            assert.equal(c.state, 'BACKOFF');
            assert.equal(changes[1].error.code, 'EDUPLICATE');
            assert.equal(device.transports.length, 0);
        });

        it('resolves host names before connecting, and wraps failures as ECONNECT', async () => {
            const c = make({ host: 'mfc-01.local', lookup: async () => '10.0.0.9' });
            c.start();
            await clock.tickAsync(5);
            assert.equal(device.current.options.host, '10.0.0.9');
            await c.stop();
            client = null;

            const bad = make({
                host: 'nowhere.local',
                lookup: async () => { throw Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }); }
            });
            bad.start();
            await clock.tickAsync(5);
            const failed = changes.find((s) => s.state === 'BACKOFF' && s.error && s.error.cause && s.error.cause.code === 'ENOTFOUND');
            assert.ok(failed, 'ECONNECT with ENOTFOUND cause');
        });

        it('rate-limits connection-failure logs and logs recovery', async () => {
            device.connectBehaviour = 'refuse';
            const c = make({ backoffInitialMs: 100, backoffMaxMs: 1000 });
            /** @type {{level: string, message: string}[]} */
            const logs = [];
            c.on('log', (l) => logs.push(l));
            c.start();
            await clock.tickAsync(30000);
            assert.equal(logs.length, 1);
            assert.match(logs[0].message, /Unable to reach 10\.0\.0\.5:502 .*ECONNREFUSED/);
            await clock.tickAsync(31000);
            assert.equal(logs.length, 2);
            assert.match(logs[1].message, /Still unable/);
            device.refuseCode = 'EHOSTUNREACH';
            await clock.tickAsync(1100);
            assert.match(logs[2].message, /EHOSTUNREACH/);
            device.connectBehaviour = 'ok';
            await clock.tickAsync(1100);
            assert.equal(logs[logs.length - 1].level, 'info');
            assert.match(logs[logs.length - 1].message, /Connected to 10\.0\.0\.5:502 after \d+ failed attempt/);
        });

        it('hints at another master when a known-good device starts refusing', async () => {
            const c = await online();
            /** @type {string[]} */
            const logs = [];
            c.on('log', (l) => logs.push(l.message));
            device.connectBehaviour = 'refuse';
            device.current.drop();
            await clock.tickAsync(600);
            const hinted = logs.find((m) => /another master/.test(m));
            assert.ok(hinted, logs.join('\n'));
            assert.match(hinted, /\(attempt \d+, ECONNREFUSED\): .+; another master may be holding the device's connection$/);
            assert.match(hinted, /^[\x20-\x7e]*$/, 'plain ASCII, so Windows consoles and log shippers show it intact');
        });

        it('validates configuration', () => {
            assert.throws(() => new AlicatClient(/** @type {any} */ ({ host: '' })), (e) => /** @type {any} */ (e).code === 'EINVALIDARG');
            assert.throws(() => make({ requestTimeoutMs: -1 }), (e) => /** @type {any} */ (e).code === 'EINVALIDARG');
            assert.throws(() => make({ failFastWhenOffline: 'yes' }), (e) => /** @type {any} */ (e).code === 'EINVALIDARG');
            client = null;
        });

        it('only identical requests share a reply under one coalesce key', async () => {
            const c = await online();
            const before = device.log.length;
            const reads = Promise.all([
                c.readInputRegisters(1, 1346, 26, { coalesceKey: 'live:1' }),
                c.readInputRegisters(1, 1346, 26, { coalesceKey: 'live:1' }), // same block: shares the reply
                c.readInputRegisters(1, 1200, 17, { coalesceKey: 'live:1' }) // same key, different block (re-identified)
            ]);
            await clock.tickAsync(200);
            const [a, b, c2] = await reads;
            assert.equal(a.length, 26);
            assert.equal(b.length, 26);
            assert.equal(c2.length, 17, 'got its own block, not the other one');
            assert.equal(device.log.length - before, 2, 'two requests on the wire');
        });

        it('requests failed by a dropped link say when the reconnect will happen', async () => {
            const c = await online();
            /** @type {any[]} */
            const states = [];
            c.on('state', (s) => states.push(s));
            const pending = c.writeRegisters(1, 1010, [0, 0]).catch((e) => e); // still queued: the pump runs next tick
            device.current.drop();
            const err = await pending;
            assert.equal(err.code, 'ENOTCONNECTED');
            const backoff = states.find((s) => s.state === 'BACKOFF');
            assert.ok(err.nextRetryInMs > 0, `nextRetryInMs ${err.nextRetryInMs}`);
            assert.equal(err.nextRetryInMs, backoff.nextRetryInMs);
        });

        it('waits the request gap before retrying a request the device answered "busy"', async () => {
            const c = await online({ interFrameDelayMs: 50 });
            let calls = 0;
            device.handler = (_unit, request) => (++calls === 1
                ? { error: new AlicatError('EMODBUS', 'busy', { exceptionCode: 6 }) }
                : { fc: 4, registers: new Array(request.quantity).fill(0) });
            const read = c.readInputRegisters(1, 1200, 1);
            await clock.tickAsync(500);
            assert.deepEqual(await read, [0]);
            const [first, retry] = device.log.slice(-2);
            assert.ok(retry.at - first.at >= 50 + device.latencyMs, `retried after ${retry.at - first.at} ms`);
        });

        it('a throwing state listener does not keep queued requests from being sent', async () => {
            const c = make();
            c.on('state', (s) => { if (s.state === 'ONLINE') throw new Error('listener bug'); });
            let answered = false;
            c.readInputRegisters(1, 1200, 1, { priority: 1 }).then(() => { answered = true; });
            c.start();
            await clock.tickAsync(50);
            assert.equal(answered, true);
        });

        it('checks every setting before applying any (all-or-nothing configure)', () => {
            const c = make();
            const invalid = (/** @type {Record<string, unknown>} */ options) =>
                assert.throws(() => c.configure(options), (e) => /** @type {any} */ (e).code === 'EINVALIDARG', JSON.stringify(options));
            invalid({ backoffFactor: 0 }); // would reconnect in a tight loop
            invalid({ backoffInitialMs: 0 });
            invalid({ heartbeatRegister: 1200.5 }); // used to throw inside the heartbeat timer
            invalid({ heartbeatRegister: 0 });
            invalid({ heartbeatMs: 20 });
            invalid({ retries: 1.5 });
            invalid({ requestTimeoutMs: Infinity });
            invalid({ trace: 'yes' });
            invalid({ requestTimeoutMs: 2500, backoffFactor: 0 });
            assert.equal(c.options.requestTimeoutMs, 1000, 'the valid setting of a rejected call was not applied');
            c.configure({ heartbeatMs: 0, requestTimeoutMs: 2500 });
            assert.equal(c.options.heartbeatMs, 0, '0 turns the heartbeat off');
            assert.equal(c.options.requestTimeoutMs, 2500);
        });

        it('reports stats', async () => {
            const c = await online();
            const p = c.readInputRegisters(1, 1200, 1);
            await clock.tickAsync(10);
            await p;
            const s = c.stats();
            assert.equal(s.state, 'ONLINE');
            assert.equal(s.ok, 1);
            assert.deepEqual(s.depth, [0, 0, 0]);
            assert.equal(s.rtt.last, 5);
            assert.ok(s.transport);
        });
    });
});
