'use strict';

const { AlicatError, isModbusException } = require('../errors');
const codec = require('../alicat/codec');
const firmware = require('../alicat/firmware');
const { REG, BLOCKS, MAX_OPTIMIZED_READINGS } = require('../alicat/registers');
const { ILLEGAL_DATA_ADDRESS } = require('../modbus/exceptions');
const statistics = require('../alicat/statistics');
const modern = require('../alicat/profiles/modern');
const legacy = require('../alicat/profiles/legacy');

/**
 * Identification: which firmware generation answers, and how to read it.
 * Pure functions over a `read(register, quantity)` callback, so each step can
 * be tested without a socket.
 *
 * @typedef {import('./types').Identity} Identity
 * @typedef {import('./types').Gen1Identity} Gen1Identity
 * @typedef {import('./types').Gen2Identity} Gen2Identity
 * @typedef {import('./types').ReadingInfo} ReadingInfo
 * @typedef {import('./types').DeviceSettings} DeviceSettings
 * @typedef {(register: number, quantity: number) => Promise<number[]>} ReadFn
 */

/** Gas numbers above this are not Alicat gases: the device is something else. */
const MAX_GAS = 255;

/** @param {number} monthDay @param {number} year */
function formatDate(monthDay, year) {
    const month = monthDay >> 8;
    const day = monthDay & 0xFF;
    if (!year || !month || !day) return null;
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * Read and parse the Gen-2 info blocks (two reads: they exceed one request).
 * @param {ReadFn} read
 */
async function readInfoBlocks(read) {
    const { start, quantity } = modern.INFO_BLOCKS;
    const half = quantity / 2;
    const words = [...await read(start, half), ...await read(start + half, half)];
    const parsed = modern.parseInfoBlocks(words);
    if (!statistics.isKnown(parsed.setpointType)) {
        throw new AlicatError('EIDENTIFY', `Setpoint info type ${parsed.setpointType} is not a known Alicat statistic`);
    }
    return parsed;
}

/**
 * @param {ReadFn} read
 * @param {number[]} fw registers 1090–1093
 * @param {number} unitId
 * @returns {Promise<Gen2Identity>}
 */
async function identifyGen2(read, fw, unitId) {
    const version = firmware.fromRegisters(fw);
    const head = await read(BLOCKS.STD_FLOAT.start, 4);
    const gas = codec.u16(head, 1);
    if (gas > MAX_GAS) {
        throw new AlicatError('EIDENTIFY', `Gas number ${gas} is out of range`);
    }
    const { readings, setpointType } = await readInfoBlocks(read);
    let serial = null;
    let manufactured = null;
    let calibrated = null;
    if (firmware.supports(version, 'testRegisters')) {
        const order = codec.detectWordOrder(await read(REG.TEST_FIXED, 2));
        if (order !== 'ABCD') {
            throw new AlicatError('EIDENTIFY', `Word-order self-test failed (${order || 'no match'}); expected ABCD`);
        }
        const dev = await read(BLOCKS.DEVICE_INFO.start, BLOCKS.DEVICE_INFO.quantity);
        serial = codec.u32(dev, 0);
        manufactured = formatDate(codec.u16(dev, 2), codec.u16(dev, 3));
        calibrated = formatDate(codec.u16(dev, 4), codec.u16(dev, 5));
    }
    return {
        generation: 'gen2',
        firmware: version.text,
        serial,
        manufactured,
        calibrated,
        extendedCommands: true,
        setpointReadable: true,
        controlledVariable: statistics.controlledVariableFromSetpointType(setpointType),
        setpointType,
        readings: readings.map((r) => ({ ...r })),
        layout: 'standard',
        liveBlock: { ...modern.LIVE_BLOCK },
        unitId
    };
}

/**
 * Count the data-frame slots: the first missing slot raises exception 02.
 * @param {ReadFn} read
 */
async function countSlots(read) {
    let count = 0;
    let lastUndefined = false;
    // A data frame has at most MAX_OPTIMIZED_READINGS slots, so a full frame stops the probe without an exception.
    for (let n = 1; n <= MAX_OPTIMIZED_READINGS; n++) {
        try {
            const words = await read(REG.OPT_READING_BASE + (n - 1) * 2, 2);
            lastUndefined = codec.u32(words, 0) === codec.INVALID_FLOAT_BITS;
            count = n;
        } catch (err) {
            if (isModbusException(err, ILLEGAL_DATA_ADDRESS)) break;
            throw err; // a timeout is not the end of the slots
        }
    }
    if (count === 0) {
        throw new AlicatError('EIDENTIFY', 'The device has no data-frame slots');
    }
    if (count === MAX_OPTIMIZED_READINGS && lastUndefined) {
        // A device that answers undefined registers with 0xFFFF never marks the end of its frame.
        throw new AlicatError('EIDENTIFY',
            'Every data-frame slot answers (undefined registers read 0xFFFF), so the slot count cannot be determined');
    }
    return count;
}

/**
 * @param {ReadFn} read
 * @param {DeviceSettings} settings
 * @param {number} unitId
 * @param {string | null} declaredVariable the mode this library last switched to, if any
 * @returns {Promise<Gen1Identity>}
 */
async function identifyGen1(read, settings, unitId, declaredVariable) {
    const head = await read(REG.OPT_GAS, 3);
    const gas = codec.u16(head, 0);
    if (gas > MAX_GAS) {
        throw new AlicatError('EIDENTIFY', `Gas number ${gas} is out of range — is this an Alicat?`);
    }
    const count = await countSlots(read);
    const layout = legacy.resolveLayout(settings, count);
    const labels = settings.unitLabels || {}; // JS callers may pass null
    /** @type {ReadingInfo[]} */
    const readings = layout.map((key, i) => {
        const info = legacy.slotInfo(key);
        return {
            key, slot: i + 1, category: info.category, reference: info.reference,
            units: labels[key] || '', decimals: null, min: null, max: null,
            register: REG.OPT_READING_BASE + i * 2
        };
    });
    const configured = settings.controlVariable !== 'unknown' ? settings.controlVariable : null;
    return {
        generation: 'gen1',
        firmware: null,
        serial: null,
        manufactured: null,
        calibrated: null,
        extendedCommands: false,
        setpointReadable: layout.includes('setpoint'),
        controlledVariable: declaredVariable || configured,
        setpointType: null,
        readings,
        layout,
        liveBlock: legacy.liveBlock(count),
        unitId
    };
}

/**
 * Identify the instrument behind `read`. Gen-2 answers its firmware registers
 * with a plausible version; Gen-1 raises exception 02 there (or reads 0xFFFF).
 * A transient failure (timeout) is thrown, never taken as the other generation.
 * @param {ReadFn} read
 * @param {{settings: DeviceSettings, unitId: number, declaredVariable: string | null}} context
 * @returns {Promise<Identity>}
 */
async function identifyDevice(read, { settings, unitId, declaredVariable }) {
    const mode = settings.mapMode;
    /** @type {number[] | null} */
    let fw = null;
    let gen1 = mode === 'legacy';
    if (!gen1) {
        try {
            fw = await read(BLOCKS.FIRMWARE.start, 4);
        } catch (err) {
            if (!isModbusException(err, ILLEGAL_DATA_ADDRESS)) {
                throw err; // transient: retry, never fall through to the other generation
            }
            gen1 = true;
        }
        if (fw) {
            if (firmware.looksUndefined(fw)) {
                gen1 = true;
            } else if (!firmware.isPlausibleGen2(fw)) {
                throw new AlicatError('EIDENTIFY', `Firmware registers 1090–1093 hold ${fw.join(',')}, which is not an Alicat firmware version`);
            }
        }
    }
    if (mode === 'modern' && gen1) {
        throw new AlicatError('EIDENTIFY', 'Configured for firmware ≥ 10v07, but the device has no firmware registers (Gen-1)');
    }
    return gen1
        ? identifyGen1(read, settings, unitId, declaredVariable)
        : identifyGen2(read, /** @type {number[]} */ (fw), unitId); // read above whenever it is not Gen-1
}

/**
 * Whether `next` is a different instrument (or firmware) than `previous`.
 * @param {Identity | null} previous @param {Identity} next
 */
function identityChanged(previous, next) {
    return previous !== null && (previous.generation !== next.generation ||
        previous.firmware !== next.firmware || previous.serial !== next.serial);
}

/**
 * Whether re-read Gen-2 metadata differs from what the identity holds.
 * @param {Gen2Identity} id
 * @param {ReadingInfo[]} readings
 * @param {string | null} controlledVariable
 */
function metadataChanged(id, readings, controlledVariable) {
    const shape = (/** @type {ReadingInfo[]} */ list) => JSON.stringify(list.map((r) => [r.key, r.unitsCode, r.decimals, r.min, r.max]));
    return controlledVariable !== id.controlledVariable || shape(readings) !== shape(id.readings);
}

module.exports = { identifyDevice, readInfoBlocks, identityChanged, metadataChanged };
