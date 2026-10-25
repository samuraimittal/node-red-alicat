'use strict';

const { defineDeviceNode } = require('../lib/node-red/device-node');
const { toNumber } = require('../lib/node-red/props');
const { AlicatError } = require('../lib/errors');
const { COMMANDS } = require('../lib/alicat/commands');
const { own } = require('../lib/util/own');

const ACTIONS = /** @type {const} */ (['read', 'write', 'algorithm']);
const ALGORITHMS = /** @type {const} */ (['PDF', 'PD2I']);

/**
 * Where a gain comes from. Stored as pGain/dGain/iGain, because Node-RED
 * reserves `d` for "node disabled". A missing field means the editor default
 * (msg.payload.p …); an empty one, cleared on purpose, leaves that gain unchanged (null).
 * @param {import('../lib/node-red/settings').SettingsReader} read
 * @param {'p' | 'd' | 'i'} name
 */
function gainSource(read, name) {
    const value = read.optionalText(`${name}Gain`);
    return value === '' ? null : { value: value ?? `payload.${name}`, type: read.text(`${name}GainType`, 'msg') };
}

/** @param {import('../lib/node-red/types').NodeRedRuntime} RED */
module.exports = function (RED) {
    defineDeviceNode(RED, {
        type: 'alicat-pid',
        op: 'pid',
        settings: (read) => ({
            action: read.choice('action', ACTIONS, 'read', 'Action'),
            algorithm: read.choice('algorithm', ALGORITHMS, 'PDF', 'Algorithm'),
            gains: { p: gainSource(read, 'p'), d: gainSource(read, 'd'), i: gainSource(read, 'i') }
        }),
        setup(ctx, { action, algorithm: configuredAlgorithm, gains: sources }) {
            const { device, owner, status } = ctx;

            /** @param {import('../lib/node-red/types').NodeMessage} msg @param {'p' | 'd' | 'i'} name */
            const gain = async (msg, name) => {
                const source = sources[name];
                if (!source) return undefined;
                const raw = await ctx.evaluate(msg, source.value, source.type);
                if (raw === undefined || raw === null || raw === '') return undefined;
                return toNumber(raw, `${name.toUpperCase()} gain`);
            };

            ctx.handleInput('pid', async (msg, send) => {
                if (action === 'algorithm') {
                    const algorithm = msg.algorithm || configuredAlgorithm;
                    const arg = typeof algorithm === 'string' ? own(COMMANDS.setLoopAlgorithm.args, algorithm) : undefined;
                    if (arg === undefined) throw new AlicatError('EINVALIDARG', `Algorithm must be PDF or PD2I, got ${String(algorithm)}`);
                    const r = await device.command('setLoopAlgorithm', arg, { owner });
                    msg.payload = { algorithm, outcome: r.outcome };
                    msg.alicat = ctx.info({ outcome: r.outcome, result: r });
                    status.ready(`algorithm ${algorithm}`);
                } else if (action === 'write') {
                    const wanted = { p: await gain(msg, 'p'), d: await gain(msg, 'd'), i: await gain(msg, 'i') };
                    if (wanted.p === undefined && wanted.d === undefined && wanted.i === undefined) {
                        throw new AlicatError('EINVALIDARG', 'No gain to write: set P, D and/or I');
                    }
                    const gains = await device.writePid(wanted, { owner });
                    msg.payload = gains;
                    msg.alicat = ctx.info({ outcome: gains.outcome });
                    status.ready(`P${gains.p} D${gains.d} I${gains.i}`);
                } else {
                    const gains = await device.readPid({ owner });
                    msg.payload = gains;
                    msg.alicat = ctx.info();
                    status.ready(`P${gains.p} D${gains.d} I${gains.i}`);
                }
                send(msg);
            });
        }
    });
};
