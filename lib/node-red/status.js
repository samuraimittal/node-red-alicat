'use strict';

/**
 * The one place that turns connection and device state into a Node-RED status
 * dot. Status text stays under 20 characters (Node-RED guideline). Colour or
 * shape changes show at once; text-only changes are throttled to 2 per second,
 * so fast polling can't flood the editor's websocket.
 *
 * @typedef {{fill: 'red' | 'green' | 'yellow' | 'blue' | 'grey', shape: 'dot' | 'ring', text: string}} NodeStatus
 */

const { own } = require('../util/own');
const { codeOf } = require('../errors');

/**
 * @typedef {InstanceType<typeof import('../AlicatClient').AlicatClient>} Client
 * @typedef {InstanceType<typeof import('../AlicatDevice').AlicatDevice>} Device
 * @typedef {{state: string, stats(): {attempt: number}, lastError: Error | null}} LinkView
 * @typedef {{state: string, lastError: Error | null}} DeviceView
 */

const MAX_TEXT = 20;
const THROTTLE_MS = 500;

const SHORT_CODES = Object.freeze({
    ECONNREFUSED: 'refused',
    ETIMEDOUT: 'timeout',
    EHOSTUNREACH: 'unreachable',
    ENETUNREACH: 'no network',
    ECONNRESET: 'reset',
    ENOTFOUND: 'unknown host',
    EDUPLICATE: 'duplicate',
    ELINKDOWN: 'link lost',
    EFRAMING: 'bad frame',
    ECONNECT: 'no connect'
});

/** @param {string} text */
function clip(text) {
    return text.length <= MAX_TEXT ? text : `${text.slice(0, MAX_TEXT - 1)}…`;
}

/** @param {unknown} err */
function shortError(err) {
    if (!err) return 'error';
    const cause = codeOf(/** @type {{cause?: unknown}} */ (err).cause);
    const code = own(SHORT_CODES, cause) ? cause : codeOf(err);
    return own(SHORT_CODES, code) || String(code || 'error').toLowerCase();
}

/** Why identification failed, in a few words. @param {Error | null} err */
function identifyHint(err) {
    const m = err ? err.message : '';
    if (/layout|slots/i.test(m)) return 'set layout';
    if (/device type/i.test(m)) return 'set device type';
    if (/unit id/i.test(m)) return 'check unit ID';
    if (/firmware/i.test(m)) return 'unsupported fw';
    return 'not an Alicat?';
}

/**
 * Status for the connection/identification layer, or null when the device is
 * ready (the node then shows its own value).
 * @param {LinkView} client
 * @param {DeviceView} device
 * @returns {NodeStatus | null}
 */
function linkStatus(client, device) {
    switch (client.state) {
        case 'IDLE':
        case 'CONNECTING':
            return { fill: 'yellow', shape: 'ring', text: 'connecting' };
        case 'BACKOFF': {
            const err = client.lastError;
            if (codeOf(err) === 'EDUPLICATE') return { fill: 'red', shape: 'dot', text: 'duplicate device' };
            return { fill: 'red', shape: 'ring', text: clip(`retry ${client.stats().attempt}: ${shortError(err)}`) };
        }
        case 'CLOSING':
        case 'CLOSED':
            return { fill: 'grey', shape: 'ring', text: 'closed' };
        default:
            break;
    }
    if (device.state === 'FAILED') return { fill: 'red', shape: 'dot', text: identifyHint(device.lastError) };
    if (device.state === 'CLOSED') return { fill: 'grey', shape: 'ring', text: 'closed' };
    if (device.state !== 'READY') return { fill: 'yellow', shape: 'dot', text: 'identifying' };
    return null;
}

/** Format a reading for status text: 4 significant digits plus units. @param {number | null | undefined} value @param {string} [units] */
function formatValue(value, units = '') {
    if (value === null || value === undefined || !Number.isFinite(value)) return '—';
    const abs = Math.abs(value);
    const text = abs !== 0 && (abs >= 1e5 || abs < 1e-3) ? value.toExponential(2) : String(Number(value.toPrecision(4)));
    return units ? `${text} ${units}` : text;
}

/**
 * Keeps one node's status in sync with its device; nodes add their own
 * "ready" text and transient errors.
 */
class StatusReporter {
    /**
     * @param {{status: (s: import('./types').StatusObject) => void}} node
     * @param {Client} client
     * @param {Device} device
     */
    constructor(node, client, device) {
        this.node = node;
        this.client = client;
        this.device = device;
        /** @type {NodeStatus | null} */
        this._shown = null;
        /** @type {NodeStatus | null} */
        this._pending = null;
        /** @type {NodeJS.Timeout | null} */
        this._timer = null;
        this._lastTextAt = 0;
        /** @type {NodeStatus | null} the node's own lasting status (ready text or raw), restored after link events */
        this._nodeStatus = null;
        this._closed = false;
        this._refresh = () => this.refresh();
        client.on('state', this._refresh);
        device.on('state', this._refresh);
        device.on('identity', this._refresh);
        this.refresh();
    }

    /** Re-evaluate the link state (connection events). */
    refresh() {
        const link = linkStatus(this.client, this.device);
        this._set(link || this._nodeStatus || { fill: 'green', shape: 'dot', text: 'ready' });
    }

    /** Device is ready and working; show this node's value. @param {string} text */
    ready(text) {
        this._nodeStatus = { fill: 'green', shape: 'dot', text: clip(text) };
        if (!linkStatus(this.client, this.device)) this._set(this._nodeStatus);
    }

    /** A single operation failed, but the link is fine. Not restored after link events. @param {string} text */
    warn(text) {
        if (!linkStatus(this.client, this.device)) this._set({ fill: 'yellow', shape: 'dot', text: clip(text) });
    }

    /**
     * A status the node chooses (e.g. "not converging", "released"). It stays, and is
     * restored after link events, until the node shows something else.
     * @param {NodeStatus | {}} status
     */
    raw(status) {
        this._nodeStatus = 'text' in status ? /** @type {NodeStatus} */ (status) : null;
        this._set(/** @type {NodeStatus} */ (status));
    }

    close() {
        this._closed = true;
        if (this._timer) clearTimeout(this._timer);
        this._timer = null;
        this.client.removeListener('state', this._refresh);
        this.device.removeListener('state', this._refresh);
        this.device.removeListener('identity', this._refresh);
    }

    /** @param {NodeStatus} status */
    _set(status) {
        if (this._closed) return;
        const shown = this._shown;
        if (shown && shown.fill === status.fill && shown.shape === status.shape && shown.text === status.text) return;
        const textOnly = shown && shown.fill === status.fill && shown.shape === status.shape;
        const now = Date.now();
        if (textOnly && now - this._lastTextAt < THROTTLE_MS) {
            this._pending = status;
            if (!this._timer) {
                this._timer = setTimeout(() => {
                    this._timer = null;
                    const next = this._pending;
                    this._pending = null;
                    if (next) this._apply(next);
                }, THROTTLE_MS - (now - this._lastTextAt));
            }
            return;
        }
        this._pending = null;
        this._apply(status);
    }

    /** @param {NodeStatus} status */
    _apply(status) {
        if (this._closed) return;
        this._shown = status;
        this._lastTextAt = Date.now();
        this.node.status(status);
    }
}

module.exports = { StatusReporter, linkStatus, formatValue, shortError, clip, MAX_TEXT };
