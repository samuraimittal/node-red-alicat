'use strict';

const { defineDeviceNode } = require('../lib/node-red/device-node');
const { BOUNDS } = require('../lib/node-red/settings');
const { toNumber } = require('../lib/node-red/props');
const { formatValue } = require('../lib/node-red/status');
const { Reconciler } = require('../lib/Reconciler');
const { AlicatError } = require('../lib/errors');

/** @typedef {import('../lib/Reconciler').DesiredState} DesiredState */

/**
 * The desired state in msg.payload: a setpoint number, or {setpoint, variable, valve}.
 * @param {unknown} p
 * @returns {DesiredState}
 */
function desiredFrom(p) {
    if (typeof p === 'number' || typeof p === 'string') {
        return { setpoint: toNumber(p, 'Setpoint') };
    }
    if (p && typeof p === 'object') {
        const given = /** @type {{setpoint?: unknown, variable?: unknown, valve?: unknown}} */ (p);
        /** @type {DesiredState} */
        const desired = {};
        if (given.setpoint !== undefined) desired.setpoint = toNumber(given.setpoint, 'Setpoint');
        // The Reconciler checks variable and valve names.
        if (given.variable !== undefined) desired.variable = /** @type {string} */ (given.variable);
        if (given.valve !== undefined) desired.valve = /** @type {DesiredState['valve'] & string} */ (given.valve);
        if (Object.keys(desired).length === 0) {
            throw new AlicatError('EINVALIDARG', 'Desired state needs setpoint, variable and/or valve');
        }
        return desired;
    }
    throw new AlicatError('EINVALIDARG', 'msg.payload must be a setpoint number or {setpoint, variable, valve}');
}

/** @param {import('../lib/node-red/types').NodeRedRuntime} RED */
module.exports = function (RED) {
    defineDeviceNode(RED, {
        type: 'alicat-control',
        op: 'control',
        settings: (read) => ({
            intervalMs: read.number('interval', BOUNDS.control.interval, 'Check interval'),
            tolerance: read.optionalNumber('tolerance', 0, 'Tolerance'),
            correctionMs: read.number('correctionMs', BOUNDS.control.correctionMs, 'Correction delay'),
            maxAttempts: read.number('maxAttempts', BOUNDS.control.maxAttempts, 'Attempts'),
            onExternalChange: read.choice('onExternalChange', /** @type {const} */ (['revert', 'adopt', 'report']), 'revert', 'External change'),
            switchMode: read.choice('switchMode', /** @type {const} */ (['bumpless', 'direct']), 'bumpless', 'Mode switch')
        }),
        setup(ctx, settings) {
            const { node, device, owner, status } = ctx;
            const reconciler = new Reconciler(device, { owner, ...settings });

            reconciler.on('event', (e) => {
                const sp = e.desired.setpoint !== undefined ? `SP ${formatValue(e.desired.setpoint, device.getSetpointUnits())}` : 'held';
                switch (e.event) {
                    case 'converged': status.ready(`held ${sp}`); break;
                    case 'correcting': status.warn('converging'); break;
                    case 'drift': status.warn('drift'); break;
                    case 'failed': status.raw({ fill: 'red', shape: 'dot', text: 'not converging' }); break;
                    case 'released': status.raw({ fill: 'grey', shape: 'dot', text: 'released' }); break;
                    case 'waiting': status.raw({ fill: 'yellow', shape: 'ring', text: 'waiting for device' }); break;
                    default: break;
                }
                node.send({ topic: e.event, payload: e, alicat: ctx.info() });
            });
            reconciler.on('warning', (w) => node.warn(w));

            ctx.handleInput(null, (msg) => {
                if (msg.topic === 'release' || msg.payload === null) {
                    reconciler.release();
                } else {
                    reconciler.set(desiredFrom(msg.payload));
                }
            });

            ctx.onClose(() => reconciler.close());
        }
    });
};
