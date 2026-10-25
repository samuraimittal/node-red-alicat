'use strict';

const assert = require('node:assert/strict');
const { privateHint } = require('../../lib/node-red/admin-api');

describe('admin-api privateHint', () => {
    it('warns about public addresses like the production 172.168.x.x', () => {
        assert.match(/** @type {string} */ (privateHint('172.168.1.191')), /not a private/);
        for (const ok of ['172.16.0.5', '192.168.1.2', '10.0.0.1', '169.254.10.20', '127.0.0.1', 'mfc-01.local', '::1']) {
            assert.equal(privateHint(ok), null, ok);
        }
    });
});
