'use strict';

const assert = require('node:assert/strict');
const { own } = require('../../lib/util/own');
const statistics = require('../../lib/alicat/statistics');
const legacy = require('../../lib/alicat/profiles/legacy');
const { shortError } = require('../../lib/node-red/status');

const { throwsCode } = require('../helpers/assert');

const INHERITED = ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf'];

describe('own-key lookups (names from messages and configurations)', () => {
    it('own() returns own properties only', () => {
        const table = Object.freeze({ a: 1, b: 0 });
        assert.equal(own(table, 'a'), 1);
        assert.equal(own(table, 'b'), 0);
        for (const key of [...INHERITED, 'c', '', null, undefined, 5, {}]) {
            assert.equal(own(table, key), undefined, String(key));
        }
    });

    it('control variables, layouts and device types refuse inherited names', () => {
        for (const name of INHERITED) {
            throwsCode(() => statistics.controlVariable(name), 'EINVALIDARG');
            throwsCode(() => legacy.validateLayout(name), 'EINVALIDARG');
            throwsCode(() => legacy.validateLayout([name]), 'EINVALIDARG');
            throwsCode(() => legacy.resolveLayout({ deviceType: name }, 2), 'EINVALIDARG');
        }
    });

    it('status short codes ignore inherited names', () => {
        assert.equal(shortError({ code: 'constructor' }), 'constructor');
        assert.equal(shortError({ code: 'ECONNECT', cause: { code: 'toString' } }), 'no connect');
    });
});
