'use strict';

const assert = require('node:assert/strict');
const { CommandLane } = require('../../lib/CommandLane');
const { AlicatError } = require('../../lib/errors');
const { failure } = require('../helpers/assert');

/**
 * A client whose command echo always reads idle, and whose command write (not
 * the NOP) fails with `error`.
 * @param {Error | null} error
 */
function fakeClient(error) {
    const client = {
        /** @type {number[][]} */
        writes: [],
        readInputRegisters: async () => [0, 0, 0, 0, 0, 0, 0, 0],
        /** @param {number} _unit @param {number} _register @param {number[]} values */
        writeRegisters: async (_unit, _register, values) => {
            client.writes.push(values);
            if (error && values.some((v) => v !== 0)) throw error;
            return {};
        }
    };
    return client;
}

/** @param {ReturnType<typeof fakeClient>} client */
const failingLane = (client) => new CommandLane({
    client: /** @type {any} */ (client), unitId: 1, useExtended: () => true, nopSettleMs: 5, pollIntervalMs: 1, defaultTimeoutMs: 2000
});

/**
 * A device on the extended interface that finishes every command at once
 * with `status` (0 = success), echoing it back.
 * @param {number} [status]
 */
function scriptedClient(status = 0) {
    /** @type {number[]} */
    let echo = [0, 0, 0, 0, 0, 0, 0, 0];
    return {
        /** @type {number[][]} */
        writes: [],
        readInputRegisters: async () => echo,
        /** @param {number} _unit @param {number} _register @param {number[]} values */
        async writeRegisters(_unit, _register, values) {
            this.writes.push(values);
            echo = [...values, 0, status, 0, 0];
            return {};
        }
    };
}

/** @param {ReturnType<typeof scriptedClient>} client */
const scriptedLane = (client) => new CommandLane({
    client: /** @type {any} */ (client), unitId: 1, useExtended: () => true, nopSettleMs: 5, pollIntervalMs: 1, defaultTimeoutMs: 2000
});

describe('CommandLane queue', () => {
    it('sends 0 for an omitted argument, and shows the running command', async () => {
        const lane = scriptedLane(scriptedClient());
        const spec = { id: 7 };
        const running = lane.run(spec);
        assert.equal(lane.activeCommand, spec, 'the same object while it runs');
        const result = await running;
        assert.deepEqual([result.id, result.arg, result.outcome], [7, 0, 'executed']);
        assert.equal(lane.activeCommand, null);
    });

    it('names the argument of a refused command even when it was omitted', async () => {
        const err = await failure(scriptedLane(scriptedClient(2)).run({ id: 999 }));
        assert.deepEqual([err.code, err.command, err.arg, err.statusName], ['ECOMMAND', 999, 0, 'INVALID_ID']);
    });

    it('cancelOwner cancels only that owner\'s queued commands', async () => {
        const lane = scriptedLane(scriptedClient());
        const first = lane.run({ id: 7, arg: 1 });
        const mine = lane.run({ id: 7, arg: 0, owner: 'a' });
        const theirs = lane.run({ id: 7, arg: 1, owner: 'b' });
        lane.cancelOwner('a');
        assert.equal((await failure(mine)).code, 'ECANCELED');
        assert.equal((await first).outcome, 'executed');
        assert.equal((await theirs).outcome, 'executed', 'another owner\'s command still runs');
    });
});

describe('CommandLane outcomes', () => {
    it('a command write that never left the client queue is not-sent', async () => {
        for (const code of /** @type {const} */ (['ENOTCONNECTED', 'EQUEUETIMEOUT', 'EQUEUEFULL'])) {
            const client = fakeClient(new AlicatError(code));
            const err = await failure(failingLane(client).run({ id: 1, arg: 8, label: 'select gas' }));
            assert.equal(err.outcome, 'not-sent', code);
        }
    });

    it('a command write that may have reached the device is unknown', async () => {
        for (const code of /** @type {const} */ (['ETIMEDOUT', 'ELINKDOWN'])) {
            const err = await failure(failingLane(fakeClient(new AlicatError(code))).run({ id: 1, arg: 8 }));
            assert.equal(err.outcome, 'unknown', code);
        }
    });

    it('an argument that cannot be encoded is refused before anything is written', async () => {
        const client = fakeClient(null);
        const err = await failure(failingLane(client).run({ id: 1, arg: 2 ** 33, argType: 'u32' }));
        assert.equal(err.code, 'EINVALIDARG');
        assert.equal(err.outcome, 'not-sent');
        assert.deepEqual(client.writes, []);
    });
});
