'use strict';

// Hardware-in-the-loop smoke test — READ-ONLY. Skipped unless ALICAT_HIL_HOST is set.
//
//   $env:ALICAT_HIL_HOST = '10.0.0.5'; npm run test:hil
//
// Optional: ALICAT_HIL_PORT (502), ALICAT_HIL_UNIT (1),
//           ALICAT_HIL_PROBE_CONNECTIONS=1 to test the TCP connection limit
//           (temporarily occupies extra connection slots — do not run while a PLC depends on the device).
// Paste the printed report into docs/hardware-validation.md.

const assert = require('node:assert/strict');
const net = require('net');
const { ModbusTcpTransport } = require('../../lib/modbus/ModbusTcpTransport');
const pdu = require('../../lib/modbus/pdu');
const codec = require('../../lib/alicat/codec');
const firmware = require('../../lib/alicat/firmware');
const { REG, BLOCKS, toAddress } = require('../../lib/alicat/registers');

const HOST = process.env.ALICAT_HIL_HOST;
const PORT = Number(process.env.ALICAT_HIL_PORT || 502);
const UNIT = Number(process.env.ALICAT_HIL_UNIT || 1);
const TIMEOUT = 1500;

/** @type {Record<string, unknown>} */
const report = {};

/** @param {unknown} err */
const describeError = (err) => {
    const e = /** @type {any} */ (err);
    return e.code === 'EMODBUS' ? `exception ${e.exceptionCode} ${e.exceptionName}` : `${e.code}: ${e.message}`;
};

(HOST ? describe : describe.skip)(`HIL smoke (read-only) — ${HOST}:${PORT} unit ${UNIT}`, function () {
    this.timeout(60000);
    /** @type {InstanceType<typeof ModbusTcpTransport>} */
    let t;
    /** @type {number[] | null} */
    let fw = null;

    /** @param {number} register @param {number} quantity @param {number} [unit] */
    const read = async (register, quantity, unit = UNIT) => {
        const res = await t.send(unit, pdu.buildReadInputRegisters(toAddress(register), quantity), TIMEOUT);
        return /** @type {{registers: number[]}} */ (res).registers;
    };

    before(async () => {
        t = new ModbusTcpTransport({ host: /** @type {string} */ (HOST), port: PORT });
        await t.connect();
    });

    after(() => {
        t.destroy();
        console.log('\n=== HIL report (paste into docs/hardware-validation.md) ===');
        console.log(JSON.stringify({ host: HOST, port: PORT, unit: UNIT, date: new Date().toISOString(), ...report }, null, 2));
    });

    it('item 8: firmware registers 1090–1093 (Gen-2) or exception/0xFFFF (Gen-1)', async () => {
        try {
            fw = await read(BLOCKS.FIRMWARE.start, 4);
            report.firmwareRegisters = fw;
            report.generation = firmware.isPlausibleGen2(fw) ? 'gen2' : firmware.looksUndefined(fw) ? 'gen1 (0xFFFF)' : 'UNEXPECTED';
            if (firmware.isPlausibleGen2(fw)) {
                report.firmware = firmware.fromRegisters(fw).text;
            }
        } catch (err) {
            report.firmwareRegisters = describeError(err);
            report.generation = /** @type {any} */ (err).exceptionCode === 2 ? 'gen1 (exception 02)' : 'UNEXPECTED';
        }
        assert.notEqual(report.generation, 'UNEXPECTED', `firmware read: ${JSON.stringify(report.firmwareRegisters)}`);
    });

    it('header 1200–1202: gas number and device status', async () => {
        const words = await read(REG.OPT_GAS, 3);
        report.gas = words[0];
        report.status = codec.u32(words, 1);
        assert.ok(words[0] <= 255, 'gas number should be 0–255');
    });

    it('Gen-2: word-order self-test, standard block, info blocks, device info', async function () {
        if (!fw || !firmware.isPlausibleGen2(fw)) this.skip();
        const std = await read(BLOCKS.STD_FLOAT.start, BLOCKS.STD_FLOAT.quantity);
        report.standardBlock = Array.from({ length: 11 }, (_, i) => codec.f32(std, 4 + i * 2));
        const half = BLOCKS.STD_INFO.quantity / 2;
        const info = [...await read(BLOCKS.STD_INFO.start, half), ...await read(BLOCKS.STD_INFO.start + half, half)];
        report.infoTypes = Array.from({ length: 11 }, (_, i) => info[i * 12]);
        report.infoUnits = Array.from({ length: 11 }, (_, i) => info[i * 12 + 10]);
        report.infoDecimals = Array.from({ length: 11 }, (_, i) => info[i * 12 + 11]);
        if (firmware.supports(firmware.fromRegisters(/** @type {number[]} */ (fw)), 'testRegisters')) {
            const test = await read(REG.TEST_FIXED, 2);
            report.wordOrder = codec.detectWordOrder(test);
            const dev = await read(BLOCKS.DEVICE_INFO.start, BLOCKS.DEVICE_INFO.quantity);
            report.serial = codec.u32(dev, 0);
            assert.equal(report.wordOrder, 'ABCD');
        }
    });

    it('Gen-1: data-frame slot count (probe until exception 02)', async function () {
        if (fw && firmware.isPlausibleGen2(fw)) this.skip();
        let slots = 0;
        for (let n = 1; n <= 20; n++) {
            try {
                await read(REG.OPT_READING_BASE + (n - 1) * 2, 2);
                slots = n;
            } catch (err) {
                report.slotProbeStop = describeError(err);
                break;
            }
        }
        report.slots = slots;
        if (slots > 0) {
            const frame = await read(REG.OPT_READING_BASE, slots * 2);
            report.slotValues = Array.from({ length: slots }, (_, i) => codec.f32(frame, i * 2));
        }
        assert.ok([1, 2, 4, 5, 6].includes(slots) || slots > 6, `unexpected slot count ${slots}`);
    });

    it('item 2: FC03 on TCP should raise exception 01', async () => {
        const req = pdu.buildReadInputRegisters(toAddress(REG.OPT_GAS), 1);
        // Not a request the library can build (it never sends FC03): hence the cast.
        const fc03 = /** @type {any} */ ({ ...req, fc: 0x03, pdu: Buffer.from(req.pdu) });
        fc03.pdu[0] = 0x03;
        try {
            await t.send(UNIT, fc03, TIMEOUT);
            report.fc03 = 'ANSWERED (not RTU-only on this unit)';
        } catch (err) {
            report.fc03 = describeError(err);
        }
    });

    it('item 3: maximum FC04 quantity (Gen-2 info area 1400–1639)', async function () {
        if (!fw || !firmware.isPlausibleGen2(fw)) this.skip();
        let lo = 1;
        let hi = 125;
        let best = 0;
        while (lo <= hi) {
            const mid = Math.floor((lo + hi) / 2);
            try {
                await read(REG.OPT_INFO_BASE, mid);
                best = mid;
                lo = mid + 1;
            } catch (err) {
                if (/** @type {any} */ (err).code !== 'EMODBUS') throw err;
                hi = mid - 1;
            }
        }
        report.maxFc04Quantity = best;
    });

    it('item 1: which unit IDs does native TCP answer?', async () => {
        /** @type {Record<string, string>} */
        const result = {};
        for (const unit of [0, 1, 2, 247, 255]) {
            try {
                await read(REG.OPT_GAS, 1, unit);
                result[unit] = 'answers';
            } catch (err) {
                result[unit] = describeError(err);
            }
        }
        report.unitIds = result;
    });

    it('item 4: concurrent connection limit (opt-in)', async function () {
        if (process.env.ALICAT_HIL_PROBE_CONNECTIONS !== '1') this.skip();
        /** @type {net.Socket[]} */
        const extra = [];
        let accepted = 0;
        for (let i = 0; i < 8; i++) {
            const sock = new net.Socket();
            sock.on('error', () => {});
            const ok = await new Promise((resolve) => {
                const timer = setTimeout(() => resolve(false), 2000);
                sock.once('connect', () => { clearTimeout(timer); setTimeout(() => resolve(!sock.destroyed), 300); });
                sock.once('close', () => { clearTimeout(timer); resolve(false); });
                sock.connect(PORT, /** @type {string} */ (HOST));
            });
            extra.push(sock);
            if (!ok) break;
            accepted++;
        }
        let firstStillWorks = true;
        try {
            await read(REG.OPT_GAS, 1);
        } catch {
            firstStillWorks = false;
        }
        extra.forEach((s) => s.destroy());
        report.extraConnectionsAccepted = accepted;
        report.firstConnectionSurvived = firstStillWorks;
    });
});
