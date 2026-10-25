'use strict';

const assert = require('node:assert/strict');
const net = require('net');
const { EventEmitter } = require('events');
const { ModbusTcpTransport } = require('../../lib/modbus/ModbusTcpTransport');
const pdu = require('../../lib/modbus/pdu');
const { startRawServer, fc04Reply } = require('../helpers/raw-server');
const { delay } = require('../helpers/wait');
const { rejectsCode } = require('../helpers/assert');

const READ4 = () => pdu.buildReadInputRegisters(1089, 4);

describe('modbus/ModbusTcpTransport', () => {
    /** @type {Awaited<ReturnType<typeof startRawServer>> | null} */
    let server = null;
    /** @type {InstanceType<typeof ModbusTcpTransport> | null} */
    let transport = null;

    afterEach(async () => {
        if (transport) transport.destroy();
        transport = null;
        if (server) await server.close();
        server = null;
    });

    /**
     * @param {Parameters<typeof startRawServer>[0]} onFrame
     * @param {Partial<import('../../lib/modbus/ModbusTcpTransport').TransportOptions>} [options]
     */
    async function connect(onFrame, options = {}) {
        server = await startRawServer(onFrame);
        transport = new ModbusTcpTransport({ host: '127.0.0.1', port: server.port, ...options });
        await transport.connect();
        return transport;
    }

    it('sends a request and resolves with decoded registers and RTT', async () => {
        const t = await connect((frame, ctx) => {
            assert.deepEqual([...frame.pdu], [0x04, 0x04, 0x41, 0x00, 0x04]);
            ctx.reply(fc04Reply([10, 20, 0, 0]));
        });
        const res = await t.send(1, READ4(), 1000);
        assert.deepEqual(/** @type {any} */ (res).registers, [10, 20, 0, 0]);
        assert.ok(res.rttMs >= 0);
        assert.equal(t.stats.sent, 1);
        assert.equal(t.stats.received, 1);
        assert.ok(t.lastRxAt > 0);
    });

    it('reassembles a response delivered one byte at a time', async () => {
        const t = await connect((frame, ctx) => {
            const bytes = pdu.encodeFrame(frame.txnId, frame.unitId, fc04Reply([1, 2, 3, 4]));
            bytes.forEach((b, i) => setTimeout(() => ctx.raw(Buffer.from([b])), i));
        });
        const res = await t.send(1, READ4(), 2000);
        assert.deepEqual(/** @type {any} */ (res).registers, [1, 2, 3, 4]);
    });

    it('surfaces Modbus exceptions as EMODBUS and counts them', async () => {
        const t = await connect((_frame, ctx) => ctx.reply(Buffer.from([0x84, 0x02])));
        await assert.rejects(t.send(1, READ4(), 1000), (err) => {
            const e = /** @type {any} */ (err);
            return e.code === 'EMODBUS' && e.exceptionCode === 2;
        });
        assert.equal(t.stats.exceptions, 1);
        assert.equal(t.isOpen, true, 'an exception reply does not drop the link');
    });

    it('times out, then discards the late reply instead of handing it to the next request', async () => {
        let n = 0;
        const t = await connect((_frame, ctx) => {
            n++;
            if (n === 1) {
                // Reply to the first request only after it has timed out.
                setTimeout(() => ctx.reply(fc04Reply([0xDEAD, 0xDEAD, 0xDEAD, 0xDEAD])), 80);
            } else {
                ctx.reply(fc04Reply([1, 1, 1, 1]));
            }
        }, { lateReplyGraceMs: 500 });
        await rejectsCode(t.send(1, READ4(), 40), 'ETIMEDOUT');
        const started = Date.now();
        const res = await t.send(1, READ4(), 1000);
        assert.deepEqual(/** @type {any} */ (res).registers, [1, 1, 1, 1]);
        assert.equal(t.stats.timeouts, 1);
        assert.equal(t.stats.late, 1);
        assert.ok(Date.now() - started < 400, 'grace ends as soon as the late frame arrives');
    });

    it('waits at most lateReplyGraceMs after a timeout when no late reply comes', async () => {
        let n = 0;
        const t = await connect((_frame, ctx) => {
            n++;
            if (n > 1) ctx.reply(fc04Reply([2, 2, 2, 2]));
        }, { lateReplyGraceMs: 100 });
        await rejectsCode(t.send(1, READ4(), 30), 'ETIMEDOUT');
        const started = Date.now();
        await t.send(1, READ4(), 1000);
        const waited = Date.now() - started;
        assert.ok(waited >= 60 && waited < 400, `waited ${waited} ms`);
    });

    it('bounds the memory of timed-out transaction IDs', async () => {
        const t = await connect(() => {}, { lateReplyGraceMs: 0 });
        for (let i = 0; i < 40; i++) {
            await rejectsCode(t.send(1, READ4(), 1), 'ETIMEDOUT');
        }
        assert.equal(t.stats.timeouts, 40);
        assert.ok(/** @type {any} */ (t)._timedOut.size <= 32);
    });

    it('discards frames with unknown transaction IDs and mismatched function codes', async () => {
        const t = await connect((frame, ctx) => {
            ctx.reply(fc04Reply([9, 9, 9, 9]), { txnId: (frame.txnId + 100) & 0xFFFF }); // stale
            ctx.reply(Buffer.from([0x10, 0, 0, 0, 1])); // right txn, wrong function
            ctx.reply(fc04Reply([5, 6, 7, 8])); // the real answer
        });
        const res = await t.send(1, READ4(), 1000);
        assert.deepEqual(/** @type {any} */ (res).registers, [5, 6, 7, 8]);
        assert.equal(t.stats.stale, 1);
        assert.equal(t.stats.mismatched, 1);
    });

    it('accepts a reply with a different unit ID but warns once', async () => {
        const t = await connect((_frame, ctx) => ctx.reply(fc04Reply([1, 2, 3, 4]), { unitId: 255 }));
        /** @type {string[]} */
        const warnings = [];
        t.on('warning', (w) => warnings.push(w));
        await t.send(1, READ4(), 1000);
        await t.send(1, READ4(), 1000);
        assert.equal(warnings.length, 1);
        assert.match(warnings[0], /unit ID 255/);
    });

    it('wraps transaction IDs from 65535 to 1', async () => {
        /** @type {number[]} */
        const seen = [];
        const t = await connect((frame, ctx) => {
            seen.push(frame.txnId);
            ctx.reply(fc04Reply([0, 0, 0, 0]));
        }, { firstTxnId: 0xFFFE });
        for (let i = 0; i < 3; i++) await t.send(1, READ4(), 1000);
        assert.deepEqual(seen, [0xFFFE, 0xFFFF, 1]);
    });

    it('destroys the link on a framing error and rejects in-flight requests with EFRAMING', async () => {
        const t = await connect((frame, ctx) => {
            const bad = pdu.encodeFrame(frame.txnId, frame.unitId, fc04Reply([1, 2, 3, 4]));
            bad.writeUInt16BE(0xBEEF, 2);
            ctx.raw(bad);
        });
        /** @type {Error[]} */
        const downs = [];
        t.on('down', (err) => downs.push(err));
        await rejectsCode(t.send(1, READ4(), 1000), 'EFRAMING');
        assert.equal(t.state, 'down');
        assert.equal(downs.length, 1);
        assert.equal(/** @type {any} */ (downs[0]).code, 'EFRAMING');
        await rejectsCode(t.send(1, READ4(), 1000), 'ELINKDOWN');
    });

    it('emits down exactly once when the peer closes, rejecting pending with ELINKDOWN', async () => {
        const t = await connect((_frame, ctx) => ctx.socket.destroy());
        /** @type {Error[]} */
        const downs = [];
        t.on('down', (err) => downs.push(err));
        await rejectsCode(t.send(1, READ4(), 1000), 'ELINKDOWN');
        await t.closed;
        await delay(20);
        assert.equal(downs.length, 1);
        assert.equal(/** @type {any} */ (downs[0]).code, 'ELINKDOWN');
    });

    it('treats a peer FIN (end) as down', async () => {
        const t = await connect(() => {});
        const down = new Promise((resolve) => t.once('down', resolve));
        server && [...server.sockets][0].end();
        const err = /** @type {any} */ (await down);
        assert.equal(err.code, 'ELINKDOWN');
    });

    it('rejects send when not connected', async () => {
        transport = new ModbusTcpTransport({ host: '127.0.0.1', port: 1 });
        await rejectsCode(transport.send(1, READ4(), 100), 'ENOTCONNECTED');
    });

    it('reports ECONNECT with the OS error as cause when the port is closed', async () => {
        const probe = net.createServer();
        await new Promise((resolve) => probe.listen(0, '127.0.0.1', () => resolve(undefined)));
        const { port } = /** @type {net.AddressInfo} */ (probe.address());
        await new Promise((resolve) => probe.close(() => resolve(undefined)));
        transport = new ModbusTcpTransport({ host: '127.0.0.1', port, connectTimeoutMs: 3000 });
        await assert.rejects(transport.connect(), (err) => {
            const e = /** @type {any} */ (err);
            return e.code === 'ECONNECT' && e.cause && e.cause.code === 'ECONNREFUSED';
        });
        assert.equal(transport.state, 'down');
        await rejectsCode(transport.connect(), 'ECLOSED');
    });

    /** A socket stand-in that never connects, for timeout tests. */
    function hangingSocket() {
        const sock = /** @type {any} */ (new EventEmitter());
        sock.destroyed = false;
        sock.destroy = () => { sock.destroyed = true; setImmediate(() => sock.emit('close')); };
        sock.write = () => true;
        sock.end = () => {};
        sock.setNoDelay = () => {};
        sock.setKeepAlive = () => {};
        return sock;
    }

    it('times out a connect attempt with ECONNECT (cause ETIMEDOUT)', async () => {
        transport = new ModbusTcpTransport({
            host: '10.0.0.1', port: 502, connectTimeoutMs: 50, createConnection: hangingSocket
        });
        await assert.rejects(transport.connect(), (err) => {
            const e = /** @type {any} */ (err);
            return e.code === 'ECONNECT' && e.cause.code === 'ETIMEDOUT';
        });
        await transport.closed;
    });

    it('destroy() during connect rejects with ECANCELED and never emits down', async () => {
        transport = new ModbusTcpTransport({ host: '10.0.0.1', port: 502, createConnection: hangingSocket });
        let downs = 0;
        transport.on('down', () => downs++);
        const connecting = transport.connect();
        transport.destroy();
        await rejectsCode(connecting, 'ECANCELED');
        transport.destroy(); // idempotent
        assert.equal(downs, 0);
    });

    it('wraps a synchronous createConnection failure as ECONNECT', async () => {
        transport = new ModbusTcpTransport({
            host: 'x', port: 1, createConnection: () => { throw Object.assign(new Error('bad'), { code: 'EINVAL' }); }
        });
        await rejectsCode(transport.connect(), 'ECONNECT');
        await transport.closed;
    });

    it('a late socket event from a retired socket cannot affect the transport', async () => {
        const t = await connect((_frame, ctx) => ctx.reply(fc04Reply([0, 0, 0, 0])));
        const oldSock = /** @type {any} */ (t)._sock;
        t.destroy();
        assert.doesNotThrow(() => oldSock.emit('error', new Error('late')));
        assert.equal(t.state, 'down');
    });

    it('close() ends an idle link gracefully and resolves when closed', async () => {
        const t = await connect(() => {});
        /** @type {Error[]} */
        const downs = [];
        t.on('down', (e) => downs.push(e));
        await t.close(200);
        assert.equal(t.state, 'down');
        assert.equal(/** @type {any} */ (downs[0]).code, 'ECANCELED');
        await rejectsCode(t.send(1, READ4(), 100), 'ECLOSED');
    });

    it('close() with a request in flight destroys immediately and rejects it with ECANCELED', async () => {
        const t = await connect(() => {});
        const inflight = rejectsCode(t.send(1, READ4(), 5000), 'ECANCELED');
        await delay(10);
        await t.close();
        await inflight;
    });

    it('destroy() before connect is a no-op that resolves closed', async () => {
        transport = new ModbusTcpTransport({ host: '127.0.0.1', port: 1 });
        transport.destroy();
        await transport.closed;
        assert.equal(transport.state, 'down');
    });

    it('calls the trace hook for tx and rx bytes', async () => {
        /** @type {string[]} */
        const trace = [];
        const t = await connect((_frame, ctx) => ctx.reply(fc04Reply([1, 2, 3, 4])),
            { trace: (dir, data) => trace.push(`${dir}:${data.length}`) });
        await t.send(1, READ4(), 1000);
        assert.deepEqual(trace, ['tx:12', 'rx:17']);
    });
});
