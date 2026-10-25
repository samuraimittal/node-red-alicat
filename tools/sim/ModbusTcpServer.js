'use strict';

const net = require('net');
const { EventEmitter } = require('events');
const pdu = require('../../lib/modbus/pdu');
const { ILLEGAL_FUNCTION, ILLEGAL_DATA_VALUE, SERVER_DEVICE_FAILURE } = require('../../lib/modbus/exceptions');
const { ModbusException } = require('./RegisterBank');

const FC_READ_HOLDING_REGISTERS = 0x03;

/**
 * @typedef {{
 *   read: (address: number, quantity: number) => number[],
 *   write: (address: number, values: number[]) => void
 * }} RegisterHandler
 *
 * Fault injection knobs (mutable at runtime):
 * @typedef {{
 *   responseDelayMs: number,
 *   dropResponses: number,
 *   silent: boolean,
 *   splitResponses: boolean,
 *   garbageNextResponse: boolean,
 *   closeOnNextRequest: boolean,
 *   refuseConnections: boolean,
 *   rstMidFrame: boolean,
 *   exceptionCode: number
 * }} Faults
 */

/**
 * Minimal Modbus TCP server for the simulator and tests. Implements what an
 * Alicat answers over TCP: FC04 and FC16; FC03 is refused (RTU-only per the
 * Rev 7 manual) unless `allowFc03` is set; everything else is ILLEGAL FUNCTION.
 *
 * Events: 'connection' (socket), 'rejected' (socket), 'request' ({unitId, fc, address, quantity}, plus `values` for writes).
 */
class ModbusTcpServer extends EventEmitter {
    /**
     * @param {{
     *   registers: RegisterHandler,
     *   maxConnections?: number,
     *   allowFc03?: boolean,
     *   idleTimeoutMs?: number,
     *   ignoreUnitIds?: number[] | undefined,
     *   beforeRequest?: () => void
     * }} options
     */
    constructor(options) {
        super();
        this.registers = options.registers;
        this.maxConnections = options.maxConnections ?? Infinity;
        this.allowFc03 = options.allowFc03 ?? false;
        // Real 10v20 units close a connection after ~20 s without requests (Gate 0). 0 = never.
        this.idleTimeoutMs = options.idleTimeoutMs ?? 0;
        // 9v07 hardware doesn't answer unit ID 255 at all (Gate 0).
        this.ignoreUnitIds = new Set(options.ignoreUnitIds || []);
        this.beforeRequest = options.beforeRequest || null;
        /** @type {Faults} */
        this.faults = {
            responseDelayMs: 0,
            dropResponses: 0,
            silent: false,
            splitResponses: false,
            garbageNextResponse: false,
            closeOnNextRequest: false,
            refuseConnections: false,
            rstMidFrame: false,
            exceptionCode: 0
        };
        this.stats = { totalConnections: 0, rejectedConnections: 0, peakConnections: 0, requests: 0, idleDisconnects: 0 };
        /** @type {Set<net.Socket>} */
        this.sockets = new Set();
        this._server = net.createServer((socket) => this._onConnection(socket));
    }

    get connectionCount() {
        return this.sockets.size;
    }

    /**
     * @param {number} [port] 0 = ephemeral
     * @param {string} [host]
     * @returns {Promise<number>} bound port
     */
    listen(port = 0, host = '127.0.0.1') {
        return new Promise((resolve, reject) => {
            this._server.once('error', reject);
            this._server.listen(port, host, () => {
                this._server.removeListener('error', reject);
                const address = /** @type {net.AddressInfo} */ (this._server.address());
                resolve(address.port);
            });
        });
    }

    /** Close the listener and every open connection. @returns {Promise<void>} */
    close() {
        for (const socket of this.sockets) {
            socket.destroy();
        }
        return new Promise((resolve) => this._server.close(() => resolve()));
    }

    /** Drop every client connection (RST-like) without stopping the listener. */
    dropConnections() {
        for (const socket of this.sockets) {
            socket.destroy();
        }
    }

    /** @param {net.Socket} socket */
    _onConnection(socket) {
        socket.on('error', () => {});
        if (this.faults.refuseConnections || this.sockets.size >= this.maxConnections) {
            this.stats.rejectedConnections++;
            this.emit('rejected', socket);
            socket.destroy();
            return;
        }
        this.sockets.add(socket);
        this.stats.totalConnections++;
        this.stats.peakConnections = Math.max(this.stats.peakConnections, this.sockets.size);
        socket.setNoDelay(true);
        socket.once('close', () => this.sockets.delete(socket));
        this.emit('connection', socket);

        /** @type {NodeJS.Timeout | null} */
        let idleTimer = null;
        const armIdle = () => {
            if (!this.idleTimeoutMs) return;
            if (idleTimer) clearTimeout(idleTimer);
            idleTimer = setTimeout(() => {
                this.stats.idleDisconnects++;
                socket.end();
            }, this.idleTimeoutMs);
        };
        socket.once('close', () => { if (idleTimer) clearTimeout(idleTimer); });
        armIdle();

        const parser = new pdu.FrameParser();
        socket.on('data', (chunk) => {
            armIdle();
            let frames;
            try {
                frames = parser.push(chunk);
            } catch {
                socket.destroy();
                return;
            }
            for (const frame of frames) {
                this._onRequest(socket, frame);
            }
        });
    }

    /**
     * @param {net.Socket} socket
     * @param {import('../../lib/modbus/pdu').Frame} frame
     */
    _onRequest(socket, frame) {
        this.stats.requests++;
        if (this.faults.closeOnNextRequest) {
            this.faults.closeOnNextRequest = false;
            socket.destroy();
            return;
        }
        if (this.ignoreUnitIds.has(frame.unitId)) {
            return;
        }
        if (this.beforeRequest) {
            this.beforeRequest();
        }
        const response = this._execute(frame);
        if (this.faults.silent) {
            return;
        }
        if (this.faults.dropResponses > 0) {
            this.faults.dropResponses--;
            return;
        }
        let bytes = pdu.encodeFrame(frame.txnId, frame.unitId, response);
        if (this.faults.garbageNextResponse) {
            this.faults.garbageNextResponse = false;
            bytes = Buffer.from(bytes);
            bytes.writeUInt16BE(0xBEEF, 2); // invalid protocol identifier
        }
        if (this.faults.rstMidFrame) {
            this.faults.rstMidFrame = false;
            socket.write(bytes.subarray(0, Math.ceil(bytes.length / 2)), () => socket.destroy());
            return;
        }
        const send = () => {
            if (socket.destroyed) {
                return;
            }
            if (this.faults.splitResponses) {
                for (let i = 0; i < bytes.length; i++) {
                    const byte = bytes.subarray(i, i + 1);
                    setImmediate(() => { if (!socket.destroyed) socket.write(byte); });
                }
            } else {
                socket.write(bytes);
            }
        };
        if (this.faults.responseDelayMs > 0) {
            setTimeout(send, this.faults.responseDelayMs);
        } else {
            send();
        }
    }

    /**
     * @param {import('../../lib/modbus/pdu').Frame} frame
     * @returns {Buffer} response PDU
     */
    _execute(frame) {
        const request = frame.pdu;
        const fc = request.readUInt8(0); // the deframer guarantees at least one PDU byte
        if (this.faults.exceptionCode) {
            return Buffer.from([fc | pdu.EXCEPTION_FLAG, this.faults.exceptionCode]);
        }
        try {
            if (fc === pdu.FC_READ_INPUT_REGISTERS || (fc === FC_READ_HOLDING_REGISTERS && this.allowFc03)) {
                return this._read(frame, fc);
            }
            if (fc === pdu.FC_WRITE_MULTIPLE_REGISTERS) {
                return this._write(frame, fc);
            }
            throw new ModbusException(ILLEGAL_FUNCTION, `Function ${fc} not supported`);
        } catch (err) {
            const code = err instanceof ModbusException ? err.exceptionCode : SERVER_DEVICE_FAILURE;
            return Buffer.from([fc | pdu.EXCEPTION_FLAG, code]);
        }
    }

    /**
     * FC04 (and FC03 when allowed): read registers.
     * @param {import('../../lib/modbus/pdu').Frame} frame @param {number} fc
     * @returns {Buffer} response PDU
     */
    _read(frame, fc) {
        const request = frame.pdu;
        if (request.length !== 5) {
            throw new ModbusException(ILLEGAL_DATA_VALUE, 'Malformed read request');
        }
        const address = request.readUInt16BE(1);
        const quantity = request.readUInt16BE(3);
        if (quantity < 1 || quantity > pdu.MAX_READ_QUANTITY) {
            throw new ModbusException(ILLEGAL_DATA_VALUE, `Quantity ${quantity} out of range`);
        }
        this.emit('request', { unitId: frame.unitId, fc, address, quantity });
        const values = this.registers.read(address, quantity);
        const out = Buffer.alloc(2 + quantity * 2);
        out[0] = fc;
        out[1] = quantity * 2;
        values.forEach((v, i) => out.writeUInt16BE(v, 2 + i * 2));
        return out;
    }

    /**
     * FC16: write multiple registers.
     * @param {import('../../lib/modbus/pdu').Frame} frame @param {number} fc
     * @returns {Buffer} response PDU
     */
    _write(frame, fc) {
        const request = frame.pdu;
        const address = request.readUInt16BE(1);
        const quantity = request.readUInt16BE(3);
        const byteCount = request[5];
        if (quantity < 1 || quantity > pdu.MAX_WRITE_QUANTITY || byteCount !== quantity * 2 || request.length !== 6 + byteCount) {
            throw new ModbusException(ILLEGAL_DATA_VALUE, 'Malformed write request');
        }
        const values = [];
        for (let i = 0; i < quantity; i++) {
            values.push(request.readUInt16BE(6 + i * 2));
        }
        this.emit('request', { unitId: frame.unitId, fc, address, quantity, values });
        this.registers.write(address, values);
        return Buffer.from(request.subarray(0, 5));
    }
}

module.exports = { ModbusTcpServer };
