'use strict';

const assert = require('node:assert/strict');
const gases = require('../../lib/alicat/gases');
const { throwsCode } = require('../helpers/assert');

describe('alicat/gases', () => {
    it('describes known gases, COMPOSER mixes and unknown numbers', () => {
        assert.deepEqual(gases.describeGas(8), { number: 8, symbol: 'N2', name: 'Nitrogen' });
        assert.equal(gases.describeGas(0).symbol, 'Air');
        assert.equal(gases.describeGas(240).symbol, 'Mix 240');
        assert.equal(gases.describeGas(250).name, 'COMPOSER mix 250');
        assert.equal(gases.describeGas(99).symbol, 'Gas 99');
    });

    it('resolves numbers, numeric strings, symbols, names and mixes', () => {
        assert.equal(gases.resolveGas(8), 8);
        assert.equal(gases.resolveGas(' 11 '), 11);
        assert.equal(gases.resolveGas('n2'), 8);
        assert.equal(gases.resolveGas('Nitrogen'), 8);
        assert.equal(gases.resolveGas('carbon dioxide'), 4);
        assert.equal(gases.resolveGas('He-25'), 25);
        assert.equal(gases.resolveGas('mix 240'), 240);
        for (const bad of ['unobtainium', 256, -1, 'mix 10', 1.5]) {
            throwsCode(() => gases.resolveGas(/** @type {any} */ (bad)), 'EINVALIDARG');
        }
    });

    it('lists gases for the editor', () => {
        const list = gases.listGases();
        assert.ok(list.length >= 130);
        assert.deepEqual(list[0], { number: 0, symbol: 'Air', name: 'Air (clean dry)' });
    });
});
