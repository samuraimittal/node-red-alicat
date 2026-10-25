'use strict';

const net = require('net');
const { FrameParser, encodeFrame } = require('../../lib/modbus/pdu');

/**
 * A Modbus TCP server whose behaviour each test scripts frame by frame.
 * `onFrame(frame, ctx)` decides what to send back: `ctx.reply(pdu)`,
 * `ctx.raw(buffer)`, or nothing.
 *
 * @param {(frame: import('../../lib/modbus/pdu').Frame, ctx: {
 *   socket: net.Socket,
 *   reply: (pdu: Buffer, overrides?: {txnId?: number, unitId?: number}) => void,
 *   raw: (bytes: Buffer) => void
 * }) => void} onFrame
 */
async function startRawServer(onFrame) {
    /** @type {Set<net.Socket>} */
    const sockets = new Set();
    let connections = 0;
    const server = net.createServer((socket) => {
        connections++;
        sockets.add(socket);
        socket.on('error', () => {});
        socket.once('close', () => sockets.delete(socket));
        const parser = new FrameParser();
        socket.on('data', (chunk) => {
            for (const frame of parser.push(chunk)) {
                onFrame(frame, {
                    socket,
                    reply: (pdu, overrides = {}) => socket.write(encodeFrame(
                        overrides.txnId ?? frame.txnId, overrides.unitId ?? frame.unitId, pdu)),
                    raw: (bytes) => socket.write(bytes)
                });
            }
        });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
    const { port } = /** @type {net.AddressInfo} */ (server.address());
    return {
        port,
        sockets,
        get connections() { return connections; },
        close() {
            for (const s of sockets) s.destroy();
            return new Promise((resolve) => server.close(() => resolve(undefined)));
        }
    };
}

/** FC04 reply carrying `values`. @param {number[]} values */
function fc04Reply(values) {
    const pdu = Buffer.alloc(2 + values.length * 2);
    pdu[0] = 0x04;
    pdu[1] = values.length * 2;
    values.forEach((v, i) => pdu.writeUInt16BE(v, 2 + i * 2));
    return pdu;
}

/** Deterministic PRNG (mulberry32) for fuzz tests. @param {number} seed */
function prng(seed) {
    let a = seed >>> 0;
    return function next() {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** @param {number} ms */
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

module.exports = { startRawServer, fc04Reply, prng, delay };
