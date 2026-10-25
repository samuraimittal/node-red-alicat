'use strict';

const { RegisterBank } = require('../RegisterBank');
const { REG } = require('../../../lib/alicat/registers');
const codec = require('../../../lib/alicat/codec');

/**
 * Replica of bench unit 2 (firmware 9v07, Gate 0, 2026-10-15). Over TCP it
 * exposes only:
 * - 1000–1001 (limited commands);
 * - 1010–1011 (setpoint, write-only: a read raises exception 02);
 * - 1200 gas and 1201–1202 status;
 * - N float slots from 1203.
 *
 * Everything else raises exception 02, including the slot after the last one.
 * @param {InstanceType<typeof import('../DeviceModel').DeviceModel>} model
 * @param {{frame: string[]}} config
 * @param {{undefinedValue?: number | null}} [options]
 */
function buildGen1(model, config, options = {}) {
    const bank = new RegisterBank({ undefinedValue: options.undefinedValue ?? null });
    bank.group(REG.SETPOINT, 2, (words) => model.setSetpoint(codec.f32(words, 0)), { store: false, readable: false });
    bank.defineRange(REG.OPT_GAS, 3 + config.frame.length * 2);

    function refresh() {
        model.advance();
        bank.set(REG.OPT_GAS, model.state.gas);
        bank.setU32(REG.OPT_STATUS, model.status);
        config.frame.forEach((key, i) => {
            bank.setFloat(REG.OPT_READING_BASE + i * 2, model.reading(key));
        });
    }

    refresh();
    return { bank, refresh, refreshInfo: () => {}, generation: 1 };
}

const BENCH_9V07 = Object.freeze({
    frame: ['absolutePressure', 'gaugePressure', 'barometricPressure', 'temperature', 'volumetricFlow', 'massFlow', 'setpoint']
});

module.exports = { buildGen1, BENCH_9V07 };
