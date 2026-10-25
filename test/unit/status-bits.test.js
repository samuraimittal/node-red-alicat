'use strict';

const assert = require('node:assert/strict');
const { decodeStatus, decodeAlarms, isValveState } = require('../../lib/alicat/status-bits');

describe('alicat/status-bits', () => {
    it('decodes HLD (bit 8) and EXH (bit 10) on both generations', () => {
        for (const gen of /** @type {const} */ (['gen1', 'gen2'])) {
            const s = decodeStatus(0x0400 | 0x0100, gen);
            assert.equal(s.flags.holding, true);
            assert.equal(s.flags.exhausting, true);
            assert.deepEqual(s.active, ['holding', 'exhausting']);
        }
    });

    it('keeps raw and reports bits it has no name for', () => {
        const s = decodeStatus(0x80001000, 'gen2');
        assert.equal(s.raw, 0x80001000);
        assert.deepEqual(s.unknownBits, [12, 31]);
        assert.equal(decodeStatus(0x1000, 'gen1').flags.flowOverrangeWhileTotalizing, true);
    });

    it('decodes alarm outputs', () => {
        assert.deepEqual(decodeAlarms(3), { raw: 3, alarm1: true, alarm2: true });
        assert.deepEqual(decodeAlarms(2), { raw: 2, alarm1: false, alarm2: true });
    });

    it('says whether the status bits show the state a valve command asks for', () => {
        const idle = decodeStatus(0, 'gen2').flags;
        const holding = decodeStatus(1 << 8, 'gen2').flags;
        const exhausting = decodeStatus(1 << 10, 'gen2').flags;
        const cases = /** @type {const} */ ([
            ['resume', [true, false, false]],
            ['holdClosed', [false, true, false]],
            ['holdCurrent', [false, true, false]],
            ['exhaust', [false, false, true]]
        ]);
        for (const [action, expected] of cases) {
            assert.deepEqual([idle, holding, exhausting].map((f) => isValveState(f, action)), expected, action);
        }
    });
});
