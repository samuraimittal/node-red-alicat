'use strict';

const { defineDeviceNode } = require('../lib/node-red/device-node');
const { propertyValue, toNumber } = require('../lib/node-red/props');
const { formatValue } = require('../lib/node-red/status');
const { AlicatError } = require('../lib/errors');
const { CONTROL_VARIABLES } = require('../lib/alicat/statistics');

/** `current`: keep the device's mode; `msg`: msg.variable decides. */
const VARIABLES = ['current', 'msg', ...Object.keys(CONTROL_VARIABLES)];

/** @param {import('../lib/node-red/types').NodeRedRuntime} RED */
module.exports = function (RED) {
    defineDeviceNode(RED, {
        type: 'alicat-setpoint',
        op: 'setpoint',
        settings: (read) => ({
            value: read.optionalText('value'),
            valueType: read.text('valueType', 'msg'),
            variable: read.choice('variable', VARIABLES, 'current', 'Control variable'),
            switchMode: read.choice('switchMode', /** @type {const} */ (['bumpless', 'direct']), 'bumpless', 'Mode switch'),
            outOfRange: read.choice('outOfRange', /** @type {const} */ (['reject', 'clamp']), 'reject', 'Out of range'),
            verify: read.flag('verify', true),
            savePowerUp: read.flag('savePowerUp', false)
        }),
        setup(ctx, settings) {
            const { device, owner, status } = ctx;
            const { switchMode, outOfRange, verify } = settings;

            ctx.handleInput('setpoint', async (msg, send) => {
                const raw = await ctx.evaluate(msg, propertyValue(settings.value, settings.valueType, 'Setpoint'), settings.valueType);
                const value = toNumber(raw, 'Setpoint');
                const variable = settings.variable === 'msg' ? msg.variable || 'current' : settings.variable;
                if (typeof variable !== 'string' || (variable !== 'current' && !Object.hasOwn(CONTROL_VARIABLES, variable))) {
                    throw new AlicatError('EINVALIDARG',
                        `Unknown control variable "${String(variable)}". Use: current, ${Object.keys(CONTROL_VARIABLES).join(', ')}`, { outcome: 'not-sent' });
                }
                const result = await device.setSetpoint(value, { variable, switchMode, outOfRange, verify, owner });
                if (settings.savePowerUp && !result.superseded) {
                    await device.command('savePowerUpSetpoint', 0, { owner });
                }
                msg.payload = result.actual ?? result.written;
                msg.alicat = ctx.info({
                    outcome: result.outcome,
                    controlledVariable: result.variable,
                    units: { setpoint: result.units },
                    result
                });
                if (result.superseded) status.ready('superseded');
                else if (result.outcome === 'unknown') status.warn('SP not confirmed');
                else status.ready(`SP ${formatValue(result.actual ?? result.written, result.units)}`);
                send(msg);
            });
        }
    });
};
