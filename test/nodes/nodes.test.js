'use strict';

const assert = require('node:assert/strict');
const net = require('net');
const sinon = require('sinon');
const { ContextPublisher } = require('../../lib/ContextPublisher');
const { helper, NODES, startDevice, until, collect, cleanup } = require('../helpers/nodes');
const { getRegistry } = require('../../lib/ConnectionRegistry');
const { Reconciler } = require('../../lib/Reconciler');
const { AlicatDevice } = require('../../lib/AlicatDevice');

const CATCH = require('@node-red/nodes/core/common/25-catch.js');

/**
 * Status objects a node has shown so far.
 * @param {import('node-red-node-test-helper').TestNode} node
 * @returns {{fill?: string, shape?: string, text?: string}[]}
 */
const statuses = (node) => node.status.args.map((a) => a[0]);

describe('Node-RED nodes (test helper + simulator)', function () {
    this.timeout(20000);
    /** @type {any} */
    let sim = null;

    before((done) => { helper.startServer(done); });
    after((done) => { helper.stopServer(done); });
    afterEach(async () => {
        await cleanup();
        if (sim) await sim.stop();
        sim = null;
    });

    /** @param {any[]} nodes @param {string} [profile] @param {Record<string, unknown>} [deviceConfig] */
    async function load(nodes, profile, deviceConfig) {
        const started = await startDevice(profile, deviceConfig);
        sim = started.sim;
        await helper.load([...NODES, CATCH], [started.device, ...nodes]);
        return started.device;
    }

    describe('alicat-device', () => {
        it("logs the connection's warnings on the device configuration node", async () => {
            const device = await load([{ id: 'r1', type: 'alicat-read', device: 'dev1', trigger: 'input', wires: [[]] }]);
            helper.getNode('r1').receive({});
            const live = /** @type {any} */ (getRegistry().find(device.host, Number(device.port)));
            await until(() => Boolean(live && live.client.isOnline));
            live.client.emit('warning', 'Reply from unit 7 to a request for unit 1');
            assert.ok(helper.getNode('dev1').warn.calledWithMatch(/unit 7/));
        });

        it('rejects an invalid configuration and shows it on the node using it', async () => {
            await load([{ id: 'r1', type: 'alicat-read', device: 'dev1', trigger: 'input', wires: [[]] }], undefined, { host: '', port: 70000 });
            const r1 = helper.getNode('r1');
            assert.deepEqual(statuses(r1).pop(), { fill: 'red', shape: 'dot', text: 'invalid config' });
            const dev = helper.getNode('dev1');
            assert.ok(dev.error.calledWithMatch(/host is required; Port must be an integer 1–65535/));
        });

        it('shows "no device" when the config node is missing', async () => {
            await load([{ id: 'r1', type: 'alicat-read', device: 'missing', trigger: 'input', wires: [[]] }]);
            assert.deepEqual(statuses(helper.getNode('r1')).pop(), { fill: 'red', shape: 'ring', text: 'no device' });
        });

        it('a full redeploy (Node-RED deploy path) keeps the same TCP connection', async () => {
            const device = await load([{ id: 'r1', type: 'alicat-read', device: 'dev1', trigger: 'interval', interval: 200, wires: [['h1']] }, { id: 'h1', type: 'helper' }]);
            const first = collect(helper.getNode('h1'));
            await until(() => first.length >= 1);
            // A real deploy: stop (isDeploy) → flows:stopping … runtime-state {stop, deploy: true} → start → flows:started
            await helper.setFlows([device, { id: 'r1', type: 'alicat-read', device: 'dev1', trigger: 'interval', interval: 300, wires: [['h1']] }, { id: 'h1', type: 'helper' }], 'full');
            const second = collect(helper.getNode('h1'));
            await until(() => second.length >= 1);
            assert.equal(sim.stats.totalConnections, 1, 'no reconnect across the deploy');
        });

        it('serves many nodes on one device without a "possible memory leak" warning', async () => {
            /** @type {Error[]} */
            const warnings = [];
            const onWarning = (/** @type {Error} */ w) => { if (w.name === 'MaxListenersExceededWarning') warnings.push(w); };
            process.on('warning', onWarning);
            try {
                const reads = Array.from({ length: 12 }, (_, i) => ({ id: `r${i}`, type: 'alicat-read', device: 'dev1', trigger: 'input', wires: [[]] }));
                await load([...reads, { id: 's1', type: 'alicat-status', device: 'dev1', wires: [[]] }]);
                await until(() => statuses(helper.getNode('r0')).some((s) => s.fill === 'green'));
                await new Promise((r) => setImmediate(r)); // warnings are emitted on the next tick
                assert.deepEqual(warnings.map((w) => w.message), []);
            } finally {
                process.removeListener('warning', onWarning);
            }
        });

        it('Stop flows frees the device connection immediately', async () => {
            await load([{ id: 'r1', type: 'alicat-read', device: 'dev1', trigger: 'interval', interval: 200, wires: [[]] }]);
            await until(() => sim.server.connectionCount === 1);
            await helper.unload(); // runtime-state {stop} without deploy
            await until(() => sim.server.connectionCount === 0, 500);
        });
    });

    describe('every device node (shared behaviour)', () => {
        /** @param {string} id */
        const withCatch = (id) => [{ id: 'c1', type: 'catch', scope: [id], wires: [['h2']] }, { id: 'h2', type: 'helper' }];

        it('fails each message to Catch with EINVALIDARG when no device is selected', async () => {
            await load([{ id: 's1', type: 'alicat-setpoint', device: 'missing', wires: [[]] }, ...withCatch('s1')]);
            const s1 = helper.getNode('s1');
            assert.ok(s1.error.calledWithMatch(/No alicat device is selected/), 'logged once at start');
            const caught = collect(helper.getNode('h2'));
            s1.receive({ payload: 5 });
            await until(() => caught.length === 1);
            assert.deepEqual(caught[0].alicat, {
                op: 'setpoint', error: { code: 'EINVALIDARG', message: 'No alicat device is selected for this node', outcome: 'not-sent' }
            });
        });

        it('refuses an out-of-range interval: invalid config, no connection, and inputs fail', async () => {
            await load([{ id: 'r1', type: 'alicat-read', device: 'dev1', trigger: 'interval', interval: 50, wires: [['h1']] }, { id: 'h1', type: 'helper' }, ...withCatch('r1')]);
            const r1 = helper.getNode('r1');
            assert.deepEqual(statuses(r1).pop(), { fill: 'red', shape: 'dot', text: 'invalid config' });
            assert.ok(r1.error.calledWithMatch(/Interval must be an integer 100–3600000 \(got 50\)/));
            const caught = collect(helper.getNode('h2'));
            r1.receive({});
            await until(() => caught.length === 1);
            assert.equal(caught[0].alicat.error.code, 'EINVALIDARG');
            assert.equal(caught[0].alicat.device, 'Test MFC');
            await new Promise((r) => setTimeout(r, 200));
            assert.equal(sim.stats.totalConnections, 0, 'an invalid node never takes the connection');
        });

        it("a Catch node sees this node's error, not fields an upstream node left in msg.alicat", async () => {
            await load([{ id: 's1', type: 'alicat-setpoint', device: 'dev1', wires: [[]] }, ...withCatch('s1')]);
            const caught = collect(helper.getNode('h2'));
            helper.getNode('s1').receive({ payload: 150, alicat: { quality: 'good', units: { massFlow: 'SCCM' }, outcome: 'executed' } });
            await until(() => caught.length === 1);
            const alicat = caught[0].alicat;
            assert.equal(alicat.op, 'setpoint');
            assert.equal(alicat.error.code, 'EINVALIDARG');
            assert.equal(alicat.error.outcome, 'not-sent');
            for (const stale of ['quality', 'units', 'outcome']) assert.equal(stale in alicat, false, stale);
        });

        it("runs the node's own cleanup before cancelling its requests and releasing the device", async () => {
            const stop = sinon.spy(Reconciler.prototype, 'close');
            const cancel = sinon.spy(AlicatDevice.prototype, 'cancelOwner');
            try {
                await load([{ id: 'k1', type: 'alicat-control', device: 'dev1', wires: [[]] }]);
                await helper.unload();
                assert.ok(stop.calledOnce, 'reconciler closed');
                assert.ok(cancel.calledOnce, 'requests cancelled');
                assert.ok(stop.calledBefore(cancel), 'cleanup first: a closing reconciler cannot queue new work');
            } finally {
                stop.restore();
                cancel.restore();
            }
        });
    });

    describe('alicat-read', () => {
        it('keeps sending readings when publishing to context fails, and warns once', async () => {
            // E.g. Node-RED's file store with its cache off, which throws on a synchronous set.
            const failing = sinon.stub(ContextPublisher.prototype, 'publish')
                .throws(new Error('File Store cache disabled - only asynchronous access supported'));
            try {
                await load([
                    { id: 'r1', type: 'alicat-read', device: 'dev1', trigger: 'interval', interval: 150, contextKey: 'alicat.s1', wires: [['h1']] },
                    { id: 'h1', type: 'helper' }
                ]);
                const r1 = helper.getNode('r1');
                const msgs = collect(helper.getNode('h1'));
                await until(() => msgs.length >= 3);
                const warnings = r1.warn.getCalls().filter((/** @type {any} */ c) => c.thisValue === r1 && /publish to context/.test(String(c.args[0])));
                assert.equal(warnings.length, 1, 'warned once, not on every poll');
                assert.match(String(warnings[0].args[0]), /asynchronous/);
            } finally {
                failing.restore();
            }
        });

        it('applies "only on change" to input-triggered reads too', async () => {
            await load([{ id: 'r2', type: 'alicat-read', device: 'dev1', trigger: 'input', emit: 'change', wires: [['h1']] }, { id: 'h1', type: 'helper' }]);
            const msgs = collect(helper.getNode('h1'));
            helper.getNode('r2').receive({});
            await until(() => msgs.length === 1);
            helper.getNode('r2').receive({});
            await new Promise((r) => setTimeout(r, 400));
            assert.equal(msgs.length, 1, 'the unchanged second reading is not sent');
        });

        it('polls on an interval and sends decoded readings with units and quality', async () => {
            await load([{ id: 'r1', type: 'alicat-read', device: 'dev1', trigger: 'interval', interval: 150, wires: [['h1']] }, { id: 'h1', type: 'helper' }]);
            const msgs = collect(helper.getNode('h1'));
            await until(() => msgs.length >= 2);
            const m = msgs[1];
            assert.equal(m.topic, 'Test MFC');
            assert.equal(typeof m.payload.massFlow, 'number');
            assert.equal(m.alicat.units.massFlow, 'SCCM');
            assert.equal(m.alicat.quality, 'good');
            assert.equal(m.alicat.generation, 'gen2');
            assert.equal(m.alicat.controlledVariable, 'valveDrive');
            await until(() => statuses(helper.getNode('r1')).some((s) => s.fill === 'green'));
        });

        it('reads one value on input, and only reports changes when asked', async () => {
            await load([
                { id: 'r1', type: 'alicat-read', device: 'dev1', trigger: 'input', output: 'value', reading: 'gaugePressure', wires: [['h1']] },
                { id: 'r2', type: 'alicat-read', device: 'dev1', trigger: 'interval', interval: 100, emit: 'change', wires: [['h2']] },
                { id: 'h1', type: 'helper' }, { id: 'h2', type: 'helper' }
            ]);
            sim.model.frozen = true;
            const one = collect(helper.getNode('h1'));
            const changes = collect(helper.getNode('h2'));
            helper.getNode('r1').receive({ payload: 'go' });
            await until(() => one.length === 1);
            assert.equal(one[0].payload, 0);
            assert.equal(one[0].topic, 'gaugePressure');
            await new Promise((r) => setTimeout(r, 600));
            assert.equal(changes.length, 1, 'nothing changed after the first reading');
        });

        it('returns the identity on request', async () => {
            await load([{ id: 'r1', type: 'alicat-read', device: 'dev1', trigger: 'input', dataset: 'identity', wires: [['h1']] }, { id: 'h1', type: 'helper' }]);
            const msgs = collect(helper.getNode('h1'));
            helper.getNode('r1').receive({});
            await until(() => msgs.length === 1);
            assert.equal(msgs[0].payload.firmware, '10v20.0');
            assert.equal(msgs[0].payload.serial, 123456);
        });

        it('publishes a frozen snapshot to global context and refuses a second writer', async () => {
            await load([
                { id: 'r1', type: 'alicat-read', device: 'dev1', trigger: 'interval', interval: 100, contextScope: 'global', contextKey: 'alicat.station1', wires: [[]] },
                { id: 'r2', type: 'alicat-read', device: 'dev1', trigger: 'interval', interval: 100, contextScope: 'global', contextKey: 'alicat.station1', wires: [[]] }
            ]);
            const r1 = helper.getNode('r1');
            await until(() => r1.context().global.get('alicat.station1') !== undefined);
            const snap = /** @type {import('../../lib/AlicatDevice').Snapshot} */ (r1.context().global.get('alicat.station1'));
            assert.equal(snap.quality, 'good');
            assert.ok(Object.isFrozen(snap));
            assert.equal(snap.units.massFlow, 'SCCM');
            assert.ok(helper.getNode('r2').warn.calledWithMatch(/already published/));
        });
    });

    describe('alicat-setpoint', () => {
        const flow = (/** @type {Record<string, unknown>} */ extra = {}) => [
            { id: 's1', type: 'alicat-setpoint', device: 'dev1', value: 'payload', valueType: 'msg', variable: 'current', ...extra, wires: [['h1']] },
            { id: 'h1', type: 'helper' },
            { id: 'c1', type: 'catch', scope: ['s1'], wires: [['h2']] },
            { id: 'h2', type: 'helper' }
        ];

        it('writes a setpoint in the current mode and reports the read-back', async () => {
            await load(flow());
            const out = collect(helper.getNode('h1'));
            helper.getNode('s1').receive({ payload: '50' });
            await until(() => out.length === 1);
            assert.equal(out[0].payload, 50);
            assert.equal(out[0].alicat.op, 'setpoint');
            assert.deepEqual(out[0].alicat.units, { setpoint: '%' });
            assert.equal(out[0].alicat.outcome, 'executed');
            assert.equal(out[0].alicat.result.verified, true);
            assert.equal(out[0].alicat.result.requested, 50);
        });

        it('switches mode from msg.variable', async () => {
            await load(flow({ variable: 'msg' }));
            const out = collect(helper.getNode('h1'));
            helper.getNode('s1').receive({ payload: 500, variable: 'massFlow' });
            await until(() => out.length === 1, 5000);
            assert.equal(out[0].alicat.controlledVariable, 'massFlow');
            assert.deepEqual(out[0].alicat.units, { setpoint: 'SCCM' });
            assert.equal(sim.model.controlVariable, 'massFlow');
        });

        it('routes errors to Catch with msg.alicat.error', async () => {
            await load(flow({ variable: 'msg' }));
            const caught = collect(helper.getNode('h2'));
            helper.getNode('s1').receive({ payload: 150 });
            helper.getNode('s1').receive({ payload: 'abc' });
            helper.getNode('s1').receive({ payload: 1, variable: 'humidity' });
            await until(() => caught.length === 3);
            const byText = (/** @type {RegExp} */ re) => caught.find((m) => re.test(m.alicat.error.message));
            const range = byText(/outside the device range/);
            assert.equal(range.alicat.error.code, 'EINVALIDARG');
            assert.equal(range.alicat.error.outcome, 'not-sent');
            assert.ok(byText(/must be a number/));
            assert.ok(byText(/Unknown control variable/));
        });
    });

    describe('alicat-command', () => {
        const flow = (/** @type {Record<string, unknown>} */ cfg) => [
            { id: 'k1', type: 'alicat-command', device: 'dev1', arg: 'payload', argType: 'msg', ...cfg, wires: [['h1']] },
            { id: 'h1', type: 'helper' },
            { id: 'c1', type: 'catch', scope: ['k1'], wires: [['h2']] },
            { id: 'h2', type: 'helper' }
        ];

        it('holds the valve closed and confirms it from the status bits', async () => {
            await load(flow({ command: 'holdClosed' }));
            const out = collect(helper.getNode('h1'));
            helper.getNode('k1').receive({});
            await until(() => out.length === 1, 5000);
            assert.equal(out[0].payload.outcome, 'executed');
            assert.equal(out[0].payload.effect, true);
            assert.equal(sim.model.hold, 'closed');
            const { op, outcome, result } = out[0].alicat;
            assert.deepEqual({ op, outcome, effect: result.effect, id: result.id }, { op: 'command', outcome: 'executed', effect: true, id: 6 });
        });

        it('selects a gas by name from the payload', async () => {
            await load(flow({ command: 'selectGas' }));
            const out = collect(helper.getNode('h1'));
            helper.getNode('k1').receive({ payload: 'N2' });
            await until(() => out.length === 1, 5000);
            assert.equal(out[0].payload.gas.symbol, 'N2');
        });

        it('takes the command from msg.command, and refuses raw commands unless allowed', async () => {
            await load(flow({ command: 'msg' }));
            const out = collect(helper.getNode('h1'));
            const caught = collect(helper.getNode('h2'));
            helper.getNode('k1').receive({ command: 'tareFlow' });
            await until(() => out.length === 1, 5000);
            assert.equal(out[0].payload.command, 'tareFlow');
            helper.getNode('k1').receive({ command: { id: 20, arg: 0 } });
            helper.getNode('k1').receive({ command: 'teleport' });
            await until(() => caught.length === 2);
            assert.match(caught[0].alicat.error.message, /Raw commands are disabled/);
            assert.match(caught[1].alicat.error.message, /Unknown command/);
            helper.getNode('k1').receive({ command: 'toString' });
            await until(() => caught.length === 3);
            assert.equal(caught[2].alicat.error.code, 'EINVALIDARG', 'an inherited name is an unknown command');
        });

        it('runs a raw command when allowed and reports the device refusal', async () => {
            await load(flow({ command: 'raw', allowRaw: true, rawId: '999', rawArg: '0' }));
            const caught = collect(helper.getNode('h2'));
            helper.getNode('k1').receive({});
            await until(() => caught.length === 1, 5000);
            assert.equal(caught[0].alicat.error.statusName, 'INVALID_ID');
        });
    });

    describe('alicat-pid', () => {
        it('refuses an inherited name as the loop algorithm', async () => {
            await load([
                { id: 'p5', type: 'alicat-pid', device: 'dev1', action: 'algorithm', wires: [[]] },
                { id: 'c5', type: 'catch', scope: ['p5'], wires: [['h5']] },
                { id: 'h5', type: 'helper' }
            ]);
            const caught = collect(helper.getNode('h5'));
            helper.getNode('p5').receive({ algorithm: 'constructor' });
            await until(() => caught.length === 1, 5000);
            assert.equal(caught[0].alicat.error.code, 'EINVALIDARG');
            assert.deepEqual(sim.engine.log.filter((/** @type {any} */ c) => c.id === 13), [], 'no algorithm command was sent');
        });

        it('reads and writes gains', async () => {
            await load([
                { id: 'p1', type: 'alicat-pid', device: 'dev1', action: 'read', wires: [['h1']] },
                { id: 'p2', type: 'alicat-pid', device: 'dev1', action: 'write', pGain: 'payload.p', pGainType: 'msg', dGain: 'payload.d', dGainType: 'msg', iGain: 'payload.i', iGainType: 'msg', wires: [['h1']] },
                { id: 'h1', type: 'helper' }
            ]);
            const out = collect(helper.getNode('h1'));
            helper.getNode('p1').receive({});
            await until(() => out.length === 1, 5000);
            assert.deepEqual(out[0].payload, { p: 5000, d: 0, i: 250 });
            helper.getNode('p2').receive({ payload: { p: 4000 } });
            await until(() => out.length === 2, 8000);
            assert.equal(out[1].payload.p, 4000);
            assert.equal(out[1].payload.outcome, 'executed');
        });

        it('writes gains set as numbers in the editor, leaves a cleared gain unchanged, and defaults to msg.payload', async () => {
            await load([
                // As the editor saves it: P and I typed as numbers, D cleared.
                { id: 'p3', type: 'alicat-pid', device: 'dev1', action: 'write', pGain: '4200', pGainType: 'num', dGain: '', dGainType: 'msg', iGain: '320', iGainType: 'num', wires: [['h1']] },
                // Imported through the Admin API with no gain settings: same as the editor defaults (msg.payload.p/d/i).
                { id: 'p4', type: 'alicat-pid', device: 'dev1', action: 'write', wires: [['h1']] },
                { id: 'h1', type: 'helper' }
            ]);
            const out = collect(helper.getNode('h1'));
            helper.getNode('p3').receive({ payload: { d: 99 } });
            await until(() => out.length === 1, 8000);
            assert.deepEqual([out[0].payload.p, out[0].payload.d, out[0].payload.i], [4200, 0, 320], 'D was cleared, so msg.payload.d is ignored');
            helper.getNode('p4').receive({ payload: { d: 7 } });
            await until(() => out.length === 2, 8000);
            assert.deepEqual([out[1].payload.p, out[1].payload.d, out[1].payload.i], [4200, 7, 320]);
        });
    });

    describe('alicat-status', () => {
        it('reports the current state once after a redeploy that reuses the connection', async () => {
            const device = await load([{ id: 'st', type: 'alicat-status', device: 'dev1', wires: [['h1']] }, { id: 'h1', type: 'helper' }]);
            const first = collect(helper.getNode('h1'));
            await until(() => first.some((m) => m.topic === 'state' && m.payload.online));
            await helper.setFlows([device, { id: 'st', type: 'alicat-status', device: 'dev1', name: 'redeployed', wires: [['h1']] }, { id: 'h1', type: 'helper' }], 'full');
            const second = collect(helper.getNode('h1'));
            await until(() => second.length > 0);
            assert.equal(second[0].topic, 'state');
            assert.equal(second[0].payload.online, true, 'the reused connection is already online');
            assert.equal(sim.stats.totalConnections, 1);
        });

        it('reports state changes, answers stats requests and reconnects on request', async () => {
            await load([{ id: 'st', type: 'alicat-status', device: 'dev1', wires: [['h1']] }, { id: 'h1', type: 'helper' }]);
            const out = collect(helper.getNode('h1'));
            await until(() => out.some((m) => m.topic === 'state' && m.payload.online));
            const online = out.find((m) => m.topic === 'state' && m.payload.online);
            const ready = online.payload;
            assert.equal(ready.previousDevice, 'IDENTIFYING', 'a device change names the device state it left');
            assert.equal(ready.previous, null, 'the connection state did not change');
            assert.equal(online.alicat.op, 'status');
            assert.equal(online.alicat.result.identity.generation, 'gen2');
            const connected = out.find((m) => m.topic === 'state' && m.payload.previous === 'CONNECTING').payload;
            assert.equal(connected.previousDevice, null);
            helper.getNode('st').receive({ topic: 'stats' });
            await until(() => out.some((m) => m.payload && m.payload.client));
            const before = sim.stats.totalConnections;
            helper.getNode('st').receive({ topic: 'reconnect' });
            await until(() => sim.stats.totalConnections === before + 1, 5000);
        });
    });

    describe('alicat-control', () => {
        it('drives the device to a desired state, then releases it', async () => {
            await load([
                { id: 'm1', type: 'alicat-control', device: 'dev1', interval: 100, correctionMs: 100, wires: [['h1']] },
                { id: 'h1', type: 'helper' },
                { id: 'c1', type: 'catch', scope: ['m1'], wires: [['h2']] },
                { id: 'h2', type: 'helper' }
            ]);
            const events = collect(helper.getNode('h1'));
            const caught = collect(helper.getNode('h2'));
            helper.getNode('m1').receive({ payload: { setpoint: 30, valve: 'auto' } });
            await until(() => events.some((e) => e.topic === 'converged'), 8000);
            assert.equal(sim.model.state.setpoint, 30);
            helper.getNode('m1').receive({ topic: 'release' });
            await until(() => events.some((e) => e.topic === 'released'));
            helper.getNode('m1').receive({ payload: true });
            await until(() => caught.length === 1);
            assert.equal(caught[0].alicat.error.code, 'EINVALIDARG');
        });
    });

    describe('admin API', () => {
        it('tests a connection from the editor, reusing a live connection when there is one', async () => {
            /** @type {number[]} */
            const probePorts = []; // settings.js alicatModbus.probePorts; the simulators' ports are added below
            helper.settings({ alicatModbus: { probePorts } });
            const device = await load([]);
            const notAllowed = await helper.request().post('/alicat-modbus/probe').send({ host: '127.0.0.1', port: device.port, unitId: 1 });
            assert.equal(notAllowed.status, 403, 'only port 502 unless settings allow more');
            probePorts.push(Number(device.port));
            for (const body of [{ mapMode: 'fast' }, { deviceType: 'toaster' }, { layout: 'constructor' }]) {
                const invalid = await helper.request().post('/alicat-modbus/probe').send({ host: '127.0.0.1', port: device.port, unitId: 1, ...body });
                assert.equal(invalid.status, 400, JSON.stringify(body));
            }
            const fresh = await helper.request().post('/alicat-modbus/probe').send({ host: '127.0.0.1', port: device.port, unitId: 1 });
            assert.equal(fresh.body.ok, true, JSON.stringify(fresh.body));
            assert.equal(fresh.body.identity.firmware, '10v20.0');
            assert.equal(fresh.body.reused, false);
            await until(() => getRegistry().list().length === 0, 500); // the test's own connection closes now, not after a linger
            await helper.unload();
            await helper.load([...NODES, CATCH], [device, { id: 'r1', type: 'alicat-read', device: 'dev1', trigger: 'interval', interval: 500, wires: [[]] }]);
            await until(() => statuses(helper.getNode('r1')).some((s) => s.fill === 'green'));
            const reused = await helper.request().post('/alicat-modbus/probe').send({ host: '127.0.0.1', port: device.port, unitId: 1 });
            assert.equal(reused.body.reused, true);
            const bad = await helper.request().post('/alicat-modbus/probe').send({ host: '', port: 0 });
            assert.equal(bad.status, 400);
            const closedPort = await new Promise((resolve) => {
                const srv = net.createServer().listen(0, '127.0.0.1', () => {
                    const { port } = /** @type {import('net').AddressInfo} */ (srv.address());
                    srv.close(() => resolve(port));
                });
            });
            probePorts.push(/** @type {number} */ (closedPort));
            const started = Date.now();
            const refused = await helper.request().post('/alicat-modbus/probe').send({ host: '127.0.0.1', port: closedPort, unitId: 1 });
            assert.equal(refused.body.ok, false);
            assert.equal(refused.body.code, 'ECONNECT', 'the real connect error, not a generic "not ready"');
            assert.match(refused.body.message, /ECONNREFUSED/);
            assert.ok(Date.now() - started < 3000, 'fails as soon as the connect fails, not after the 8 s limit');
            const gases = await helper.request().get('/alicat-modbus/gases');
            assert.ok(gases.body.length >= 130);
            const meta = await helper.request().get('/alicat-modbus/meta');
            assert.ok(meta.body.layouts['extended-7']);
            helper.settings({});
        });
    });
});
