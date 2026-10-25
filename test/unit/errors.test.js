'use strict';

const assert = require('node:assert/strict');
const { AlicatError, CODES, isAlicatError, codeOf, errorSummary, isModbusException, failedWriteOutcome, withOutcome } = require('../../lib/errors');

describe('errors', () => {
    it('sets code as an own enumerable property and a default message', () => {
        const err = new AlicatError('ETIMEDOUT');
        assert.equal(err.code, 'ETIMEDOUT');
        assert.ok(Object.keys(err).includes('code'));
        assert.equal(err.message, CODES.ETIMEDOUT);
        assert.equal(err.name, 'AlicatError');
        assert.ok(err instanceof Error);
    });

    it('keeps the OS error in cause and copies the details given, and only those', () => {
        const os = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
        const err = new AlicatError('ENOTCONNECTED', 'refused', { cause: os, nextRetryInMs: 3 });
        assert.equal(err.cause, os);
        assert.equal(err.nextRetryInMs, 3);
        assert.deepEqual(Object.keys(err).sort(), ['code', 'name', 'nextRetryInMs']);
        const json = err.toJSON();
        assert.equal(json.code, 'ENOTCONNECTED');
        assert.deepEqual(json.cause, { name: 'Error', message: 'connect ECONNREFUSED', code: 'ECONNREFUSED' });
    });

    it('rejects codes outside the closed set', () => {
        assert.throws(() => new AlicatError(/** @type {any} */ ('ECONNREFUSED')), TypeError);
    });

    it('isAlicatError matches by class and optionally by code', () => {
        const err = new AlicatError('EMODBUS');
        assert.equal(isAlicatError(err), true);
        assert.equal(isAlicatError(err, 'EMODBUS'), true);
        assert.equal(isAlicatError(err, 'ETIMEDOUT'), false);
        assert.equal(isAlicatError(new Error('x')), false);
    });

    it('details never replace the code, name, message or stack, and unknown keys are ignored', () => {
        const untyped = /** @type {any} */ ({ code: 'EOTHER', name: 'X', message: 'other', stack: 's', attempt: 3, status: 3 });
        const err = new AlicatError('ECOMMAND', 'rejected', untyped);
        assert.equal(err.code, 'ECOMMAND');
        assert.equal(err.name, 'AlicatError');
        assert.equal(err.message, 'rejected');
        assert.notEqual(err.stack, 's');
        assert.equal(err.status, 3);
        assert.equal(Object.hasOwn(err, 'attempt'), false);
    });

    it('reads the code of anything thrown, and recognises a given Modbus exception', () => {
        assert.equal(codeOf(new AlicatError('ETIMEDOUT')), 'ETIMEDOUT');
        assert.equal(codeOf(Object.assign(new Error('x'), { code: 'ECONNRESET' })), 'ECONNRESET');
        for (const value of [new Error('x'), null, undefined, 'ETIMEDOUT', { code: 7 }]) {
            assert.equal(codeOf(value), undefined);
        }
        assert.deepEqual(errorSummary(new AlicatError('ETIMEDOUT', 'slow')), { code: 'ETIMEDOUT', message: 'slow' });
        assert.deepEqual(errorSummary(new Error('plain')), { code: 'ERROR', message: 'plain' });
        assert.deepEqual(errorSummary('text'), { code: 'ERROR', message: 'text' });
        const busy = new AlicatError('EMODBUS', 'busy', { exceptionCode: 6 });
        assert.equal(isModbusException(busy, 6), true);
        assert.equal(isModbusException(busy, 2), false);
        assert.equal(isModbusException(new AlicatError('ETIMEDOUT'), 6), false);
        assert.equal(isModbusException(null, 6), false);
    });

    it('says whether a failed write may have reached the device', () => {
        for (const code of /** @type {const} */ (['ENOTCONNECTED', 'EQUEUETIMEOUT', 'EQUEUEFULL'])) {
            assert.equal(failedWriteOutcome(new AlicatError(code)), 'not-sent', code);
        }
        for (const code of /** @type {const} */ (['ETIMEDOUT', 'ELINKDOWN', 'EMODBUS'])) {
            assert.equal(failedWriteOutcome(new AlicatError(code)), 'unknown', code);
        }
        assert.equal(failedWriteOutcome(new Error('x')), 'unknown');
    });

    it('withOutcome adds an outcome only when there is none', () => {
        const err = new AlicatError('ETIMEDOUT');
        assert.equal(withOutcome(err, 'unknown'), err);
        assert.equal(err.outcome, 'unknown');
        withOutcome(err, 'not-sent');
        assert.equal(err.outcome, 'unknown', 'kept');
        const plain = new Error('x');
        assert.equal(/** @type {any} */ (withOutcome(plain, 'unknown')).outcome, undefined, 'only AlicatErrors are tagged');
    });
});
