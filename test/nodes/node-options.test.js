'use strict';

/**
 * Node options and branches the main node tests don't reach: each setting
 * changes what reaches the simulated device, or what the flow gets back.
 */

const assert = require('node:assert/strict');
const { helper, NODES, startDevice, until, collect, cleanup } = require('../helpers/nodes');
const { getRegistry } = require('../../lib/ConnectionRegistry');
const { delay } = require('../helpers/wait');

const CATCH = require('@node-red/nodes/core/common/25-catch.js');

/** Status objects a node has shown so far. @param {import('node-red-node-test-helper').TestNode} node */
const statuses = (node) => node.status.args.map((a) => /** @type {{fill?: string, text?: string}} */ (a[0]));

describe('node options (test helper + simulator)', function () {
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

    /**
     * Load `nodes` with a device config `dev1`, an output helper `out` and a Catch → `caught`.
     * @param {any[]} nodes @param {string} [profile] @param {Record<string, unknown>} [deviceConfig]
     */
    async function load(nodes, profile, deviceConfig) {
        const started = await startDevice(profile, deviceConfig);
        sim = started.sim;
        const ids = nodes.map((n) => n.id);
        await helper.load([...NODES, CATCH], [
            started.device, ...nodes,
            { id: 'out', type: 'helper' },
            { id: 'c1', type: 'catch', scope: ids, wires: [['caught']] },
            { id: 'caught', type: 'helper' }
        ]);
        return { out: collect(helper.getNode('out')), caught: collect(helper.getNode('caught')), device: started.device };
    }

    /** The commands the simulated device ran, without NOPs. */
    const ran = () => /** @type {{id: number, arg: number}[]} */ (sim.engine.log).filter((c) => c.id !== 0).map((c) => [c.id, c.arg]);

    describe('alicat-setpoint', () => {
        it('clamps to the range when asked, and can skip the read-back', async () => {
            const { out } = await load([
                { id: 's1', type: 'alicat-setpoint', device: 'dev1', outOfRange: 'clamp', wires: [['out']] },
                { id: 's2', type: 'alicat-setpoint', device: 'dev1', verify: false, wires: [['out']] }
            ]);
            helper.getNode('s1').receive({ payload: 150 }); // valve drive: −100…100 %
            await until(() => out.length === 1);
            assert.deepEqual([out[0].alicat.result.clamped, out[0].alicat.result.written, out[0].payload], [true, 100, 100]);
            helper.getNode('s2').receive({ payload: 40 });
            await until(() => out.length === 2);
            assert.equal(out[1].alicat.outcome, 'accepted', 'written, but not read back');
            assert.equal(out[1].alicat.result.actual, null);
            assert.equal(out[1].payload, 40, 'the value written');
        });

        it('switches mode directly (no valve hold) and saves the power-up setpoint', async () => {
            const { out } = await load([
                { id: 's1', type: 'alicat-setpoint', device: 'dev1', variable: 'massFlow', switchMode: 'direct', savePowerUp: true, wires: [['out']] }
            ]);
            helper.getNode('s1').receive({ payload: 500 });
            await until(() => out.length === 1, 8000);
            assert.equal(out[0].alicat.controlledVariable, 'massFlow');
            const commands = ran();
            assert.equal(commands.some(([id]) => id === 6), false, 'a direct switch never holds the valve');
            assert.deepEqual(commands[commands.length - 1], [12, 0], 'then saves the setpoint as power-up value');
        });
    });

    describe('alicat-control', () => {
        it('takes a desired state object, and refuses an empty one or a non-number', async () => {
            const { out, caught } = await load([
                { id: 'm1', type: 'alicat-control', device: 'dev1', interval: 100, correctionMs: 100, tolerance: '0.5', wires: [['out']] }
            ]);
            helper.getNode('m1').receive({ payload: { setpoint: 10, valve: 'hold-closed' } });
            await until(() => out.some((m) => m.topic === 'converged'), 8000);
            const converged = out.find((m) => m.topic === 'converged');
            assert.equal(converged.payload.actual.valve, 'holding');
            assert.equal(converged.alicat.op, 'control');
            helper.getNode('m1').receive({ payload: {} });
            helper.getNode('m1').receive({ payload: 'lots' });
            await until(() => caught.length === 2);
            assert.match(caught[0].alicat.error.message, /needs setpoint, variable and\/or valve/);
            assert.match(caught[1].alicat.error.message, /Setpoint must be a number/);
        });
    });

    describe('alicat-device (config)', () => {
        it('logs every frame with Frame trace on', async () => {
            await load([{ id: 'r1', type: 'alicat-read', device: 'dev1', trigger: 'input', wires: [['out']] }], undefined, { trace: true });
            helper.getNode('r1').receive({});
            const dev = helper.getNode('dev1');
            await until(() => dev.log.getCalls().some((c) => /^tx [0-9a-f]+$/.test(String(c.args[0]))));
            assert.ok(dev.log.getCalls().some((c) => /^rx [0-9a-f]+$/.test(String(c.args[0]))));
        });

        it('rejects a custom layout naming an unknown reading', async () => {
            await load([{ id: 'r1', type: 'alicat-read', device: 'dev1', trigger: 'input', wires: [[]] }], '9v07-bench',
                { layout: 'custom', customLayout: 'massFlow, flux' });
            assert.ok(helper.getNode('dev1').error.calledWithMatch(/Unknown reading "flux"/));
            assert.equal(sim.stats.totalConnections, 0, 'an invalid configuration never connects');
        });
    });

    describe('alicat-status', () => {
        it('sends periodic stats, re-identifies on request, and reports a changed instrument', async () => {
            const { out } = await load([{ id: 'st', type: 'alicat-status', device: 'dev1', periodic: 0.2, wires: [['out']] }]);
            await until(() => out.some((m) => m.topic === 'stats'), 3000);
            const stats = out.find((m) => m.topic === 'stats');
            assert.equal(typeof stats.payload.client.sent, 'number');
            assert.equal(stats.alicat.op, 'status');
            const live = /** @type {NonNullable<ReturnType<ReturnType<typeof getRegistry>['find']>>} */ (getRegistry().find('127.0.0.1', sim.port));
            await live.device.ready();
            const identifiesBefore = live.device.listenerCount('identity');
            helper.getNode('st').receive({ topic: 'identify' });
            await until(() => live.device.state === 'READY' && out.filter((m) => m.topic === 'state').length >= 2, 3000);
            assert.equal(live.device.listenerCount('identity'), identifiesBefore, 'no listener left behind');
            // An instrument swapped behind the same address re-identifies as "changed".
            live.device.emit('identity', { identity: /** @type {any} */ (live.device.identity), changed: true });
            await until(() => out.some((m) => m.topic === 'identity'), 2000, 'an identity message');
            const identity = out.find((m) => m.topic === 'identity');
            assert.equal(identity.payload.changed, true);
            assert.equal(identity.payload.identity.generation, 'gen2');
        });
    });

    describe('alicat-pid', () => {
        it('refuses a write with no gain to write', async () => {
            const { caught } = await load([
                { id: 'p1', type: 'alicat-pid', device: 'dev1', action: 'write', pGain: '', dGain: '', iGain: '', wires: [['out']] }
            ]);
            helper.getNode('p1').receive({ payload: { p: 1 } });
            await until(() => caught.length === 1);
            assert.match(caught[0].alicat.error.message, /No gain to write/);
            assert.equal(ran().length, 0);
        });
    });

    describe('alicat-command', () => {
        it('runs a raw {id, arg} from msg.command when allowed, and warns about an unconfirmed result', async () => {
            const { out } = await load([{ id: 'k1', type: 'alicat-command', device: 'dev1', command: 'msg', allowRaw: true, wires: [['out']] }]);
            helper.getNode('k1').receive({ command: { id: 7, arg: 1 } });
            await until(() => out.length === 1, 5000);
            assert.deepEqual([out[0].payload.command, out[0].payload.outcome], ['raw', 'executed']);
            // A device that accepts the hold but never shows it: the result can't be confirmed.
            sim.engine.commandHook = (/** @type {number} */ id) => (id === 6 ? { status: 0, ret: 0 } : undefined);
            helper.getNode('k1').receive({ command: 'holdClosed' });
            await until(() => out.length === 2, 5000);
            assert.equal(out[1].payload.outcome, 'unknown');
            assert.deepEqual(statuses(helper.getNode('k1')).pop(), { fill: 'yellow', shape: 'dot', text: 'hold closed: unknown' });
        });
    });

    describe('alicat-read', () => {
        it('shows "stale data" when reads fail but the link is up', async () => {
            const { out } = await load([{ id: 'r1', type: 'alicat-read', device: 'dev1', trigger: 'interval', interval: 100, wires: [['out']] }]);
            await until(() => statuses(helper.getNode('r1')).some((s) => s.fill === 'green'));
            sim.faults.exceptionCode = 4; // every read answered with a device failure: the link itself is alive
            await until(() => statuses(helper.getNode('r1')).some((s) => s.text === 'stale data'), 5000);
            const stale = out.find((m) => m.alicat.quality === 'stale');
            assert.equal(stale.alicat.error.code, 'EMODBUS');
            sim.faults.exceptionCode = 0;
            await delay(50);
        });
    });
});
