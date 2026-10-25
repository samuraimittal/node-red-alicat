'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { helper, NODES, until, quiet, cleanup } = require('../helpers/nodes');
const { delay } = require('../helpers/wait');
const { AlicatSimulator } = require('../../tools/sim/AlicatSimulator');

const CORE = [
    require('@node-red/nodes/core/common/20-inject.js'),
    require('@node-red/nodes/core/common/21-debug.js'),
    require('@node-red/nodes/core/common/25-catch.js'),
    require('@node-red/nodes/core/common/60-link.js'),
    require('@node-red/nodes/core/common/90-comment.js'),
    require('@node-red/nodes/core/function/10-function.js'),
    require('@node-red/nodes/core/function/10-switch.js'),
    require('@node-red/nodes/core/function/15-change.js'),
    require('@node-red/nodes/core/sequence/17-split.js')
];

const EXAMPLES_DIR = path.join(__dirname, '..', '..', 'examples');
const FILES = fs.readdirSync(EXAMPLES_DIR).filter((f) => f.endsWith('.json')).sort();
const PACKAGE = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'));

/** Errors a flow is designed to raise (example 02 sends an out-of-range setpoint on purpose). */
const EXPECTED_ERRORS = { '02-setpoint-control.json': 1 };

describe('example flows', function () {
    this.timeout(30000);
    /** @type {InstanceType<typeof AlicatSimulator>[]} */
    let sims = [];

    before((done) => { helper.startServer(done); });
    after((done) => { helper.stopServer(done); });
    afterEach(async () => {
        await cleanup();
        await Promise.all(sims.map((s) => s.stop()));
        sims = [];
    });

    it('there are seven examples and every non-config node type appears in one (Flow Library check N02)', () => {
        assert.equal(FILES.length, 7);
        const used = new Set(FILES.flatMap((f) => JSON.parse(fs.readFileSync(path.join(EXAMPLES_DIR, f), 'utf8')).map((/** @type {any} */ n) => n.type)));
        const types = Object.keys(PACKAGE['node-red'].nodes).filter((t) => t !== 'alicat-device');
        for (const type of types) {
            assert.ok(used.has(type), `${type} is not used in any example`);
        }
    });

    for (const file of FILES) {
        it(`${file} loads, runs every inject, and raises only the errors it is meant to`, async () => {
            const flow = JSON.parse(fs.readFileSync(path.join(EXAMPLES_DIR, file), 'utf8'));
            // Point each device config at its own simulator (examples use 127.0.0.1:5020 / 5021).
            /** @type {Record<string, number>} */
            const ports = {};
            for (const n of flow) {
                if (n.type !== 'alicat-device') continue;
                if (!ports[n.port]) {
                    const sim = await new AlicatSimulator({ profile: '10v20-bench', commandCycleMs: 20, tauMs: 20, maxConnections: 1 }).start();
                    sims.push(sim);
                    ports[n.port] = sim.port;
                }
                n.port = String(ports[n.port]);
            }
            // Import puts positioned nodes on the current tab; do the same here.
            for (const n of flow) {
                if (n.x !== undefined) n.z = 'example-tab';
            }
            await helper.load([...NODES, ...CORE], [{ id: 'example-tab', type: 'tab', label: file }, ...flow]);
            for (const n of flow.filter((/** @type {any} */ x) => x.type !== 'comment')) { // comments are editor-only
                assert.ok(helper.getNode(n.id), `${file}: node ${n.id} (${n.type}) was not created`);
            }
            const alicatNodes = flow.filter((/** @type {any} */ n) => n.type.startsWith('alicat-') && n.type !== 'alicat-device');
            const interval = alicatNodes.filter((/** @type {any} */ n) => n.type === 'alicat-read' && n.trigger === 'interval');
            await until(() => interval.every((/** @type {any} */ n) => helper.getNode(n.id).send.called), 8000);

            for (const inject of flow.filter((/** @type {any} */ n) => n.type === 'inject')) {
                helper.getNode(inject.id).receive({});
                await quiet();
            }
            // A maintain node corrects on its next check (example 07: every 500 ms).
            await delay(600);
            await quiet();

            // The helper's spies are shared per prototype: count each call once, attributed by `this`.
            const spies = new Set(alicatNodes.map((/** @type {any} */ n) => helper.getNode(n.id).error));
            const errors = [...spies].flatMap((/** @type {any} */ spy) => spy.getCalls()
                .filter((/** @type {any} */ c) => c.thisValue && alicatNodes.some((/** @type {any} */ n) => n.id === c.thisValue.id))
                .map((/** @type {any} */ c) => `${c.thisValue.id}: ${c.args[0]}`));
            assert.equal(errors.length, /** @type {Record<string, number>} */ (EXPECTED_ERRORS)[file] || 0, errors.join('\n'));
            for (const sim of sims) {
                assert.ok(sim.stats.peakConnections <= 1, 'one connection per device');
            }
        });
    }
});
