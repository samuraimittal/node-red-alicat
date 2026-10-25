'use strict';

// What the architecture diagram shows (development tool, not shipped): the zones,
// one entry per source file with its role, and the storyboards. The require arrows
// come from the code; `npm run diagram` rebuilds docs/diagrams/ from this file, and
// test/unit/architecture-diagram.test.js fails when the two drift apart.
//
// A new file needs an entry in `files` (and a cell in its zone's `rows`). Per file,
// `incoming` says how requires of it are drawn: arrows (default), `listed` in the
// requiring file's box, or arrows only from the files named.

/** @import {Spec} from './layout' */

const locales = (/** @type {string} */ type) => [`nodes/${type}.html`, `nodes/locales/en-US/${type}.json`, `nodes/locales/en-US/${type}.html`];
const FROM_DEVICE_NODE = ['lib/node-red/device-node.js'];

/** @type {Spec} */
module.exports = {
    style: { roughness: 0 },

    zones: [
        // 1 · Module map
        { id: 'editor', title: 'Editor (browser)', colour: 'violet', note: 'Plain scripts the Node-RED editor loads from resources/: one dialog each. Texts and help come from nodes/locales/en-US/.',
            rows: [
                ['resources/alicat-editor.js', 'resources/alicat-device.js', 'resources/alicat-read.js', 'resources/alicat-setpoint.js'],
                ['resources/alicat-command.js', 'resources/alicat-pid.js', 'resources/alicat-status.js', 'resources/alicat-control.js']
            ] },
        { id: 'nodes', title: 'Node-RED nodes (runtime)', colour: 'blue', note: 'One file per node type. All but the config node are built by defineDeviceNode().',
            rows: [['nodes/alicat-device.js', 'nodes/alicat-read.js', 'nodes/alicat-setpoint.js', 'nodes/alicat-command.js', 'nodes/alicat-pid.js', 'nodes/alicat-status.js', 'nodes/alicat-control.js']] },
        { id: 'glue', title: 'lib/node-red/: node scaffolding', colour: 'cyan', note: 'Shared by the nodes: settings checks, the input pipeline, msg.alicat, status dots, editor endpoints.',
            rows: [
                ['', 'lib/node-red/device-node.js', '', 'lib/node-red/admin-api.js'],
                ['lib/node-red/status.js', 'lib/node-red/settings.js', 'lib/node-red/props.js', 'lib/node-red/message.js']
            ] },
        { id: 'helpers', title: 'Node helpers', colour: 'teal', note: 'Plain Node.js, each used by one node.',
            rows: [['lib/ContextPublisher.js', 'lib/Reconciler.js']] },
        { id: 'registry', title: 'Connections', colour: 'green', note: 'Shared by every node using an instrument.',
            rows: [[''], ['lib/ConnectionRegistry.js']] },
        { id: 'device', title: 'AlicatDevice and lib/device/', colour: 'green', note: 'One instrument on a connection. AlicatDevice owns the state and the API; lib/device/ does the work (pure functions, or through a DeviceHost object).',
            rows: [
                ['lib/device/identify.js', 'lib/device/live.js', 'lib/device/poller.js'],
                ['', 'lib/AlicatDevice.js', ''],
                ['lib/device/options.js', 'lib/device/setpoint.js', 'lib/device/commands.js']
            ] },
        { id: 'lane', title: 'CommandLane and lib/lane/', colour: 'green', note: 'Commands, one at a time.',
            rows: [['lib/lane/session.js'], ['lib/CommandLane.js'], ['lib/lane/interface.js']] },
        { id: 'client', title: 'AlicatClient', colour: 'yellow', note: 'One supervised connection per instrument.',
            rows: [['lib/AlicatClient.js', ''], ['lib/PriorityQueue.js', 'lib/Backoff.js']] },
        { id: 'transport', title: 'lib/modbus/', colour: 'orange', note: 'Modbus TCP, FC04 and FC16 only.',
            rows: [['lib/modbus/ModbusTcpTransport.js', ''], ['lib/modbus/pdu.js', 'lib/modbus/exceptions.js']] },
        { id: 'instrument', title: 'On the wire', colour: 'red',
            boxes: [{ id: 'instrument', title: 'Alicat instrument', outside: true,
                text: 'Gen-2 (firmware 10v07 and later, e.g. 10v20) or Gen-1 (e.g. 9v07) flow or pressure controller. In tests and npm run dev: tools/sim/AlicatSimulator.js.' }],
            rows: [['instrument']] },
        { id: 'alicat', title: 'lib/alicat/: the instrument as data', colour: 'grey', note: 'Registers, codecs, commands and tables from the Alicat manual. Pure, no I/O.', columns: 4 },
        { id: 'shared', title: 'Shared', colour: 'grey', note: 'Errors, small utilities, typedef-only modules.', columns: 2 },

        // 7 · Tests, simulator and tools
        { id: 'cli', title: 'Command-line tools (published)', colour: 'pink', note: 'Bins of the package, and npm run dev.',
            rows: [['tools/alicat-sim.js', 'tools/dev.js', 'tools/alicat-probe.js', 'tools/cli.js']] },
        { id: 'devtools', title: 'Repository checks (not published)', colour: 'grey', note: 'Run by npm run check and npm run diagram.',
            rows: [
                ['tools/check-pack.js', 'tools/architecture-diagram.js', '', 'tools/require-graph.js'],
                ['tools/diagram/spec.js', 'tools/diagram/excalidraw.js', 'tools/diagram/layout.js', 'tools/diagram/svg.js']
            ] },
        { id: 'sim', title: 'Simulator (tools/sim/)', colour: 'pink', note: 'A Modbus TCP Alicat with the measured command behaviour and injectable faults.',
            rows: [
                ['', '', 'tools/sim/AlicatSimulator.js'],
                ['tools/sim/DeviceModel.js', 'tools/sim/CommandEngine.js', 'tools/sim/ModbusTcpServer.js', 'tools/sim/profiles/gen2.js', 'tools/sim/profiles/gen1.js'],
                ['', '', '', 'tools/sim/RegisterBank.js']
            ] },
        { id: 'suites', title: 'Test suites (test/)', colour: 'grey', note: 'npm test runs unit, integration and nodes; the others have their own scripts.',
            boxes: [
                { id: 'integration', title: 'test/integration', text: 'Real TCP against the simulator: transport, client, registry, device, lane (exact write sequences), reconciler, probe CLI.' },
                { id: 'unit', title: 'test/unit', text: 'Pure modules, fake transports and fake timers: codecs, queue, client state machine, identification, node helpers, typing guards, this diagram.' },
                { id: 'nodes', title: 'test/nodes', text: 'Every node and option in a Node-RED runtime (node-red-node-test-helper): redeploy, stop, example flows, editor definitions.' },
                { id: 'helpers', title: 'test/helpers', text: 'wait, assert, device and node setup, a fake transport, a scripted raw Modbus server.' },
                { id: 'compat', title: 'test/compat', text: 'Smoke test with only Node-RED installed: Node 18 with Node-RED 4.0 and 4.1, and the packed tarball.' },
                { id: 'hil', title: 'test/hil', text: 'Real instruments, opt-in (ALICAT_HIL_HOST); writes only with ALICAT_HIL_WRITE=1.' },
                { id: 'soak', title: 'test/soak', text: '24 h: embedded Node-RED, 20 simulators plus real units read-only, scheduled faults and redeploys; checks recovery and leaks.' }
            ],
            rows: [['integration', 'unit'], ['nodes', 'helpers'], ['compat', 'hil'], ['soak', '']] }
    ],

    files: {
        // Editor
        'resources/alicat-editor.js': { zone: 'editor', role: 'window.AlicatEditor, shared by every dialog: a copy of the BOUNDS table, range validators, the context-store list.' },
        'resources/alicat-device.js': { zone: 'editor', role: 'Config dialog: address, unit ID, timings, Gen-1 layout. Test connection posts to /alicat-modbus/probe.',
            also: [...locales('alicat-device'), 'resources/alicat-device.css'] },
        'resources/alicat-read.js': { zone: 'editor', role: 'Read dialog: interval or input trigger, dataset, output, change filter, context publishing.', also: locales('alicat-read') },
        'resources/alicat-setpoint.js': { zone: 'editor', role: 'Setpoint dialog: TypedInput value; a control variable shows the mode-switch options.', also: locales('alicat-setpoint') },
        'resources/alicat-command.js': { zone: 'editor', role: 'Command dialog: a named command or raw {id, arg}; the choice shows its argument rows.', also: locales('alicat-command') },
        'resources/alicat-pid.js': { zone: 'editor', role: 'PID dialog: read gains, write P, D and I, or set the loop algorithm.', also: locales('alicat-pid') },
        'resources/alicat-status.js': { zone: 'editor', role: 'Status dialog: the device and the periodic-stats interval.', also: locales('alicat-status') },
        'resources/alicat-control.js': { zone: 'editor', role: 'Control dialog: interval, tolerance, correction delay, attempts, external-change policy.', also: locales('alicat-control') },

        // Nodes
        'nodes/alicat-device.js': { zone: 'nodes', role: 'Config node: one instrument (host, port, unit ID, settings). Hooks the registry to RED.events; takes the lease on first use.' },
        'nodes/alicat-read.js': { zone: 'nodes', role: 'Live values: subscribes on an interval or reads on input; optional change filter; can publish to context.' },
        'nodes/alicat-setpoint.js': { zone: 'nodes', role: 'Writes a setpoint, switching the control variable first if asked; can save it as the power-up value.' },
        'nodes/alicat-command.js': { zone: 'nodes', role: 'Named commands (tare, valve, gas, totalizer reset, display lock) or a raw {id, arg}.' },
        'nodes/alicat-pid.js': { zone: 'nodes', role: 'Reads the PID gains, writes P, D and I with read-back, or sets the loop algorithm.' },
        'nodes/alicat-status.js': { zone: 'nodes', role: 'Sends connection and device state, identity changes and periodic stats; topics reconnect and identify act.' },
        'nodes/alicat-control.js': { zone: 'nodes', role: 'Wraps a Reconciler: msg.payload sets the desired state; its events become messages and the status.' },

        // Node scaffolding
        'lib/node-red/device-node.js': { zone: 'glue', role: 'defineDeviceNode(): settings checked first, lazy lease, owner token, one input pipeline (handleInput), a fixed close order.' },
        'lib/node-red/admin-api.js': { zone: 'glue', role: 'Editor endpoints: POST /alicat-modbus/probe (Test connection); GET gases and meta for the dropdowns.' },
        'lib/node-red/status.js': { zone: 'glue', incoming: FROM_DEVICE_NODE, role: 'StatusReporter: the only place that turns link and device state into a status dot.' },
        'lib/node-red/settings.js': { zone: 'glue', incoming: FROM_DEVICE_NODE, role: 'The BOUNDS table (mirrored in the editor) and settingsReader, which reports every bad setting at once.' },
        'lib/node-red/props.js': { zone: 'glue', incoming: FROM_DEVICE_NODE, role: 'Evaluates TypedInput properties; parses numbers and unit labels from inputs.' },
        'lib/node-red/message.js': { zone: 'glue', incoming: [...FROM_DEVICE_NODE, 'lib/node-red/admin-api.js'],
            role: 'The msg.alicat contract: {…meta, op, outcome, result}; on failure attachError replaces it with {…meta, op, error}.' },

        // Node helpers
        'lib/ContextPublisher.js': { zone: 'helpers', role: 'Writes each frozen snapshot to flow or global context; one writer per key.' },
        'lib/Reconciler.js': { zone: 'helpers', role: 'Holds the desired variable, valve and setpoint; corrects the device toward them, one at a time; reports drift.' },

        // Connections, device, lane
        'lib/ConnectionRegistry.js': { zone: 'registry', role: 'Process-wide: one {client, device} per host:port, handed out as leases. Parks entries across deploys; one config per address.' },
        'lib/AlicatDevice.js': { zone: 'device', incoming: ['lib/ConnectionRegistry.js'], role: 'One instrument: its state (identity, timers, the lane) and public API. Identifies on every connect.' },
        'lib/device/identify.js': { zone: 'device', role: 'Pure identification over a read() callback: Gen-2 from firmware registers and info blocks, Gen-1 by counting slots.' },
        'lib/device/live.js': { zone: 'device', role: 'Decodes the live block into a frozen Snapshot; builds stale and offline copies of the last good one.' },
        'lib/device/poller.js': { zone: 'device', role: 'LivePoller: one poll loop at the fastest subscriber interval, fanned out; one stale/offline snapshot on failure.' },
        'lib/device/options.js': { zone: 'device', role: 'Device settings: defaults, validation, and which changes force a re-identification.' },
        'lib/device/setpoint.js': { zone: 'device', role: 'Setpoint write with range check, clamping and read-back; the bumpless control-variable switch.' },
        'lib/device/commands.js': { zone: 'device', role: 'Commands over the lane, confirmed by effect: valve by status bits, gas by register, PID by read-back.' },
        'lib/CommandLane.js': { zone: 'lane', role: 'One command at a time per instrument; URGENT valve jobs jump the queue and pre-empt the running one.' },
        'lib/lane/session.js': { zone: 'lane', role: 'LaneSession, one command: wait out a foreign one, NOP and settle, write, poll the echo, map failures.' },
        'lib/lane/interface.js': { zone: 'lane', role: 'EXTENDED (1002+, Gen-2) and LIMITED (1000+, Gen-1) command registers: encode, decode the echo, completion.' },

        // Client and transport
        'lib/AlicatClient.js': { zone: 'client', role: 'State machine, queue pump, one request in flight, 20 ms pacing, heartbeat, link-suspect detection, backoff.' },
        'lib/PriorityQueue.js': { zone: 'client', incoming: ['lib/AlicatClient.js'], role: 'URGENT, CONTROL, POLL: coalescing, latest-wins replace, deadlines, aging, bounded at 200. Exports Priority.' },
        'lib/Backoff.js': { zone: 'client', role: 'Reconnect delay: doubling with equal jitter, capped.' },
        'lib/modbus/ModbusTcpTransport.js': { zone: 'transport', role: 'One single-use socket: MBAP framing, replies matched on transaction ID and function code, per-request timeouts.' },
        'lib/modbus/pdu.js': { zone: 'transport', incoming: 'listed', role: 'FC04 and FC16 PDUs, MBAP frames, and FrameParser for split and merged TCP chunks.' },
        'lib/modbus/exceptions.js': { zone: 'transport', incoming: 'listed', role: 'Modbus exception codes and their names.' },

        // The instrument as data
        'lib/alicat/registers.js': { zone: 'alicat', incoming: 'listed', role: 'Register numbers and block layouts (1-based); toAddress() gives the 0-based PDU address.' },
        'lib/alicat/codec.js': { zone: 'alicat', incoming: 'listed', role: 'Big-endian u16, u32, i32 and float32 decode and encode; NaN and INT32 sentinels; word-order check.' },
        'lib/alicat/commands.js': { zone: 'alicat', incoming: 'listed', role: 'Command catalogue: IDs, arguments, priority, minimum firmware; denied IDs; raw-command checks.' },
        'lib/alicat/statistics.js': { zone: 'alicat', incoming: 'listed', role: 'Statistic codes (manual appendix A); control variables and their loop arguments.' },
        'lib/alicat/status-bits.js': { zone: 'alicat', incoming: 'listed', role: 'Status and alarm bits per generation (hold: bit 8, exhaust: bit 10); isValveState().' },
        'lib/alicat/firmware.js': { zone: 'alicat', incoming: 'listed', role: 'Firmware versions (e.g. 10v20.0): parse, compare, per-feature minimums, plausible Gen-2.' },
        'lib/alicat/units.js': { zone: 'alicat', incoming: 'listed', role: 'Engineering-unit codes (appendix B) and labels with the pressure reference (PSIG).' },
        'lib/alicat/gases.js': { zone: 'alicat', incoming: 'listed', role: 'Gas numbers (appendix D): describe, resolve a number, symbol or name; list for the editor.' },
        'lib/alicat/setpoint.js': { zone: 'alicat', incoming: 'listed', role: 'When a read-back setpoint counts as the one written: float32 rounding, displayed decimals.' },
        'lib/alicat/profiles/modern.js': { zone: 'alicat', incoming: 'listed', role: 'Gen-2: parse the 12-register info blocks, decode the 26-register live block.' },
        'lib/alicat/profiles/legacy.js': { zone: 'alicat', incoming: 'listed', role: 'Gen-1 data frame: slot keys, layout presets, layout from the slot count, live decoding.' },

        // Shared
        'lib/errors.js': { zone: 'shared', incoming: 'listed', role: 'AlicatError: a closed set of codes, structured details, the write outcome; classifying helpers.' },
        'lib/util/timers.js': { zone: 'shared', incoming: 'listed', role: 'unref(), an abortable sleep() and the pollUntil() retry loop.' },
        'lib/util/defaults.js': { zone: 'shared', incoming: 'listed', role: 'withDefaults(): known, defined keys over the defaults.' },
        'lib/util/own.js': { zone: 'shared', incoming: 'listed', role: 'own(): own-property lookups, so a name like "constructor" never resolves.' },
        'lib/device/types.js': { zone: 'shared', incoming: 'listed', role: 'Typedefs only: settings, Identity, Snapshot, results, DeviceHost.' },
        'lib/node-red/types.js': { zone: 'shared', incoming: 'listed', role: 'Typedefs only: the Node-RED runtime API, the config node, DeviceMeta.' },

        // Tools
        'tools/alicat-sim.js': { zone: 'cli', role: 'alicat-sim: one simulator on a port, with a profile and a connection limit.' },
        'tools/dev.js': { zone: 'cli', role: 'npm run dev: three simulators (ports 5020–5022) and Node-RED with this package linked in.' },
        'tools/alicat-probe.js': { zone: 'cli', role: 'alicat-probe: bench CLI over a raw transport: info, read, watch, status, write, command, idle.' },
        'tools/cli.js': { zone: 'cli', incoming: 'listed', role: 'Strict argument parsing for the tools.' },
        'tools/check-pack.js': { zone: 'devtools', role: 'npm run check:pack: what npm pack would publish; every node file and the whole require graph, nothing else.' },
        'tools/architecture-diagram.js': { zone: 'devtools', role: 'npm run diagram: writes docs/diagrams/ (this diagram); --check fails when it is out of date.' },
        'tools/require-graph.js': { zone: 'devtools', incoming: 'listed', role: 'The package\'s relative require graph, shared by the pack check and this diagram.' },
        'tools/diagram/spec.js': { zone: 'devtools', role: 'This diagram\'s content: zones, file roles, storyboards. Edit this, then npm run diagram.' },
        'tools/diagram/layout.js': { zone: 'devtools', role: 'Box sizes from wrapped text, rows lined up per band, arrows between facing sides.' },
        'tools/diagram/excalidraw.js': { zone: 'devtools', role: 'Writes the scene as an .excalidraw file with stable ids and seeds.' },
        'tools/diagram/svg.js': { zone: 'devtools', role: 'Writes each view as an SVG for GitHub and the docs.' },
        'tools/sim/AlicatSimulator.js': { zone: 'sim', role: 'One simulated instrument: model, register map, command engine, server. Profiles 10v20-mfc, 10v20-bench, 9v07-bench.' },
        'tools/sim/DeviceModel.js': { zone: 'sim', role: 'Deterministic first-order process: flow, pressure or valve follows the setpoint; hold and exhaust override.' },
        'tools/sim/CommandEngine.js': { zone: 'sim', role: 'Command registers as measured: ~120 ms cycle, runs only changed writes, writes the echoes; test hooks.' },
        'tools/sim/ModbusTcpServer.js': { zone: 'sim', role: 'Minimal Modbus TCP server (FC04, FC16): connection limit, idle timeout, fault injection.' },
        'tools/sim/profiles/gen2.js': { zone: 'sim', role: 'The 10v20 register map: firmware, serial, standard and optimized blocks, info blocks.' },
        'tools/sim/profiles/gen1.js': { zone: 'sim', role: 'The 9v07 register map: limited commands, write-only setpoint, gas, status, float slots.' },
        'tools/sim/RegisterBank.js': { zone: 'sim', role: 'Sparse 1-based register store: write groups, capture-only and write-only registers; else exception 02.' }
    },

    frames: [
        {
            kind: 'flow',
            id: 'legend',
            title: 'How to read this diagram',
            columnWidth: 260,
            steps: [
                { id: 'editor', at: [0, 0], title: 'Editor (browser)', colour: 'violet', text: 'resources/: dialogs, validators' },
                { id: 'nodes', at: [1, 0], title: 'Node-RED nodes', colour: 'blue', text: 'nodes/*.js' },
                { id: 'glue', at: [2, 0], title: 'Node scaffolding', colour: 'cyan', text: 'lib/node-red/' },
                { id: 'helpers', at: [0, 1], title: 'Node helpers', colour: 'teal', text: 'Reconciler, ContextPublisher' },
                { id: 'device', at: [1, 1], title: 'Device, lane, registry', colour: 'green', text: 'an instrument, its commands' },
                { id: 'client', at: [2, 1], title: 'Connection', colour: 'yellow', text: 'AlicatClient, queue, backoff' },
                { id: 'transport', at: [0, 2], title: 'Modbus TCP', colour: 'orange', text: 'lib/modbus/' },
                { id: 'data', at: [1, 2], title: 'Protocol tables, shared', colour: 'grey', text: 'lib/alicat/, errors, util' },
                { id: 'tools', at: [2, 2], title: 'Simulator, tools', colour: 'pink', text: 'tools/' },
                { id: 'outside', at: [0, 3], title: 'Outside this package', kind: 'outside', text: 'Node-RED, the instrument' },
                { id: 'boxes', at: [0, 4], kind: 'note', title: 'File boxes',
                    text: 'Path, then what the file does.\n+ the non-JS files it stands for.\nuses: shared modules it requires (no arrow).\nused by: who requires it, when that has no arrow.' },
                { id: 'generated', at: [1, 4], kind: 'note', title: 'Generated',
                    text: 'npm run diagram builds this from tools/diagram/spec.js and the code\'s require() calls. Edit the spec, not this file. A unit test fails when the diagram falls behind the code.' },
                { id: 'a1', at: [0, 5], title: 'a.js', text: 'requires b.js' },
                { id: 'b1', at: [2, 5], title: 'b.js', text: '' },
                { id: 'a2', at: [0, 6], title: 'emitter', text: 'emits events' },
                { id: 'b2', at: [2, 6], title: 'listener', text: '' },
                { id: 'a3', at: [0, 7], title: 'step', text: 'in a storyboard' },
                { id: 'b3', at: [2, 7], title: 'next step', text: '' },
                { id: 'a4', at: [0, 8], title: 'step', text: 'when it fails' },
                { id: 'b4', at: [2, 8], title: 'failure', kind: 'failure', text: '' },
                { id: 'a5', at: [0, 9], title: 'test suite', text: 'runs against' },
                { id: 'b5', at: [2, 9], title: 'simulator', colour: 'pink', text: '' }
            ],
            edges: [
                ['a1', 'b1', 'require()', 'require'],
                ['a2', 'b2', 'event names', 'event'],
                ['a3', 'b3', 'request or data', 'flow'],
                ['a4', 'b4', 'failure path', 'failure'],
                ['a5', 'b5', 'drives', 'drives']
            ]
        },
        {
            kind: 'map',
            id: 'module-map',
            title: '1 · Module map: every file in lib/, nodes/ and resources/',
            subtitle: 'From the editor at the top down to the wire. Grey arrows point from a file to a file it requires; dashed purple arrows are events. Shared modules have no arrows: boxes list them under "uses", and they list who uses them.',
            bands: [
                ['editor'],
                ['nodes'],
                ['', 'glue', 'helpers'],
                ['registry', 'device', 'lane'],
                ['client', 'transport', 'instrument'],
                ['alicat', 'shared']
            ],
            links: [
                { from: 'lib/modbus/ModbusTcpTransport.js', to: 'lib/AlicatClient.js', kind: 'event', label: 'down · warning', events: ['down', 'warning'] },
                { from: 'lib/Reconciler.js', to: 'nodes/alicat-control.js', kind: 'event', label: 'event · warning', events: ['event', 'warning'] },
                { from: 'lib/modbus/ModbusTcpTransport.js', to: 'instrument', kind: 'flow', label: 'TCP port 502' }
            ]
        },
        {
            kind: 'flow',
            id: 'read-path',
            title: '2 · Read path: from a poll to msg.alicat',
            subtitle: 'A read node on an interval. Every subscriber of an instrument shares one poll loop; the control node\'s Reconciler subscribes the same way.',
            steps: [
                { id: 'node', at: [0, 0], n: 1, file: 'nodes/alicat-read.js', symbol: 'subscribe · readLive',
                    text: 'Interval trigger: subscribes once, at deploy. Input trigger: every message calls device.readLive() instead.' },
                { id: 'poller', at: [1, 0], n: 2, file: 'lib/device/poller.js', symbol: 'LivePoller · _schedule · _pollOnce',
                    text: 'One loop per instrument at the fastest interval any subscriber asks for (≥ 100 ms); slower ones are served from the same snapshots.' },
                { id: 'device', at: [2, 0], n: 3, file: 'lib/AlicatDevice.js', symbol: 'readLive · buildReadInputRegisters',
                    text: 'FC04 read of the live block (Gen-2: standard readings; Gen-1: the data frame) at POLL priority, coalesced per instrument.' },
                { id: 'queue', at: [3, 0], n: 4, file: 'lib/PriorityQueue.js', symbol: 'push · _pick',
                    text: 'POLL level: identical reads share one request; a poll waiting over 3 s goes next; at most 200 queued.' },
                { id: 'client', at: [3, 1], n: 5, file: 'lib/AlicatClient.js', symbol: 'request · _pump · _dispatch',
                    text: 'One request in flight, at least 20 ms apart, 1 s timeout. Offline (BACKOFF): polls are dropped.' },
                { id: 'transport', at: [2, 1], n: 6, file: 'lib/modbus/ModbusTcpTransport.js', symbol: 'send · _onFrame',
                    text: 'MBAP frame with a 16-bit transaction ID; the reply is matched on ID and function code; a late reply gets 250 ms.' },
                { id: 'instrument', at: [1, 1], kind: 'outside', title: 'Instrument or simulator',
                    text: 'Answers with the registers, or exception 02 if the block isn\'t there (then the device re-identifies).' },
                { id: 'decode', at: [1, 2], n: 7, file: 'lib/device/live.js', symbol: 'decodeSnapshot · freezeSnapshot',
                    text: 'Words to engineering values, units, status bits and alarms; a frozen Snapshot with quality good and rttMs.' },
                { id: 'deliver', at: [2, 2], n: 8, file: 'lib/device/poller.js', symbol: '_deliver',
                    text: 'Hands the snapshot to each subscriber whose interval is due.' },
                { id: 'message', at: [3, 2], n: 9, file: 'nodes/alicat-read.js', symbol: 'changed · build · info',
                    text: 'Skips an unchanged value if asked; msg.alicat = {…meta, op, result} (lib/node-red/message.js); send.' },
                { id: 'context', at: [3, 3], n: 10, file: 'lib/ContextPublisher.js', symbol: 'publish',
                    text: 'Optional: after the send, writes the snapshot to flow or global context.' },
                { id: 'failed', at: [2, 3], kind: 'failure', title: 'Read failed', file: 'lib/device/poller.js', symbol: 'deliverQuality',
                    text: 'Timeout or link down: each subscriber gets one stale (or offline) snapshot, not a stream of errors.' }
            ],
            edges: [
                ['node', 'poller', 'subscribe'],
                ['poller', 'device', 'every interval'],
                ['device', 'queue', 'FC04, POLL'],
                ['queue', 'client'],
                ['client', 'transport'],
                ['transport', 'instrument', 'TCP'],
                ['instrument', 'decode', 'reply, back up the stack'],
                ['decode', 'deliver', 'Snapshot'],
                ['deliver', 'message'],
                ['message', 'context'],
                ['deliver', 'failed', 'read failed', 'failure']
            ]
        },
        {
            kind: 'flow',
            id: 'setpoint-command',
            title: '3 · Writes: setpoints, commands and urgent valve commands',
            subtitle: 'A setpoint is a register write confirmed by reading it back. A command goes through the lane: one at a time, NOP first, confirmed by the echo registers.',
            steps: [
                { id: 'sp-node', at: [0, 0], n: 1, file: 'nodes/alicat-setpoint.js', symbol: 'setSetpoint',
                    text: 'Evaluates the value; options: control variable, mode switch, out of range, verify, save as power-up.' },
                { id: 'sp-device', at: [1, 0], n: 2, file: 'lib/AlicatDevice.js', symbol: 'setSetpoint · setControlVariable',
                    text: 'Same control variable: write it. Another one: switch mode first.' },
                { id: 'sp-write', at: [2, 0], n: 3, file: 'lib/device/setpoint.js', symbol: 'planTarget · writeSetpoint',
                    text: 'Units and range (EINVALIDARG, or clamp). FC16 float32 to 1010–1011 at CONTROL; a newer setpoint replaces an unsent one (superseded).' },
                { id: 'sp-verify', at: [3, 0], n: 4, file: 'lib/device/setpoint.js', symbol: 'readBack · withinTolerance',
                    text: 'Reads back 1350–1351 (Gen-1: the data-frame slot), up to 4 × 100 ms. verified, and outcome executed, only on a match.' },
                { id: 'switch', at: [1.5, 1], file: 'lib/device/setpoint.js', symbol: 'switchControlVariable', title: 'Mode switch (bumpless)',
                    text: 'Hold the valve where it is, set the loop variable (command 43, or 11 before 10v19), confirm, write the setpoint, resume. An urgent valve command meanwhile wins.' },
                { id: 'cmd-node', at: [0, 2], n: 1, file: 'nodes/alicat-command.js', symbol: 'HANDLERS',
                    text: 'tare · valve · gas · totalizer reset · display lock · raw {id, arg}. The PID node works the same way.' },
                { id: 'cmd-device', at: [1, 2], n: 2, file: 'lib/device/commands.js', symbol: 'runCommand · selectGas · tare',
                    text: 'Builds the lane job; afterwards confirms the effect where it can (gas register, status bits, PID read-back).' },
                { id: 'lane', at: [2, 2], n: 3, file: 'lib/CommandLane.js', symbol: 'run · _drain · _interface',
                    text: 'One command at a time, 8 queued, 10 s deadline each. Interface: EXTENDED 1002–1009 (Gen-2) or LIMITED 1000–1001 (Gen-1).' },
                { id: 'settle', at: [3, 2], n: 4, file: 'lib/lane/session.js', symbol: 'waitOutForeign · nopAndSettle',
                    text: 'Read the echo; another command running? CONTROL waits. Write a NOP and settle: the device only runs a command that differs from the last write.' },
                { id: 'send', at: [3, 3], n: 5, file: 'lib/lane/session.js', symbol: 'send · awaitCompletion',
                    text: 'Write ID and argument in one FC16 frame (≥ 200 ms after the NOP); poll the echo every 100 ms. Not picked up in 1 s: resend once if repeat-safe.' },
                { id: 'outcome', at: [4, 2], file: 'lib/node-red/message.js', symbol: 'alicatInfo · attachError', title: 'Outcome',
                    text: 'executed · rejected (ECOMMAND) · unknown (EPREEMPTED, timeout, another master) · superseded. On failure attachError replaces msg.alicat and done(err) reaches Catch.' },
                { id: 'urgent', at: [1, 3], file: 'lib/device/commands.js', symbol: 'valve · waitForStatus', title: 'Urgent: valve hold, exhaust, resume', colour: 'red',
                    text: 'Skips the lane queue and interrupts the polling of a running command (EPREEMPTED). Confirmed by status bit 8 or 10; queuedBehind when the device was busy.' }
            ],
            edges: [
                ['sp-node', 'sp-device'],
                ['sp-device', 'sp-write', 'same variable'],
                ['sp-write', 'sp-verify', 'written'],
                ['sp-device', 'switch', 'other variable'],
                ['switch', 'sp-write', 'then write'],
                ['switch', 'lane', 'hold · loop variable · resume'],
                ['cmd-node', 'cmd-device'],
                ['cmd-device', 'lane', 'CONTROL job'],
                ['lane', 'settle', 'LaneSession'],
                ['settle', 'send'],
                ['send', 'outcome', 'echo'],
                ['sp-verify', 'outcome', 'read-back'],
                ['cmd-node', 'urgent', 'valve'],
                ['urgent', 'lane', 'URGENT: pre-empts', 'failure']
            ]
        },
        {
            kind: 'flow',
            id: 'lifecycle',
            title: '4 · Connections: deploy, connect, identify, redeploy',
            subtitle: 'Exactly one socket per instrument, whatever the number of nodes, and no reconnect on a redeploy.',
            steps: [
                { id: 'config', at: [0, 0], n: 1, file: 'nodes/alicat-device.js', symbol: 'acquire',
                    text: 'Config node. Nothing opens until a node uses it; the first use takes a lease, so an unused config never holds a connection slot.' },
                { id: 'registry', at: [1, 0], n: 2, file: 'lib/ConnectionRegistry.js', symbol: 'acquire · _entryFor · _claim',
                    text: 'One entry {client, device} per host:port, a lease per node instance. Another config for the same IP and port: EDUPLICATE, no socket.' },
                { id: 'start', at: [2, 0], n: 3, file: 'lib/AlicatClient.js', symbol: 'start · _connect', title: 'IDLE → CONNECTING',
                    text: 'Resolves the host, opens a ModbusTcpTransport. Requests wait within their deadline meanwhile.' },
                { id: 'online', at: [3, 0], file: 'lib/AlicatClient.js', symbol: '_onConnected · _armHeartbeat', title: 'ONLINE', colour: 'yellow',
                    text: 'Heartbeat: reads register 1200 after 5 s idle (instruments drop idle connections after about 20 s).' },
                { id: 'backoff', at: [2.5, 1], file: 'lib/AlicatClient.js', symbol: '_goBackoff · _scheduleRetry', title: 'BACKOFF', kind: 'failure',
                    text: 'Down, or link suspect (3 timeouts in a row and no bytes for 2× the timeout). Writes fail fast (ENOTCONNECTED); retry after 1 s doubling to 30 s.' },
                { id: 'device', at: [4, 0], file: 'lib/AlicatDevice.js', symbol: '_onClientState · identify',
                    text: 'Client ONLINE: identify, on every connect. BACKOFF or CLOSED: subscribers get one offline snapshot.' },
                { id: 'identify', at: [5, 0], file: 'lib/device/identify.js', symbol: 'identifyDevice · identifyGen2 · identifyGen1',
                    text: 'Gen-2: firmware registers 1090–1093 plausible and ≥ 10v07, then the info blocks. Gen-1: exception 02 at 1090, then count the float slots. Never falls through.' },
                { id: 'status', at: [4, 1], file: 'lib/node-red/status.js', symbol: 'StatusReporter · linkStatus',
                    text: 'Every node\'s status dot, from the client and device state and the identity. Under 20 characters; text-only changes at most 2 per second.' },
                { id: 'status-node', at: [5, 1], file: 'nodes/alicat-status.js', symbol: 'onClient · onDevice · onIdentity',
                    text: 'A message on each state or identity change, plus periodic stats.' },
                { id: 'stopping', at: [0, 2], kind: 'outside', title: 'Deploy starts (RED.events)',
                    text: 'flows:stopping: the old nodes close; a released lease parks its entry with the socket still open.' },
                { id: 'takeover', at: [1, 2], file: 'lib/ConnectionRegistry.js', symbol: '_release · _takeOver',
                    text: 'A new node for the same host:port takes over the parked entry: no reconnect, no re-identification.' },
                { id: 'started', at: [2, 2], kind: 'outside', title: 'Deploy done',
                    text: 'flows:started: entries nobody took over are closed. A fallback timer covers a missing event.' },
                { id: 'stop', at: [0, 3], kind: 'outside', title: 'Stop flows or shutdown',
                    text: 'runtime-state stop without a deploy: close at once, freeing the instrument\'s connection slot.' },
                { id: 'closing', at: [1, 3], file: 'lib/AlicatClient.js', symbol: 'stop', title: 'CLOSING → CLOSED', colour: 'yellow',
                    text: 'Queued work is rejected and the socket closed. An acquire meanwhile waits, so sockets never overlap.' },
                { id: 'close-order', at: [2, 3], kind: 'note', file: 'lib/node-red/device-node.js', symbol: 'onClose · cancelOwner', title: 'A node closing',
                    text: 'Its own cleanups (newest first), then status.close(), device.cancelOwner(owner), the lease release, done().' }
            ],
            edges: [
                ['config', 'registry', 'lease'],
                ['registry', 'start', 'new entry'],
                ['start', 'online', 'connected'],
                ['online', 'backoff', 'down', 'failure'],
                ['backoff', 'start', 'retry'],
                ['online', 'device', 'state', 'event'],
                ['device', 'identify', 'identify()'],
                ['device', 'status', 'state · identity', 'event'],
                ['identify', 'status-node', 'identity', 'event'],
                ['stopping', 'takeover', 'same host:port'],
                ['takeover', 'started'],
                ['stop', 'closing']
            ]
        },
        {
            kind: 'flow',
            id: 'control-loop',
            title: '5 · Control loop: alicat-control keeps the instrument at a desired state',
            subtitle: 'The desired state lives in the node instance; it starts empty after a deploy or restart.',
            steps: [
                { id: 'node', at: [0, 0], n: 1, file: 'nodes/alicat-control.js', symbol: 'desiredFrom',
                    text: 'msg.payload {setpoint, variable, valve}, any subset, sets the desired state.' },
                { id: 'set', at: [1, 0], n: 2, file: 'lib/Reconciler.js', symbol: 'set · _merge',
                    text: 'Merges it and subscribes to the device\'s snapshots (the same poll loop as the read node).' },
                { id: 'evaluate', at: [2, 0], n: 3, file: 'lib/Reconciler.js', symbol: '_onSnapshot · _evaluate',
                    text: 'Only fresh, good snapshots count (else: waiting). Checks the variable, then the valve, then the setpoint; a stuck one doesn\'t block the others.' },
                { id: 'tolerance', at: [3, 0], file: 'lib/alicat/setpoint.js', symbol: 'withinTolerance · setpointTolerance',
                    text: 'Against the float32 value of the desired setpoint, within the tolerance set or half the last displayed decimal.' },
                { id: 'correct', at: [2, 1], n: 4, file: 'lib/Reconciler.js', symbol: '_correct',
                    text: 'A mismatch is corrected, spaced 1 s doubling to 10 s. After maxAttempts: failed, then it keeps trying at the slowest rate.' },
                { id: 'device', at: [1, 1], file: 'lib/AlicatDevice.js', symbol: 'setControlVariable · valve · setSetpoint',
                    text: 'The same write paths as the setpoint and command nodes (view 3).' },
                { id: 'drift', at: [3, 1], file: 'lib/Reconciler.js', symbol: '_onDrift', title: 'Changed from outside',
                    text: 'drift, then the policy: revert (default), adopt, or report only.' },
                { id: 'events', at: [2, 2], n: 5, file: 'lib/Reconciler.js', symbol: '_emit',
                    text: 'event: accepted · waiting · correcting · converged · drift · failed · released.' },
                { id: 'out', at: [1, 2], n: 6, file: 'nodes/alicat-control.js', symbol: 'topic',
                    text: 'Each event is a message (topic = the event) and sets the status dot.' }
            ],
            edges: [
                ['node', 'set'],
                ['set', 'evaluate', 'snapshot'],
                ['evaluate', 'tolerance', 'compare'],
                ['evaluate', 'correct', 'mismatch'],
                ['correct', 'device'],
                ['device', 'evaluate', 'next snapshot'],
                ['evaluate', 'drift', 'external change'],
                ['correct', 'events', '', 'event'],
                ['drift', 'events', '', 'event'],
                ['events', 'out', 'event', 'event']
            ]
        },
        {
            kind: 'flow',
            id: 'editor-admin',
            title: '6 · Editor: dialogs, validation and Test connection',
            subtitle: 'The editor runs in the browser and reaches the runtime only through the admin HTTP endpoints.',
            steps: [
                { id: 'editor', at: [0, 0], kind: 'outside', title: 'Node-RED editor',
                    text: 'Loads nodes/alicat-*.html (dialog templates with data-i18n keys), the scripts in resources/, and texts and help from nodes/locales/en-US/.' },
                { id: 'dialog', at: [1, 0], file: 'resources/alicat-read.js', symbol: 'registerType · oneditprepare',
                    text: 'One per node: defaults, labels, rows shown or hidden, TypedInputs.' },
                { id: 'helpers', at: [2, 0], file: 'resources/alicat-editor.js', symbol: 'BOUNDS · range · fillContextStores',
                    text: 'Validators from a copy of the BOUNDS table; the context-store list.' },
                { id: 'bounds', at: [3, 0], file: 'lib/node-red/settings.js', symbol: 'BOUNDS · settingsReader',
                    text: 'The runtime copy: each node checks its settings on deploy. test/nodes/editor-definitions.test.js keeps the copies equal.' },
                { id: 'device-dialog', at: [1, 1], file: 'resources/alicat-device.js', symbol: 'oneditprepare',
                    text: 'Test connection: POST alicat-modbus/probe with the dialog\'s current settings.' },
                { id: 'probe', at: [2, 1], file: 'lib/node-red/admin-api.js', symbol: 'registerAdminApi · runProbe · probePortAllowed',
                    text: 'Permission alicat-device.write; port 502 unless settings.alicatModbus.probePorts; one test per device, two at once.' },
                { id: 'connection', at: [3, 1], file: 'lib/ConnectionRegistry.js', symbol: 'find · acquire',
                    text: 'Reuses the live connection to that host:port, or takes a short lease with probe timings and releases it.' },
                { id: 'result', at: [1, 2], kind: 'outside', title: 'Shown in the dialog',
                    text: 'Generation, firmware, serial number and controlled variable; or the error code and message.' }
            ],
            edges: [
                ['editor', 'dialog', 'loads'],
                ['dialog', 'helpers', 'validators'],
                ['helpers', 'bounds', 'same numbers', 'require'],
                ['editor', 'device-dialog', 'config dialog'],
                ['device-dialog', 'probe', 'POST'],
                ['probe', 'connection'],
                ['probe', 'result', 'JSON']
            ]
        },
        {
            kind: 'map',
            id: 'tests-tools',
            title: '7 · Tests, simulator and tools',
            subtitle: 'The simulator stands in for an instrument in every suite but hil. Arrows to lib/ are listed under "uses".',
            bands: [
                ['cli', 'devtools'],
                ['sim', 'suites']
            ],
            links: [
                { from: 'integration', to: 'zone:sim', kind: 'drives' },
                { from: 'nodes', to: 'zone:sim', kind: 'drives' },
                { from: 'compat', to: 'zone:sim', kind: 'drives' },
                { from: 'soak', to: 'zone:sim', kind: 'drives' }
            ]
        }
    ],

    canvas: [
        ['legend', 'module-map'],
        ['read-path', 'setpoint-command'],
        ['lifecycle', 'control-loop'],
        ['editor-admin', 'tests-tools']
    ]
};
