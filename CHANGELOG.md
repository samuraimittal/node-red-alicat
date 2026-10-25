# Changelog

All notable changes to this package are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the package uses [Semantic Versioning](https://semver.org/). Error codes (`err.code`, `msg.alicat.error.code`) are part of the public API.

## [Unreleased] – 0.1.0

First release. Hardware-tested on a Gen-2 instrument (firmware 10v20.0) and a Gen-1 instrument (9v07) over native Ethernet.

### Added

- **Nodes:** `alicat-device` (configuration, with a *Test connection* button), `alicat-read`, `alicat-setpoint`, `alicat-command`, `alicat-pid`, `alicat-status` and `alicat-control` (maintains a desired setpoint, control mode and valve state).
- **One supervised connection per instrument**, shared by every node and kept across redeploys. A second configuration for the same instrument (also by another host name) is refused with `EDUPLICATE` instead of opening another socket. *Stop flows* and shutdown close the connection at once.
- **Connection supervision:** one request in flight, a 20 ms request gap, a 5 s heartbeat (instruments drop connections idle for about 20 s), dead-link detection after silent timeouts, and reconnects with jittered exponential backoff (1 s to 30 s).
- **Priority queue:** valve commands go ahead of everything, setpoints and commands ahead of polling; reads are coalesced and a newer setpoint replaces one not yet sent.
- **Firmware detection:** Gen-2 (10v07+) is identified from the device, including units, ranges and control mode. Gen-1 (6v17–10v06) uses a configured data-frame layout; the `extended-7` preset matches the common 7-slot frame.
- **Setpoints in every control mode** (mass flow, volumetric flow, absolute, gauge and differential pressure, valve drive), with a bumpless mode switch and read-back confirmation.
- **Commands:** tare, totalizer reset, valve hold closed / hold current / exhaust / resume (confirmed by the status bits), gas select by number or name, front-panel lock, PID gains and loop algorithm. Each command follows the handshake measured on hardware: a NOP first, a device-cycle settle, then echo polling. Repeat-safe commands are resent once if the device drops them; tare and totalizer reset never are.
- **Data quality on every message:** `quality` (`good`, `stale`, `offline`), the reply timestamp and the data age. A dead device produces one `stale`/`offline` message, never frozen values that look live.
- **Outcome on every write:** `executed`, `accepted`, `rejected`, `unknown` or `not-sent`.
- **One `msg.alicat` shape:** every message names the instrument and the sending node's `op`. Setpoint, command and PID results carry `outcome` and `result`. On failure, `error` replaces `msg.alicat` as a whole, so a Catch node never sees fields left by an upstream node.
- **Settings checked at deploy:** an out-of-range interval or an unknown option puts the node in *invalid config*. Such a node, or one with no device selected, fails every message to Catch with `EINVALIDARG` instead of dropping it, and never opens a connection.
- **Optional context snapshot** for flows that read globals: one frozen object per instrument, from a single writer.
- **Editor:** every field is checked with the same ranges the runtime enforces, and says why a value is refused. Texts and help come from message catalogs (`nodes/locales`), ready for translation. The context store is picked from the stores in settings.js. Nodes have port labels.
- **Seven example flows**, including a migration path away from global-variable drivers.
- **Simulator** (`npx --no -- alicat-sim`) with 10v20 and 9v07 profiles and fault injection, and a bench probe (`npx --no -- alicat-probe`).
