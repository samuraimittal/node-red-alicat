'use strict';

const { defineDeviceNode } = require('../lib/node-red/device-node');
const { BOUNDS } = require('../lib/node-red/settings');
const { errorInfo } = require('../lib/node-red/message');

/** @typedef {import('../lib/AlicatClient').StateChange} StateChange */

/** @param {import('../lib/node-red/types').NodeRedRuntime} RED */
module.exports = function (RED) {
    defineDeviceNode(RED, {
        type: 'alicat-status',
        op: 'status',
        settings: (read) => ({
            periodicMs: read.number('periodic', BOUNDS.status.periodic, 'Periodic stats') * 1000
        }),
        setup(ctx, { periodicMs }) {
            const { node, device, client, status } = ctx;

            const summary = () => {
                const id = device.identity;
                return id ? {
                    generation: id.generation, firmware: id.firmware, serial: id.serial,
                    controlledVariable: id.controlledVariable, readings: id.readings.map((r) => r.key)
                } : null;
            };

            let lastDevice = device.state;

            /** @param {StateChange} [change] client state change; absent when the device state changed */
            const report = (change) => {
                const online = client.state === 'ONLINE' && device.state === 'READY';
                const previousDevice = !change && lastDevice !== device.state ? lastDevice : null;
                lastDevice = device.state;
                node.send({
                    topic: 'state',
                    payload: {
                        state: client.state,
                        device: device.state,
                        online,
                        previous: change ? change.prev : null,
                        previousDevice,
                        error: change && change.error ? errorInfo(change.error)
                            : (device.state === 'FAILED' && device.lastError ? errorInfo(device.lastError) : null),
                        attempt: client.stats().attempt,
                        nextRetryInMs: change ? change.nextRetryInMs : null
                    },
                    alicat: ctx.info({ result: { identity: summary() } })
                });
                if (online) status.ready('online');
            };

            /** @param {StateChange} change */
            const onClient = (change) => report(change);
            const onDevice = () => report();
            /** @param {{changed: boolean}} e */
            const onIdentity = (e) => {
                if (e.changed) {
                    node.send({ topic: 'identity', payload: { changed: true, identity: summary() }, alicat: ctx.info() });
                }
            };
            client.on('state', onClient);
            device.on('state', onDevice);
            device.on('identity', onIdentity);

            const timer = periodicMs > 0
                ? setInterval(() => node.send({ topic: 'stats', payload: { client: client.stats(), device: device.state }, alicat: ctx.info() }), periodicMs)
                : null;
            if (client.state === 'ONLINE' && device.state === 'READY') status.ready('online');
            // Report the current state once at start: after a redeploy the connection is reused and
            // nothing changes, so alarm flows would otherwise not know the state until the next change.
            let closed = false;
            setImmediate(() => { if (!closed) report(); });

            ctx.handleInput(null, (msg, send) => {
                if (msg.topic === 'reconnect') {
                    client.reconnect();
                } else if (msg.topic === 'identify') {
                    device.identify().catch(() => {});
                } else {
                    msg.payload = { client: client.stats(), device: device.state, identity: summary() };
                    msg.alicat = ctx.info();
                    send(msg);
                }
            });

            ctx.onClose(() => {
                closed = true;
                client.removeListener('state', onClient);
                device.removeListener('state', onDevice);
                device.removeListener('identity', onIdentity);
                if (timer) clearInterval(timer);
            });
        }
    });
};
