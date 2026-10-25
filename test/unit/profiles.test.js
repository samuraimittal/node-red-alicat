'use strict';

const assert = require('node:assert/strict');
const legacy = require('../../lib/alicat/profiles/legacy');
const modern = require('../../lib/alicat/profiles/modern');
const codec = require('../../lib/alicat/codec');
const { throwsCode } = require('../helpers/assert');

describe('alicat/profiles/legacy (Gen-1 layouts)', () => {
    it('resolves presets and validates custom layouts', () => {
        assert.deepEqual(legacy.validateLayout('extended-7'), ['absolutePressure', 'gaugePressure', 'barometricPressure',
            'temperature', 'volumetricFlow', 'massFlow', 'setpoint']);
        assert.deepEqual(legacy.validateLayout(['pressure', 'setpoint']), ['pressure', 'setpoint']);
        throwsCode(() => legacy.validateLayout('nope'), 'EINVALIDARG');
        throwsCode(() => legacy.validateLayout([]), 'EINVALIDARG');
        throwsCode(() => legacy.validateLayout(['massFlow', 'massFlow']), 'EINVALIDARG');
        throwsCode(() => legacy.validateLayout(['flux']), 'EINVALIDARG');
    });

    it('guesses the default frame from the slot count and refuses to guess when ambiguous', () => {
        assert.deepEqual(legacy.resolveLayout({}, 1), ['pressure']);
        assert.deepEqual(legacy.resolveLayout({}, 2), ['pressure', 'setpoint']);
        assert.equal(legacy.resolveLayout({}, 4).length, 4);
        assert.equal(legacy.resolveLayout({}, 6).length, 6);
        assert.throws(() => legacy.resolveLayout({}, 5), /set the device type/);
        assert.deepEqual(legacy.resolveLayout({ deviceType: 'mfc' }, 5), ['absolutePressure', 'temperature', 'volumetricFlow', 'massFlow', 'setpoint']);
        assert.equal(legacy.resolveLayout({ deviceType: 'mfm' }, 5).includes('totalMass'), true);
        assert.throws(() => legacy.resolveLayout({}, 7), /extended-7/);
        throwsCode(() => legacy.resolveLayout({ deviceType: 'toaster' }, 2), 'EINVALIDARG');
        throwsCode(() => legacy.resolveLayout({ layout: 'pc' }, 3), 'EIDENTIFY');
    });

    it('describes each layout slot and rejects names that are not slots', () => {
        assert.deepEqual(legacy.slotInfo('gaugePressure'), { category: 'pressure', reference: 'gauge' });
        throwsCode(() => legacy.slotInfo('flux'), 'EINVALIDARG');
        throwsCode(() => legacy.slotInfo('toString'), 'EINVALIDARG');
    });

    it('decodes the live block into named values', () => {
        const words = [8, 0, 0x0100, ...codec.encodeF32(14.75), ...codec.encodeF32(12.5)];
        const live = legacy.decodeLive(words, ['absolutePressure', 'setpoint']);
        assert.equal(live.gas, 8);
        assert.equal(live.statusRaw, 0x100);
        assert.equal(live.values.setpoint, 12.5);
        assert.deepEqual(legacy.liveBlock(7), { start: 1200, quantity: 17 });
    });
});

describe('alicat/profiles/modern (Gen-2 info blocks)', () => {
    /** @param {number} type @param {number} units @param {number} decimals @param {number} min @param {number} max */
    const block = (type, units, decimals, min, max) =>
        [type, 2, 0, 0, 0, 0, ...codec.encodeF32(min), ...codec.encodeF32(max), units, decimals];
    const none = () => [0, 0, 0, 0, 0, 0, 0xFFFF, 0xFFFF, 0xFFFF, 0xFFFF, 0, 0];

    it('names readings by statistic type and skips absent slots', () => {
        const words = [
            ...block(45, 63, 2, -100, 100), ...block(13, 63, 2, 0, 100), ...block(6, 10, 2, -15, 160),
            ...block(2, 10, 2, 0, 160), ...block(15, 10, 3, 0, 14.7), ...block(3, 2, 2, -10, 60),
            ...block(4, 7, 4, -2, 2), ...block(5, 12, 1, -2000, 2000), ...none(), ...none(), ...none()
        ];
        const { readings, setpointType } = modern.parseInfoBlocks(words);
        assert.equal(setpointType, 45);
        assert.deepEqual(readings.map((r) => r.key), ['setpoint', 'valveDrive', 'gaugePressure', 'absolutePressure',
            'barometricPressure', 'temperature', 'volumetricFlow', 'massFlow']);
        assert.equal(readings.find((r) => r.key === 'massFlow')?.units, 'SCCM');
        assert.equal(readings.find((r) => r.key === 'gaugePressure')?.register, 1354);
    });

    it('de-duplicates keys when two slots report the same statistic', () => {
        const words = [...none(), ...none(), ...block(2, 10, 2, 0, 160), ...block(2, 10, 2, 0, 160),
            ...none(), ...none(), ...none(), ...none(), ...none(), ...none(), ...none()];
        const { readings } = modern.parseInfoBlocks(words);
        assert.deepEqual(readings.map((r) => r.key), ['absolutePressure', 'absolutePressure_pressure2']);
    });
});
