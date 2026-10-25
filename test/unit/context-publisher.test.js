'use strict';

const assert = require('node:assert/strict');
const { ContextPublisher } = require('../../lib/ContextPublisher');

describe('ContextPublisher', () => {
    const snapshot = /** @type {any} */ ({
        ts: 1, quality: 'good', values: { massFlow: 1 }, setpoint: 1, controlledVariable: 'massFlow',
        gas: { number: 8, symbol: 'N2', name: 'Nitrogen' }, status: { raw: 0, active: [], flags: { holding: false }, unknownBits: [] },
        alarms: null, units: { massFlow: 'SCCM' }, generation: 'gen2', firmware: '10v20.0'
    });

    it('writes one frozen object, allows one writer per key, and frees the key on release', () => {
        /** @type {Record<string, any>} */
        const store = {};
        const context = { set: (/** @type {string} */ k, /** @type {any} */ v) => { store[k] = v; } };
        const a = new ContextPublisher({ context, scope: 'global', key: 'alicat.s1', owner: 'node-a' });
        const value = a.publish(snapshot, /** @type {any} */ ({ serial: 7 }));
        assert.ok(Object.isFrozen(value) && Object.isFrozen(value.values) && Object.isFrozen(value.status.flags));
        assert.equal(store['alicat.s1'].serial, 7);
        assert.throws(() => new ContextPublisher({ context, scope: 'global', key: 'alicat.s1', owner: 'node-b' }), /already published/);
        assert.doesNotThrow(() => new ContextPublisher({ context, scope: 'flow', key: 'alicat.s1', owner: 'node-b' }).release());
        a.release();
        const b = new ContextPublisher({ context, scope: 'global', key: 'alicat.s1', owner: 'node-b' });
        b.release();
        assert.throws(() => new ContextPublisher({ context, scope: 'global', key: '', owner: 'x' }), /context key is required/);
    });

    it('lets two tabs publish the same flow key (each tab has its own flow context), and keeps unknown status bits', () => {
        const context = { set: () => {} };
        const tab1 = new ContextPublisher({ context, scope: 'flow', flowId: 'tab-1', key: 'alicat.s1', owner: 'node-a' });
        const tab2 = new ContextPublisher({ context, scope: 'flow', flowId: 'tab-2', key: 'alicat.s1', owner: 'node-b' });
        assert.throws(() => new ContextPublisher({ context, scope: 'flow', flowId: 'tab-1', key: 'alicat.s1', owner: 'node-c' }), /already published/);
        const value = tab1.publish({ ...snapshot, status: { ...snapshot.status, unknownBits: [14] } }, null);
        assert.deepEqual(value.status.unknownBits, [14]);
        tab1.release();
        tab2.release();
    });
});
