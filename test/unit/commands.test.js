'use strict';

const assert = require('node:assert/strict');
const commands = require('../../lib/alicat/commands');
const { throwsCode } = require('../helpers/assert');

describe('alicat/commands', () => {
    it('looks up catalog commands and their arguments', () => {
        assert.equal(commands.command('valve').id, 6);
        assert.equal(commands.command('valve').args?.holdClosed, 1);
        assert.equal(commands.command('loopControlVariable').extendedOnly, true);
        throwsCode(() => commands.command('teleport'), 'EINVALIDARG');
    });

    it('blocks dangerous raw commands and validates raw input', () => {
        for (const id of [26, 32765, 32767, 65546]) {
            throwsCode(() => commands.assertRawCommand(id, 0), 'EINVALIDARG');
        }
        throwsCode(() => commands.assertRawCommand(-1, 0), 'EINVALIDARG');
        throwsCode(() => commands.assertRawCommand(5, NaN), 'EINVALIDARG');
        assert.doesNotThrow(() => commands.assertRawCommand(33, 3000));
    });

    it('names command statuses', () => {
        assert.equal(commands.statusName(2), 'INVALID_ID');
        assert.equal(commands.statusName(42), 'STATUS_42');
    });
});
