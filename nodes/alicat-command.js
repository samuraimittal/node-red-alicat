'use strict';

const { defineDeviceNode } = require('../lib/node-red/device-node');
const { propertyValue, toNumber } = require('../lib/node-red/props');
const { AlicatError } = require('../lib/errors');
const { own } = require('../lib/util/own');

/**
 * @typedef {InstanceType<typeof import('../lib/AlicatDevice').AlicatDevice>} Device
 * @typedef {{owner: symbol, fallbackSetpointZero: boolean}} RunOptions
 * @typedef {import('../lib/CommandLane').CommandResult & {effect?: boolean, fallback?: string | null, gas?: {number: number, symbol: string, name: string}}} CommandOutcome
 * @typedef {{label: string, usesArg?: boolean, run: (device: Device, arg: unknown, opts: RunOptions) => Promise<CommandOutcome>}} Handler
 */

/**
 * Named commands → device calls, with a short label for status text.
 * @type {Readonly<Record<string, Handler>>}
 */
const HANDLERS = Object.freeze({
    tareFlow: { label: 'tare flow', run: (d, _a, o) => d.tare('flow', o) },
    tareAbsolutePressure: { label: 'tare abs P', run: (d, _a, o) => d.tare('absolutePressure', o) },
    tareGaugePressure: { label: 'tare gauge P', run: (d, _a, o) => d.tare('gaugePressure', o) },
    resetTotalizer1: { label: 'reset tot 1', run: (d, _a, o) => d.resetTotalizer(1, o) },
    resetTotalizer2: { label: 'reset tot 2', run: (d, _a, o) => d.resetTotalizer(2, o) },
    holdClosed: { label: 'hold closed', run: (d, _a, o) => d.valve('holdClosed', o) },
    holdCurrent: { label: 'hold valve', run: (d, _a, o) => d.valve('holdCurrent', o) },
    exhaust: { label: 'exhaust', run: (d, _a, o) => d.valve('exhaust', o) },
    resume: { label: 'resume', run: (d, _a, o) => d.valve('resume', o) },
    // resolveGas() rejects anything that is not a gas number, symbol or name.
    selectGas: { label: 'gas', usesArg: true, run: (d, a, o) => d.selectGas(/** @type {number | string} */ (a), o) },
    lockDisplay: { label: 'lock display', run: (d, _a, o) => d.displayLock(true, o) },
    unlockDisplay: { label: 'unlock display', run: (d, _a, o) => d.displayLock(false, o) }
});

/** `msg`: msg.command decides; `raw`: the configured command ID and argument. */
const COMMAND_CHOICES = ['msg', 'raw', ...Object.keys(HANDLERS)];

/**
 * The raw command to run: the configured ID and argument (`raw`), or msg.command's `{id, arg}`.
 * @param {unknown} command
 * @param {{rawId: string, rawArg: string}} settings
 */
function rawSpec(command, settings) {
    if (command === 'raw') {
        return { id: toNumber(settings.rawId, 'Command ID'), arg: toNumber(settings.rawArg, 'Argument') };
    }
    const given = /** @type {{id?: unknown, arg?: unknown}} */ (command);
    return { id: toNumber(given.id, 'Command ID'), arg: toNumber(given.arg ?? 0, 'Argument') };
}

/**
 * msg.payload: what ran and how it went.
 * @param {unknown} command @param {CommandOutcome} result
 */
function payloadOf(command, result) {
    return {
        command: typeof command === 'object' ? 'raw' : command,
        outcome: result.outcome,
        returnValue: result.returnValue ?? null,
        durationMs: result.durationMs,
        ...(result.effect !== undefined ? { effect: result.effect } : {}),
        ...(result.queuedBehind ? { queuedBehind: result.queuedBehind } : {}),
        ...(result.fallback ? { fallback: result.fallback } : {}),
        ...(result.gas ? { gas: result.gas } : {})
    };
}

/** @param {import('../lib/node-red/types').NodeRedRuntime} RED */
module.exports = function (RED) {
    defineDeviceNode(RED, {
        type: 'alicat-command',
        op: 'command',
        settings: (read) => ({
            command: read.choice('command', COMMAND_CHOICES, 'tareFlow', 'Command'),
            arg: read.optionalText('arg'),
            argType: read.text('argType', 'msg'),
            allowRaw: read.flag('allowRaw', false),
            rawId: read.text('rawId'),
            rawArg: read.text('rawArg', '0'),
            fallbackSetpointZero: read.flag('fallbackSetpointZero', false)
        }),
        setup(ctx, settings) {
            const { device, owner, status } = ctx;

            ctx.handleInput('cmd', async (msg, send) => {
                const command = settings.command === 'msg' ? msg.command : settings.command;
                /** @type {CommandOutcome} */
                let result;
                let label;
                if (command === 'raw' || (command && typeof command === 'object')) {
                    if (!settings.allowRaw) {
                        throw new AlicatError('EINVALIDARG', 'Raw commands are disabled in this node (enable "Allow raw commands")', { outcome: 'not-sent' });
                    }
                    const spec = rawSpec(command, settings);
                    label = `cmd ${spec.id}`;
                    result = await device.command(spec, undefined, { owner });
                } else {
                    const handler = own(HANDLERS, command);
                    if (!handler) {
                        throw new AlicatError('EINVALIDARG',
                            `Unknown command "${String(command)}". Use one of: ${Object.keys(HANDLERS).join(', ')}`, { outcome: 'not-sent' });
                    }
                    label = handler.label;
                    const arg = handler.usesArg
                        ? await ctx.evaluate(msg, propertyValue(settings.arg, settings.argType, 'Argument'), settings.argType)
                        : undefined;
                    result = await handler.run(device, arg, { owner, fallbackSetpointZero: settings.fallbackSetpointZero });
                }
                msg.payload = payloadOf(command, result);
                msg.alicat = ctx.info({ outcome: result.outcome, result });
                if (result.outcome === 'executed') status.ready(`${label} ✓`);
                else status.warn(`${label}: ${result.outcome}`);
                send(msg);
            });
        }
    });
};
