'use strict';

const assert = require('node:assert/strict');
const { withDefaults } = require('../../lib/util/defaults');
const { AlicatDevice, DEFAULTS: DEVICE_DEFAULTS } = require('../../lib/AlicatDevice');
const { AlicatClient, DEFAULTS: CLIENT_DEFAULTS } = require('../../lib/AlicatClient');

describe('util/defaults', () => {
    it('overlays given values, and an undefined value means the default', () => {
        /** @type {Readonly<{a: number, b: string, c: string | null}>} */
        const defaults = Object.freeze({ a: 1, b: 'x', c: null });
        assert.deepEqual(withDefaults(defaults, { a: 2, b: undefined }), { a: 2, b: 'x', c: null });
        assert.deepEqual(withDefaults(defaults, {}), { a: 1, b: 'x', c: null });
        assert.deepEqual(withDefaults(defaults, { c: 'set' }), { a: 1, b: 'x', c: 'set' });
    });

    it('ignores keys the defaults do not have, including inherited ones', () => {
        const update = /** @type {any} */ ({ a: 2, extra: true, constructor: 'no' });
        const result = withDefaults({ a: 1 }, update);
        assert.deepEqual(result, { a: 2 });
        assert.equal(Object.hasOwn(result, 'constructor'), false);
    });

    it('never changes the defaults object', () => {
        const defaults = { a: 1 };
        withDefaults(defaults, { a: 5 });
        assert.deepEqual(defaults, { a: 1 });
    });

    it('a device given an undefined setting uses the default (a spread used to copy the undefined)', () => {
        const client = new AlicatClient({ host: '127.0.0.1' }); // never started: no socket
        const device = new AlicatDevice(client, { mapMode: undefined, refreshMs: undefined, unitId: 3 });
        assert.equal(device.options.mapMode, DEVICE_DEFAULTS.mapMode);
        assert.equal(device.options.refreshMs, DEVICE_DEFAULTS.refreshMs);
        assert.equal(device.unitId, 3);
        assert.equal(Object.hasOwn(device.options, 'unitId'), false, 'unitId is not a setting');
        device.configure({ controlVariable: undefined, minPollMs: 250 });
        assert.equal(device.options.controlVariable, DEVICE_DEFAULTS.controlVariable);
        assert.equal(device.options.minPollMs, 250);
        device.close();
    });

    it('a client keeps its setting when configure() is given undefined', () => {
        const client = new AlicatClient({ host: '127.0.0.1', requestTimeoutMs: 1500 });
        client.configure({ requestTimeoutMs: undefined, retries: 1 });
        assert.equal(client.options.requestTimeoutMs, 1500);
        assert.equal(client.options.retries, 1);
        assert.equal(client.options.connectTimeoutMs, CLIENT_DEFAULTS.connectTimeoutMs);
    });
});
