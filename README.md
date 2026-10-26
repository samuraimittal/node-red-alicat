# @samuraimittal/node-red-alicat

[![CI](https://github.com/samuraimittal/node-red-alicat/actions/workflows/ci.yml/badge.svg)](https://github.com/samuraimittal/node-red-alicat/actions/workflows/ci.yml) [![npm](https://img.shields.io/npm/v/@samuraimittal/node-red-alicat)](https://www.npmjs.com/package/@samuraimittal/node-red-alicat) [![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

Node-RED nodes for Alicat Scientific mass flow and pressure controllers over **Modbus TCP**:
- **one supervised connection per instrument**, shared by every node and kept across redeploys;
- a priority queue that puts valve commands ahead of polling;
- readings decoded into engineering units, with a quality flag and a timestamp on every message;
- setpoints in mass-flow, pressure and valve-drive modes, and a node that *maintains* a desired state.

The package has zero runtime dependencies.

> **Status: early release (0.x).** Settings and messages may still change between minor versions; the [CHANGELOG](CHANGELOG.md) lists every change.
> - **Hardware-tested** on a Gen-2 unit (firmware 10v20) and a Gen-1 unit (9v07). Other firmware is covered by the simulator. See [docs/hardware-validation.md](docs/hardware-validation.md).
> - Modbus TCP only for now; Modbus RTU and serial connections are planned.
>
> Not affiliated with or endorsed by Alicat Scientific, Inc.

## Contents

- [Install](#install)
- [Quick start](#quick-start)
- [The nodes](#the-nodes)
- [Compatibility](#compatibility)
- [Status dots](#status-dots)
- [Messages](#messages)
- [Errors](#errors)
- [Deploys, stop and safety](#deploys-stop-and-safety)
- [Troubleshooting](#troubleshooting)
- [Moving away from global variables](#moving-away-from-global-variables)
- [Developing](#developing)

## Install

Requires **Node-RED 4.0 or newer** and **Node.js 18.5 or newer**, as Node-RED 4 does (Node-RED 5 itself needs Node.js 22.9+).

In the Node-RED editor: **Menu → Manage palette → Install**, search for `@samuraimittal/node-red-alicat`. Or from a shell, in your Node-RED user directory (usually `~/.node-red`):

```sh
cd ~/.node-red
npm install @samuraimittal/node-red-alicat
```

Restart Node-RED. The nodes appear in the palette under **Alicat**.

## Quick start

**Without hardware**: the package ships a simulator that behaves like a real 10v20 controller.

```sh
cd ~/.node-red
npx --no -- alicat-sim --port 5020     # a second one for example 05: npx --no -- alicat-sim --port 5021
npx --no -- alicat-sim --list          # other profiles, e.g. --profile 9v07-bench for Gen-1 firmware
```

`--no` makes `npx` use the installed simulator and never download a package of that name.

In Node-RED, use **Menu → Import → Examples → @samuraimittal/node-red-alicat → 01-poll-and-dashboard**, then deploy. The examples point at `127.0.0.1:5020` (and `5021` for the two-station example).

**With an instrument**:
1. Drag an **alicat read** node onto the flow and open it.
2. Next to *Device*, click the pencil to add a device. Enter the instrument's IP address and keep port 502.
3. Click **Test connection**. It shows the firmware, what the setpoint controls, and live readings.
4. Deploy. The node's status shows the live mass flow, for example `12.47 SLPM`.

For firmware before 10v07 (Gen-1), also pick the **data frame** layout in the device settings. `extended-7` matches the common 7-slot frame (absolute, gauge and barometric pressure, temperature, volumetric flow, mass flow, setpoint).

## The nodes

| Node | What it does |
|---|---|
| **alicat device** (config) | One instrument: address, port, unit ID, and for Gen-1 firmware the data-frame layout, controlled variable and unit labels. *Advanced*: timeouts, request gap, heartbeat, retry limit, frame trace. |
| **alicat read** | Live readings on an interval or on input, as one object or a single number. Optionally publishes a frozen snapshot to flow/global context. |
| **alicat setpoint** | Writes a setpoint and confirms it by reading it back. Can switch what the setpoint controls (mass flow, volumetric flow, absolute/gauge/differential pressure, valve drive) without a jump. |
| **alicat command** | Tare, totalizer reset, valve hold closed / hold current / exhaust / resume, gas select, front-panel lock. Each command is confirmed by the device. |
| **alicat PID** | Reads or writes the control-loop gains, or sets the loop algorithm. |
| **alicat status** | Connection and device state for alarms and dashboards; an input can force a reconnect. |
| **alicat control** | Keeps the instrument at a desired setpoint, mode and valve state, and corrects drift. Never acts on stale data. |

Every node has full help in the editor's help panel. The [examples](examples/) cover each node:

| Example | Shows |
|---|---|
| 01-poll-and-dashboard | Polling, single readings, identity, status |
| 02-setpoint-control | Setpoints, mode switching, an out-of-range value going to Catch |
| 03-tare-totalizer-gas | Tare, totalizer reset, gas by name or number |
| 04-pid-read-write | PID read, write with read-back, loop algorithm |
| 05-multi-station-floor | Two instruments in one flow, one connection each |
| 06-connection-alarms-and-safe-state | Link alarms and an end-of-test safe-state sequence |
| 07-migrate-from-globals | Replacing a global-variable driver: context snapshot, `link call`, maintained setpoint |

## Compatibility

| Firmware | Support |
|---|---|
| **10v07 and newer** (Gen-2) | Identified automatically: readings, units, ranges and control mode come from the device. Extended 32-bit commands. |
| **10v19 and newer** | Also serial number, dates, the control-mode query (command 43) and totalizer 2 reset. |
| **6v17 to 10v06** (Gen-1) | Readings from the device's data frame. The layout, controlled variable and unit labels are set in the device configuration, because this firmware can't report them. Limited command set. |
| **Hardware-tested** | 10v20.0 and 9v07, on native Ethernet. |
| Not supported | BASIS 2 and CODA instruments (different register maps); serial gateways and Modbus RTU. |

| Runtime | Verified with |
|---|---|
| Node-RED 5.0.8, Node.js 24 (Windows 11) | Full test suite, bench hardware, 24-hour soak ([results](docs/soak-results.md)) |
| Node-RED 4.1.16, Node.js 24 | Full test suite |
| Node-RED 4.1.16, Node.js 18.20 | Runtime smoke test (the test tools themselves need Node.js 20+) |
| Node.js 22, Linux | In the CI workflow (Node-RED 4.1 and 5.0 on Node.js 22 and 24, Linux and Windows) |

## Status dots

| Dot | Text (examples) | Meaning |
|---|---|---|
| yellow ring | `connecting` | Opening the connection |
| yellow dot | `identifying` | Connected; reading firmware and layout |
| green dot | `12.47 SLPM`, `SP 12.5 SCCM`, `tare ✓` | Ready; the node's latest value or result |
| yellow dot | `tare: rejected` | The last operation failed, but the link is fine |
| red ring | `retry 3: refused` | Not connected; retrying with backoff |
| red dot | `duplicate device` | Another configuration already uses this instrument |
| red dot | `set layout`, `set device type`, `check unit ID`, `not an Alicat?` | Connected, but identification needs a setting |
| grey ring | `closed` | Stopped |

## Messages

Every output carries `msg.alicat`:

| Property | Meaning |
|---|---|
| `device`, `host`, `port`, `unitId` | Which instrument |
| `generation`, `firmware`, `serial` | `gen1` / `gen2`, e.g. `10v20.0`, and the serial number (10v19+) |
| `op` | Which node sent it: `read`, `setpoint`, `command`, `pid`, `status` or `control` |
| `quality` | `good`, `stale` (the device stopped answering; values are the last good ones) or `offline` |
| `ts`, `ageMs` | When the reply arrived (ms since epoch), and how old the values are |
| `units` | Unit of each reading, e.g. `{massFlow: "SCCM", gaugePressure: "PSIG"}`; the setpoint node sends `{setpoint: "SCCM"}` |
| `status` | Decoded status bits: `{raw, active, flags}`; e.g. `flags.holding`, `flags.exhausting` |
| `gas`, `controlledVariable`, `setpoint` | Current gas, what the setpoint controls, the setpoint |
| `outcome` | Setpoint, command and PID nodes: the operation's outcome (see below) |
| `result` | The operation's details: the setpoint write and read-back, the command's device status, the status node's `identity` |
| `error` | On failure: `{code, message, outcome, …}`, also seen by Catch nodes. It replaces `msg.alicat`, so nothing from an upstream node is mixed in |

A node that has no device selected, or invalid settings, shows a red status and fails every message with `EINVALIDARG` (outcome `not-sent`), so the problem reaches Catch nodes instead of messages vanishing.

When an instrument stops answering, a read node sends **one** message with `quality: "stale"` or `"offline"` and then waits. It never keeps sending frozen values as if they were live. Check `msg.alicat.quality === "good"` before using a value for a control decision.

**Outcomes:**

| Outcome | Meaning |
|---|---|
| `executed` | Confirmed by the device (echo, read-back, or the effect on the status bits) |
| `accepted` | The device took it, but the result can't be read back (e.g. a mode switch on Gen-1) |
| `rejected` | The device refused it (`ECOMMAND`, with the device's status) |
| `unknown` | It may have been sent, but nothing proves the result (timeout after the write, pre-emption, another master) |
| `not-sent` | Nothing was written |

## Errors

Failures go to **Catch** nodes. `msg.alicat.error.code` is one of a fixed set (it is part of the public API):

| Code | Meaning | Usual cause |
|---|---|---|
| `ECONNECT` | Could not connect | Wrong IP, device off, cable, firewall |
| `ENOTCONNECTED` | Not connected | The link is down; writes fail fast instead of running later |
| `ELINKDOWN` | Connection lost | Cable pulled, device restarted |
| `ETIMEDOUT` | No response | Device busy or unreachable |
| `EMODBUS` | Modbus exception from the device | Register not available on this firmware; device busy |
| `ECOMMAND` | The device rejected a command | Unsupported argument (e.g. differential pressure without that sensor) |
| `EPREEMPTED` | An urgent valve command interrupted this command | Expected when a hold is sent during a tare |
| `EINVALIDARG` | Invalid input | Setpoint not a number, out of range, unknown gas |
| `EUNSUPPORTED` | Not available on this firmware | e.g. command 43 before 10v19 |
| `EIDENTIFY` | Could not identify the device | Gen-1 layout not set, wrong device, unit ID |
| `EDUPLICATE` | Another configuration already uses this device | Two device configurations for one IP |
| `EQUEUETIMEOUT`, `EQUEUEFULL` | The request could not be sent in time / too many waiting | Too much polling for the link |
| `ECANCELED`, `ECLOSED` | Cancelled because the node or flow stopped | Redeploy or stop during a request |
| `EFRAMING` | Malformed Modbus frame | Not an Alicat, or a gateway in the path |

The operating-system error (for example `ECONNREFUSED`) is in the log and in `err.cause`.

## Deploys, stop and safety

- **One connection per instrument.** All nodes using a device share it. Redeploying, even repeatedly, keeps the same connection: the instrument never sees a reconnect. A second device configuration for the same IP is refused instead of opening a second socket.
- **Stop flows and shutdown** close the connection immediately, so the instrument's connection slot is free for other masters.
- **The instrument is left as it is** on deploy, stop and shutdown: setpoint, mode and valve state don't change. Node-RED is not a safety controller, and Alicat's communications watchdog is not available over Modbus TCP. Put the equipment in a safe state with your own sequence (see example 06) and with independent safety hardware.
- **alicat control starts empty** after a deploy or restart: it does nothing until it receives a desired state.
- **Hold closed with fallback** (opt-in on alicat command): if the instrument is still finishing another command, setpoint 0 is written at once as well.
- **One master.** The command registers are shared between all masters. If a PLC or HMI also sends commands, results can be reported as `unknown`, and the log warns about another master.

Modbus TCP has no authentication. See [SECURITY.md](SECURITY.md) for network and editor guidance.

## Troubleshooting

| Symptom | What to check |
|---|---|
| `retry N: timeout` | IP address and subnet. Instruments with a link-local address (169.254.x.x) need the PC on the same link. The first connection after plugging in can time out once while Windows sets up the adapter; it retries by itself. |
| `retry N: refused` | Port 502, and whether the instrument's Modbus TCP is enabled. If it worked before, another master may be holding a connection slot. |
| `duplicate device` | Two device configurations point at the same instrument (perhaps by IP and by host name). Use one. |
| `set layout` | Gen-1 firmware: pick the data-frame layout matching the instrument's front-panel data frame. |
| `not an Alicat?` | Wrong IP or port, or a device that isn't an Alicat on native Ethernet. |
| Readings `stale` now and then | Too much traffic for the link (many fast read nodes), or network drops. One read loop serves all read nodes of a device, at the fastest interval any of them asks for. |
| A setpoint seems ignored | The setpoint's meaning depends on the control mode (`msg.alicat.controlledVariable`): 50 in valve-drive mode is 50 %, not 50 SCCM. |
| "not a private address" in Test connection | The IP is outside the private ranges (e.g. 172.168.x.x is public; private is 172.16–31.x.x). Fix the IP plan before routing that network. |

The **Test connection** button in the device configuration identifies the instrument before you deploy, and reuses the live connection if there is one. It only opens new connections to port 502; to test an instrument or simulator on another port, list the port in `settings.js` as `alicatModbus: {probePorts: [5020]}` (`npm run dev` does this for its simulators). **Frame trace** (Advanced) logs every Modbus frame.

## Moving away from global variables

Flows that poll a device into many global variables, and drive it by writing a target into a global, can move over gradually (example 07):
1. **alicat read** publishes one frozen snapshot per instrument to context (`{ts, quality, values, status, units, …}`), from a single writer. Existing readers keep working; they should check `quality` and age.
2. Send setpoints and valve states to **alicat control** through `link call`, so the caller gets a result or an error instead of polling a global.
3. Feed analytics (smoothing, slopes, peaks) from messages, using `msg.alicat.ts` for time.

## Developing

```powershell
npm install
npm run check          # lint, typechecks, tests with coverage gate, runtime smoke test, package contents
npm run dev            # Node-RED on http://127.0.0.1:1880 with this package linked, plus simulators on 5020-5022
npm run sim            # simulated 10v20 MFC on 127.0.0.1:5020 (drops idle links after 20 s, like the real unit)
npm run sim -- --list  # available simulator profiles
npm run probe -- 192.0.2.10 info   # bench probe for a real unit (writes need --write)
npm run test:compat    # runtime smoke test, needs only Node-RED (CI: Node 18 with Node-RED 4.0 and 4.1, and the packed tarball)
npm run soak -- --hours 24 --real 192.0.2.10   # long-running soak test, see test/soak/soak.js
npm run diagram        # rebuild the architecture diagram in docs/diagrams/ after changing tools/diagram/spec.js
```

With `npm run dev`, import the examples from **Menu → Import → Examples → @samuraimittal/node-red-alicat**. Examples use the simulators on 5020 and 5021; 5022 is a Gen-1 (9v07) replica that needs the `extended-7` layout. The Node-RED user directory is `.dev/node-red`; delete it to start fresh.

Conventions, tests and the hardware rules for contributors: [CONTRIBUTING.md](CONTRIBUTING.md). Hardware checks (read-only unless enabled) are described in [docs/hardware-validation.md](docs/hardware-validation.md). How the pieces fit together: [docs/architecture.md](docs/architecture.md), with a diagram of every file and the main flows ([docs/diagrams/](docs/diagrams/architecture.excalidraw), editable in Excalidraw). The register map as verified on hardware: [docs/register-map.md](docs/register-map.md).

### Layout

| Path | Contents |
|---|---|
| `nodes/` | The seven Node-RED nodes (runtime `.js` plus the editor template `.html`); `nodes/locales/en-US/` holds each node's messages (`.json`) and help (`.html`) |
| `resources/` | Editor scripts (one per node, plus shared validators) and styles, served to the Node-RED editor |
| `examples/` | Importable flows, one per use case; tested against the simulator |
| `lib/node-red/` | Node glue: `defineDeviceNode` (settings, input pipeline, close order), the settings bounds table, the `msg.alicat` contract, status dots, editor endpoints (`/alicat-modbus/probe`, gases, layouts) |
| `lib/Reconciler.js` | The `alicat-control` engine: holds a desired setpoint, mode and valve state, corrects drift, never acts on stale data |
| `lib/ContextPublisher.js` | Optional single-writer, frozen snapshot in flow/global context, for flows that still read globals |
| `lib/AlicatDevice.js` | One instrument: state, identification lifecycle and the public API; the work is in `lib/device/` |
| `lib/device/` | Identification (Gen-1 or Gen-2), snapshot decoding, the shared poll loop, setpoints and mode switches, valve, gas, tare and PID commands |
| `lib/CommandLane.js` | One command at a time per device, urgent pre-emption; `lib/lane/` runs the handshake measured on hardware (NOP first, device-cycle settle, echo polling) for the extended and limited interfaces |
| `lib/AlicatClient.js` | One supervised connection per device: state machine, single in-flight request, pacing, heartbeat (5 s, inside the device's ~20 s idle drop), link-dead detection, jittered backoff, rate-limited logs |
| `lib/PriorityQueue.js` | URGENT / CONTROL / POLL queue: coalescing, latest-wins, per-waiter deadlines, POLL aging, bounded depth |
| `lib/ConnectionRegistry.js` | Process-wide owner of connections: one socket per device, parked across deploys, alias and duplicate detection |
| `lib/modbus/` | Modbus TCP transport over `net`: MBAP framing, 16-bit transaction IDs, late-reply handling |
| `lib/alicat/` | Register map constants (1-based, as in the Alicat manual), codec, firmware gates, gas, unit and status tables |
| `lib/errors.js` | Closed set of `err.code` values (public API) |
| `lib/util/` | Small shared helpers: own-key lookups, defaults, timers |
| `tools/` | `alicat-sim` (simulator, shipped), `alicat-probe` (bench probe, shipped), `dev` (Node-RED + simulators), `check-pack` (package contents), `architecture-diagram` with `diagram/` (builds `docs/diagrams/`) |
| `tools/sim/` | Alicat simulator: process model, register bank, Modbus TCP server, fault injection, test hooks |
| `test/` | Unit, integration and node tests (mocha + node-red-node-test-helper) with shared `helpers/`, `compat/` runtime smoke test, `soak/` long-running test, `hil/` opt-in hardware tests |

## License

[Apache-2.0](LICENSE). Alicat is a trademark of Alicat Scientific, Inc.; this project is not affiliated with or endorsed by Alicat Scientific.
