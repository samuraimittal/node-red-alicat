'use strict';

const assert = require('node:assert/strict');
const net = require('net');
const { AlicatSimulator } = require('../../tools/sim/AlicatSimulator');
const { ModbusTcpTransport } = require('../../lib/modbus/ModbusTcpTransport');
const pdu = require('../../lib/modbus/pdu');
const codec = require('../../lib/alicat/codec');
const firmware = require('../../lib/alicat/firmware');
const { REG, BLOCKS, STANDARD_READINGS, INFO_BLOCK, toAddress, standardFloatRegister } = require('../../lib/alicat/registers');
const { delay } = require('../helpers/wait');

/** @param {number} register @param {number} quantity */
const read = (register, quantity) => pdu.buildReadInputRegisters(toAddress(register), quantity);
/** @param {number} register @param {number[]} values */
const write = (register, values) => pdu.buildWriteMultipleRegisters(toAddress(register), values);

describe('simulator ↔ transport (10v20 MFC profile)', () => {
    let now = 1_000_000;
    /** @type {InstanceType<typeof AlicatSimulator>} */
    let sim;
    /** @type {InstanceType<typeof ModbusTcpTransport>} */
    let t;

    beforeEach(async () => {
        now = 1_000_000;
        sim = await new AlicatSimulator({ clock: () => now }).start();
        t = new ModbusTcpTransport({ host: '127.0.0.1', port: sim.port });
        await t.connect();
    });

    afterEach(async () => {
        t.destroy();
        await sim.stop();
    });

    /** @param {number} register @param {number} quantity */
    async function readWords(register, quantity) {
        const res = await t.send(1, read(register, quantity), 1000);
        return /** @type {any} */ (res).registers;
    }

    it('reports plausible Gen-2 firmware 10v20.0', async () => {
        const words = await readWords(BLOCKS.FIRMWARE.start, 4);
        assert.equal(firmware.isPlausibleGen2(words), true);
        assert.equal(firmware.fromRegisters(words).text, '10v20.0');
    });

    it('passes the word-order self-test', async () => {
        const words = await readWords(REG.TEST_FIXED, 2);
        assert.equal(codec.detectWordOrder(words), 'ABCD');
        assert.equal(codec.f32(words, 0), Math.fround(1.234567));
    });

    it('serves the standard float block with null for readings the device lacks', async () => {
        sim.model.set({ massFlow: 12.5, setpoint: 12.5, gas: 8 });
        const words = await readWords(BLOCKS.STD_FLOAT.start, BLOCKS.STD_FLOAT.quantity);
        assert.equal(codec.u16(words, 1), 8); // gas
        const value = (/** @type {string} */ name) => codec.f32(words, standardFloatRegister(name) - BLOCKS.STD_FLOAT.start);
        assert.equal(value('massFlow'), 12.5);
        assert.equal(value('setpoint'), 12.5);
        assert.equal(value('pressure'), Math.fround(14.7));
        assert.equal(value('pressure2'), null);
        assert.equal(value('humidity'), null);
    });

    it('serves info blocks with units, decimals and ranges', async () => {
        const half = BLOCKS.STD_INFO.quantity / 2;
        const words = [
            ...await readWords(BLOCKS.STD_INFO.start, half),
            ...await readWords(BLOCKS.STD_INFO.start + half, half)
        ];
        const info = (/** @type {string} */ name) => {
            const base = STANDARD_READINGS.indexOf(name) * INFO_BLOCK.SIZE;
            return {
                type: words[base + INFO_BLOCK.TYPE],
                units: words[base + INFO_BLOCK.UNITS],
                decimals: words[base + INFO_BLOCK.DECIMALS],
                max: codec.f32(words, base + INFO_BLOCK.MAX_FLOAT)
            };
        };
        assert.deepEqual(info('setpoint'), { type: 37, units: 7, decimals: 3, max: 20 });
        assert.deepEqual(info('massFlow'), { type: 5, units: 7, decimals: 3, max: 20 });
        assert.equal(info('humidity').type, 1); // None
    });

    it('accepts a setpoint write as one FC16 pair and clamps like the device', async () => {
        await t.send(1, write(REG.SETPOINT, codec.encodeF32(25)), 1000);
        const back = await readWords(REG.SETPOINT, 2);
        assert.equal(codec.f32(back, 0), 20); // clamped to full scale
        now += 5000; // flow settles (tau 200 ms → 25 τ)
        const words = await readWords(standardFloatRegister('massFlow'), 2);
        assert.equal(codec.f32(words, 0), 20);
    });

    it('rejects half of a setpoint pair with ILLEGAL DATA VALUE', async () => {
        await assert.rejects(t.send(1, write(REG.SETPOINT, [0x4148]), 1000),
            (err) => /** @type {any} */ (err).exceptionCode === 3);
    });

    it('refuses FC03 (RTU-only on Alicat) with ILLEGAL FUNCTION', async () => {
        // Not a request the library can build (it never sends FC03): hence the cast.
        const fc03 = /** @type {any} */ ({ ...read(REG.SETPOINT, 2), fc: 0x03 });
        fc03.pdu = Buffer.from(fc03.pdu);
        fc03.pdu[0] = 0x03;
        await assert.rejects(t.send(1, fc03, 1000), (err) => /** @type {any} */ (err).exceptionCode === 1);
    });

    it('raises ILLEGAL DATA ADDRESS for undefined and read-only registers', async () => {
        await assert.rejects(t.send(1, read(2041, 2), 1000), (err) => /** @type {any} */ (err).exceptionCode === 2);
        await assert.rejects(t.send(1, write(REG.FW_MAJOR, [1]), 1000), (err) => /** @type {any} */ (err).exceptionCode === 2);
    });

    it('accepts only one connection by default (collision guard for later milestones)', async () => {
        const second = new net.Socket();
        const closed = new Promise((resolve) => second.once('close', resolve));
        second.on('error', () => {});
        second.connect(sim.port, '127.0.0.1');
        await closed;
        assert.equal(sim.stats.rejectedConnections, 1);
        assert.equal(sim.stats.peakConnections, 1);
    });

    it('fault: dropped response → ETIMEDOUT, next request still works', async () => {
        sim.faults.dropResponses = 1;
        await assert.rejects(t.send(1, read(REG.OPT_GAS, 1), 50), (err) => /** @type {any} */ (err).code === 'ETIMEDOUT');
        const words = await readWords(REG.OPT_GAS, 1);
        assert.equal(words[0], 8);
    });

    it('fault: split responses are reassembled', async () => {
        sim.faults.splitResponses = true;
        const words = await readWords(BLOCKS.STD_FLOAT.start, BLOCKS.STD_FLOAT.quantity);
        assert.equal(words.length, 26);
    });

    it('fault: garbage response destroys the link with EFRAMING', async () => {
        sim.faults.garbageNextResponse = true;
        await assert.rejects(t.send(1, read(REG.OPT_GAS, 1), 1000), (err) => /** @type {any} */ (err).code === 'EFRAMING');
        assert.equal(t.state, 'down');
    });

    it('fault: delayed response still arrives within the timeout', async () => {
        sim.faults.responseDelayMs = 30;
        const words = await readWords(REG.OPT_GAS, 1);
        assert.equal(words[0], 8);
    });

    it('fault: connection closed on the next request → ELINKDOWN', async () => {
        sim.faults.closeOnNextRequest = true;
        await assert.rejects(t.send(1, read(REG.OPT_GAS, 1), 1000), (err) => /** @type {any} */ (err).code === 'ELINKDOWN');
    });

    it('fault: silent device → ETIMEDOUT and the transport stays open', async () => {
        sim.faults.silent = true;
        await assert.rejects(t.send(1, read(REG.OPT_GAS, 1), 40), (err) => /** @type {any} */ (err).code === 'ETIMEDOUT');
        assert.equal(t.isOpen, true);
        sim.faults.silent = false;
        await delay(5);
    });
});

describe('simulator options', () => {
    it('can answer undefined registers with 0xFFFF instead of an exception', async () => {
        const sim = await new AlicatSimulator({ undefinedValue: 0xFFFF }).start();
        const t = new ModbusTcpTransport({ host: '127.0.0.1', port: sim.port });
        try {
            await t.connect();
            const res = await t.send(1, read(2041, 2), 1000);
            assert.deepEqual(/** @type {any} */ (res).registers, [0xFFFF, 0xFFFF]);
        } finally {
            t.destroy();
            await sim.stop();
        }
    });

    it('keeps only the most recent commands in its log, so a long-running simulator does not grow', () => {
        const sim = new AlicatSimulator();
        sim.engine.maxLog = 5;
        for (let i = 0; i < 20; i++) {
            sim.bank.write(toAddress(REG.LIMITED_COMMAND_ID), [1, i % 2 === 0 ? 8 : 0]); // select gas, alternating
            sim.engine.cycle();
        }
        assert.equal(sim.engine.log.length, 5);
        assert.deepEqual(sim.engine.log.map((c) => c.arg), [0, 8, 0, 8, 0], 'the newest five');
    });

    it('rejects unknown profiles and lists known ones', () => {
        assert.throws(() => new AlicatSimulator({ profile: 'nope' }), /Unknown simulator profile/);
        assert.ok(Object.keys(AlicatSimulator.profiles).includes('10v20-mfc'));
    });
});
