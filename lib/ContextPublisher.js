'use strict';

const { AlicatError } = require('./errors');

const CLAIMS_KEY = Symbol.for('alicat-modbus.context-claims.v1');

/** @returns {Map<string, string>} key → owner */
function claims() {
    const g = /** @type {{[CLAIMS_KEY]?: Map<string, string>}} */ (globalThis);
    if (!g[CLAIMS_KEY]) g[CLAIMS_KEY] = new Map();
    return g[CLAIMS_KEY];
}

/**
 * Publishes one atomic, frozen snapshot per device into Node-RED context,
 * for existing flows that read globals:
 * - one writer per key (a second publisher for the same key is refused);
 * - the whole object is replaced, never patched;
 * - quality and timestamp are always included, so readers can check
 *   `quality === 'good' && Date.now() - ts < 3 × interval` before acting.
 */
class ContextPublisher {
    /**
     * @param {{context: {set: (key: string, value: unknown, store?: string) => void}, key: string, scope: 'flow' | 'global',
     *          flowId?: string, store?: string, owner: string}} options `flowId`: the tab, for flow scope (each tab has its own flow context)
     */
    constructor(options) {
        if (!options.key || typeof options.key !== 'string') {
            throw new AlicatError('EINVALIDARG', 'A context key is required');
        }
        this.context = options.context;
        this.key = options.key;
        this.store = options.store || undefined;
        this.owner = options.owner;
        const where = options.scope === 'flow' ? `flow/${options.flowId || ''}` : 'global';
        this._claimKey = `${where}:${options.store || ''}:${options.key}`;
        const holder = claims().get(this._claimKey);
        if (holder && holder !== this.owner) {
            throw new AlicatError('EDUPLICATE', `Context key ${options.scope}.${options.key} is already published by node ${holder}`);
        }
        claims().set(this._claimKey, this.owner);
    }

    /**
     * @param {import('./AlicatDevice').Snapshot} snapshot
     * @param {import('./AlicatDevice').Identity | null} identity
     */
    publish(snapshot, identity) {
        const value = Object.freeze({
            ts: snapshot.ts,
            quality: snapshot.quality,
            values: Object.freeze({ ...snapshot.values }),
            setpoint: snapshot.setpoint,
            controlledVariable: snapshot.controlledVariable,
            gas: Object.freeze({ ...snapshot.gas }),
            status: Object.freeze({
                raw: snapshot.status.raw,
                active: Object.freeze([...snapshot.status.active]),
                flags: Object.freeze({ ...snapshot.status.flags }),
                unknownBits: Object.freeze([...snapshot.status.unknownBits])
            }),
            alarms: snapshot.alarms ? Object.freeze({ ...snapshot.alarms }) : null,
            units: Object.freeze({ ...snapshot.units }),
            generation: snapshot.generation,
            firmware: snapshot.firmware,
            serial: identity ? identity.serial : null
        });
        this.context.set(this.key, value, this.store);
        return value;
    }

    release() {
        if (claims().get(this._claimKey) === this.owner) {
            claims().delete(this._claimKey);
        }
    }
}

module.exports = { ContextPublisher };
