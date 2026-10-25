'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const sinon = require('sinon');
const { StatusReporter, linkStatus, formatValue, shortError, clip } = require('../../lib/node-red/status');
const { AlicatError } = require('../../lib/errors');

/** @param {string} state @param {Record<string, unknown>} [extra] */
function fakeClient(state, extra = {}) {
    const c = /** @type {any} */ (new EventEmitter());
    Object.assign(c, { state, lastError: null, stats: () => ({ attempt: 3 }) }, extra);
    return c;
}
/** @param {string} state @param {unknown} [lastError] */
function fakeDevice(state, lastError = null) {
    const d = /** @type {any} */ (new EventEmitter());
    Object.assign(d, { state, lastError });
    return d;
}

/** linkStatus() for states that must produce a status. @param {Parameters<typeof linkStatus>} args */
function statusOf(...args) {
    const status = linkStatus(...args);
    assert.ok(status, 'expected a status');
    return status;
}

describe('node-red/status', () => {
    it('maps link and device states to dots with short text', () => {
        assert.deepEqual(linkStatus(fakeClient('CONNECTING'), fakeDevice('IDLE')), { fill: 'yellow', shape: 'ring', text: 'connecting' });
        const refused = new AlicatError('ECONNECT', 'x', { cause: Object.assign(new Error('r'), { code: 'ECONNREFUSED' }) });
        assert.deepEqual(linkStatus(fakeClient('BACKOFF', { lastError: refused }), fakeDevice('IDLE')), { fill: 'red', shape: 'ring', text: 'retry 3: refused' });
        assert.deepEqual(statusOf(fakeClient('BACKOFF', { lastError: new AlicatError('EDUPLICATE') }), fakeDevice('IDLE')).text, 'duplicate device');
        assert.deepEqual(linkStatus(fakeClient('CLOSED'), fakeDevice('IDLE')), { fill: 'grey', shape: 'ring', text: 'closed' });
        assert.equal(statusOf(fakeClient('ONLINE'), fakeDevice('IDENTIFYING')).text, 'identifying');
        assert.equal(statusOf(fakeClient('ONLINE'), fakeDevice('FAILED', new Error('set a custom layout (preset extended-7)'))).text, 'set layout');
        assert.equal(statusOf(fakeClient('ONLINE'), fakeDevice('FAILED', new Error('set the device type'))).text, 'set device type');
        assert.equal(statusOf(fakeClient('ONLINE'), fakeDevice('FAILED', new Error('Firmware registers hold junk'))).text, 'unsupported fw');
        assert.equal(statusOf(fakeClient('ONLINE'), fakeDevice('FAILED', new Error('?'))).text, 'not an Alicat?');
        assert.equal(linkStatus(fakeClient('ONLINE'), fakeDevice('READY')), null);
    });

    it('formats values and keeps status text under 20 characters', () => {
        assert.equal(formatValue(12.3456, 'SCCM'), '12.35 SCCM');
        assert.equal(formatValue(0.0001234), '1.23e-4');
        assert.equal(formatValue(null), '—');
        assert.equal(clip('a very long status text indeed'), 'a very long status …');
        assert.ok(clip('a very long status text indeed').length <= 20);
        assert.equal(shortError({ code: 'ETIMEDOUT' }), 'timeout');
        assert.equal(shortError({ code: 'EWHATEVER' }), 'ewhatever');
        assert.equal(shortError(null), 'error');
    });

    it('shows colour changes at once, throttles text-only changes, and stops after close', () => {
        const clock = sinon.useFakeTimers();
        try {
            /** @type {any[]} */
            const shown = [];
            const client = fakeClient('ONLINE');
            const device = fakeDevice('READY');
            const reporter = new StatusReporter({ status: (s) => shown.push(s) }, client, device);
            reporter.ready('1 SCCM');
            reporter.ready('2 SCCM');
            reporter.ready('3 SCCM');
            assert.deepEqual(shown.map((s) => s.text), ['ready'], 'text-only changes inside 500 ms are held back');
            clock.tick(499);
            assert.equal(shown.length, 1, 'still held at 499 ms');
            clock.tick(1);
            assert.deepEqual(shown.map((s) => s.text), ['ready', '3 SCCM'], 'the latest text wins, once, at 500 ms');
            checkLinkAndClose(shown, client, reporter);
        } finally {
            clock.restore();
        }
    });

    /**
     * @param {any[]} shown
     * @param {ReturnType<typeof fakeClient>} client
     * @param {InstanceType<typeof StatusReporter>} reporter
     */
    function checkLinkAndClose(shown, client, reporter) {
        client.state = 'BACKOFF';
        client.emit('state', {});
        assert.equal(shown[shown.length - 1].fill, 'red');
        reporter.warn('ignored while link is down');
        assert.equal(shown[shown.length - 1].fill, 'red');
        reporter.close();
        reporter.raw({ fill: 'green', shape: 'dot', text: 'after close' });
        assert.notEqual(shown[shown.length - 1].text, 'after close');
        assert.equal(client.listenerCount('state'), 0);
    }

    it("keeps a node's own status (e.g. 'not converging') across connection events instead of repainting green", () => {
        /** @type {any[]} */
        const shown = [];
        const client = fakeClient('ONLINE');
        const device = fakeDevice('READY');
        const reporter = new StatusReporter({ status: (s) => shown.push(s) }, client, device);
        reporter.ready('held SP 10');
        reporter.raw({ fill: 'red', shape: 'dot', text: 'not converging' });
        client.state = 'BACKOFF';
        client.emit('state', {});
        client.state = 'ONLINE';
        client.emit('state', {});
        assert.deepEqual(shown[shown.length - 1], { fill: 'red', shape: 'dot', text: 'not converging' });
        reporter.warn('cmd: timeout'); // transient: not restored
        client.emit('state', {});
        assert.equal(shown[shown.length - 1].text, 'not converging');
        reporter.close();
    });
});
