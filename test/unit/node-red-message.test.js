'use strict';

const assert = require('node:assert/strict');
const { errorInfo, alicatInfo, attachError } = require('../../lib/node-red/message');
const { AlicatError } = require('../../lib/errors');

describe('node-red/message', () => {
    const META = { device: 'MFC', host: '10.0.0.5', port: 502, unitId: 1, generation: /** @type {const} */ ('gen2'), firmware: '10v20.0', serial: 1 };

    it('replaces msg.alicat with this node\'s metadata and the full error', () => {
        const err = new AlicatError('ECOMMAND', 'rejected', { status: 3, statusName: 'INVALID_ARGUMENT', outcome: 'rejected' });
        const msg = attachError({ alicat: { device: 'upstream', quality: 'good', outcome: 'executed' } }, err, META, 'command');
        assert.deepEqual(msg.alicat, {
            ...META, op: 'command',
            error: { code: 'ECOMMAND', message: 'rejected', outcome: 'rejected', status: 3, statusName: 'INVALID_ARGUMENT' }
        });
        assert.deepEqual(attachError({}, err, null, 'read').alicat, { op: 'read', error: errorInfo(err) });
    });

    it('describes anything thrown', () => {
        assert.deepEqual(errorInfo('plain'), { code: 'ERROR', message: 'plain' });
        assert.deepEqual(errorInfo(Object.assign(new Error('gone'), { code: 'ECONNRESET' })), { code: 'ECONNRESET', message: 'gone' });
        assert.deepEqual(errorInfo(new AlicatError('EMODBUS', 'x', { exceptionCode: 2 })), { code: 'EMODBUS', message: 'x', exceptionCode: 2 });
        assert.deepEqual(errorInfo(null), { code: 'ERROR', message: 'null' });
    });

    it('builds msg.alicat for a successful operation', () => {
        assert.deepEqual(alicatInfo(META, 'setpoint', { outcome: 'executed' }), { ...META, op: 'setpoint', outcome: 'executed' });
        assert.deepEqual(alicatInfo(META, 'status'), { ...META, op: 'status' });
    });

});
