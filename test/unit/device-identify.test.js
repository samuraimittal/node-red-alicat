'use strict';

const assert = require('node:assert/strict');
const { identifyDevice, identityChanged, metadataChanged } = require('../../lib/device/identify');
const { DEFAULTS } = require('../../lib/device/options');
const { AlicatError } = require('../../lib/errors');
const { REG, BLOCKS, MAX_OPTIMIZED_READINGS } = require('../../lib/alicat/registers');
const { DeviceModel } = require('../../tools/sim/DeviceModel');
const { buildGen2, BENCH_10V20 } = require('../../tools/sim/profiles/gen2');
const { buildGen1, BENCH_9V07 } = require('../../tools/sim/profiles/gen1');
const { RegisterBank } = require('../../tools/sim/RegisterBank');

/**
 * A read function over a simulator register bank: what the device answers,
 * without a socket. An undefined register raises exception 02, as over TCP.
 * @param {InstanceType<typeof RegisterBank>} bank
 */
function readFrom(bank) {
    /** @type {number[]} registers read, in order */
    const reads = [];
    /** @param {number} register @param {number} quantity */
    const read = async (register, quantity) => {
        reads.push(register);
        try {
            return bank.read(register - 1, quantity);
        } catch (err) {
            const e = /** @type {{exceptionCode?: number, message: string}} */ (err);
            if (e.exceptionCode) throw new AlicatError('EMODBUS', e.message, { exceptionCode: e.exceptionCode });
            throw err;
        }
    };
    return Object.assign(read, { reads });
}

const gen2Bank = () => buildGen2(new DeviceModel(), BENCH_10V20, { serial: 123456 }).bank;
const gen1Bank = () => buildGen1(new DeviceModel(), BENCH_9V07).bank;
/** @param {Partial<typeof DEFAULTS>} [settings] */
const context = (settings = {}) => ({ settings: { ...DEFAULTS, ...settings }, unitId: 1, declaredVariable: null });

/** @param {Promise<unknown>} promise @param {RegExp} message */
async function refusesIdentity(promise, message) {
    await assert.rejects(promise, (err) => {
        assert.equal(/** @type {any} */ (err).code, 'EIDENTIFY');
        assert.match(/** @type {Error} */ (err).message, message);
        return true;
    });
}

describe('device/identify (fake reads over simulator register maps)', () => {
    it('identifies Gen-2 from the device alone', async () => {
        const id = await identifyDevice(readFrom(gen2Bank()), context());
        assert.equal(id.generation, 'gen2');
        assert.equal(id.firmware, '10v20.0');
        assert.equal(id.serial, 123456);
        assert.equal(id.layout, 'standard');
        assert.ok(id.readings.some((r) => r.key === 'gaugePressure'));
    });

    it('identifies Gen-1 from the exception on the firmware registers, with the configured layout', async () => {
        const id = await identifyDevice(readFrom(gen1Bank()), context({ layout: 'extended-7', controlVariable: 'massFlow' }));
        assert.equal(id.generation, 'gen1');
        assert.deepEqual(id.layout.length, 7);
        assert.equal(id.controlledVariable, 'massFlow');
        assert.equal(id.liveBlock.quantity, 3 + 7 * 2);
    });

    it('a declared mode (set by this library) wins over the configured one on Gen-1', async () => {
        const id = await identifyDevice(readFrom(gen1Bank()), { ...context({ layout: 'extended-7', controlVariable: 'massFlow' }), declaredVariable: 'valveDrive' });
        assert.equal(id.controlledVariable, 'valveDrive');
    });

    it('mapMode legacy never reads the firmware registers', async () => {
        const read = readFrom(gen1Bank());
        await identifyDevice(read, context({ mapMode: 'legacy', layout: 'extended-7' }));
        assert.equal(read.reads.includes(BLOCKS.FIRMWARE.start), false);
    });

    it('refuses mapMode modern on a Gen-1 device', async () => {
        await refusesIdentity(identifyDevice(readFrom(gen1Bank()), context({ mapMode: 'modern' })), /no firmware registers/);
    });

    it('refuses firmware registers that hold no Alicat version', async () => {
        const bank = gen2Bank();
        bank.set(REG.FW_MAJOR, 3);
        await refusesIdentity(identifyDevice(readFrom(bank), context()), /not an Alicat firmware version/);
    });

    it('refuses a Gen-2 gas number out of range', async () => {
        const bank = gen2Bank();
        for (const base of [REG.OPT_ALARM, 1246, REG.STD_INT_ALARM, REG.STD_FLOAT_ALARM]) bank.set(base + 1, 300);
        await refusesIdentity(identifyDevice(readFrom(bank), context()), /Gas number 300 is out of range/);
    });

    it('refuses an unknown setpoint statistic in the info blocks', async () => {
        const bank = gen2Bank();
        bank.set(REG.STD_INFO_BASE, 999); // the setpoint slot's statistic type
        await refusesIdentity(identifyDevice(readFrom(bank), context()), /Setpoint info type 999/);
    });

    it('refuses a failed word-order self-test', async () => {
        const bank = gen2Bank();
        bank.set(REG.TEST_FIXED, 0x064B);
        bank.set(REG.TEST_FIXED + 1, 0x3F9E);
        await refusesIdentity(identifyDevice(readFrom(bank), context()), /Word-order self-test failed \(CDAB\)/);
    });

    it('refuses a Gen-1 gas number out of range', async () => {
        const bank = gen1Bank();
        bank.set(REG.OPT_GAS, 400);
        await refusesIdentity(identifyDevice(readFrom(bank), context({ layout: 'extended-7' })), /is this an Alicat/);
    });

    it('refuses a Gen-1 frame with no slots', async () => {
        const bank = new RegisterBank();
        bank.defineRange(REG.OPT_GAS, 3);
        await refusesIdentity(identifyDevice(readFrom(bank), context({ mapMode: 'legacy' })), /no data-frame slots/);
    });

    it('refuses a frame whose every slot answers 0xFFFF (the end cannot be found)', async () => {
        const bank = new RegisterBank();
        bank.defineRange(REG.OPT_GAS, 3 + MAX_OPTIMIZED_READINGS * 2, { value: 0xFFFF });
        bank.set(REG.OPT_GAS, 8);
        await refusesIdentity(identifyDevice(readFrom(bank), context({ mapMode: 'legacy' })), /slot count cannot be determined/);
    });

    it('passes a transient failure on instead of guessing the other generation', async () => {
        const timeout = new AlicatError('ETIMEDOUT', 'no reply');
        await assert.rejects(identifyDevice(async () => { throw timeout; }, context()), (err) => err === timeout);
        const bank = gen1Bank();
        const flaky = async (/** @type {number} */ register, /** @type {number} */ quantity) => {
            if (register === REG.OPT_READING_BASE + 2) throw timeout; // the second slot
            return readFrom(bank)(register, quantity);
        };
        await assert.rejects(identifyDevice(flaky, context({ layout: 'extended-7' })), (err) => err === timeout);
    });

    it('tells a different instrument or firmware from a metadata change', async () => {
        const a = await identifyDevice(readFrom(gen2Bank()), context());
        if (a.generation !== 'gen2') throw new Error('expected gen2');
        assert.equal(identityChanged(null, a), false, 'the first identification is not a change');
        assert.equal(identityChanged(a, { ...a }), false);
        assert.equal(identityChanged(a, { ...a, serial: 1 }), true);
        assert.equal(identityChanged(a, { ...a, firmware: '10v21.0' }), true);
        assert.equal(metadataChanged(a, a.readings, a.controlledVariable), false);
        assert.equal(metadataChanged(a, a.readings, 'massFlow'), a.controlledVariable !== 'massFlow');
        assert.equal(metadataChanged(a, a.readings.map((r) => ({ ...r, decimals: 9 })), a.controlledVariable), true);
    });
});
