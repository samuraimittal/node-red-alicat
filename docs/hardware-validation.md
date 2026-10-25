# Hardware validation (Gate 0 and HIL)

The Alicat Modbus manual (Rev 7, Nov 2024) leaves some behaviour undocumented, and it turned out to be **wrong about status bit 10**. This page lists each item, how to check it on a real device, and the results so far. The results become the simulator's behaviour (`tools/sim`).

Run every check on a **bench unit with no process gas connected**. Steps marked ⚠ move the valve or change device state.

## Devices needed

- One Gen-2 unit (**10v07 or newer**). ✅ Done, see below.
- One Gen-1 unit (**8v or 9v**, older than 10v07). ✅ Done (9v07), see below.

## 1. Automated read-only checks

Use the real IP and a real file name. In PowerShell, `<` and `>` are operators, so don't type angle brackets.

```powershell
$env:ALICAT_HIL_HOST = '192.0.2.10'
npm run test:hil 2>&1 | Tee-Object hil-report.txt
# Connection-limit probe: occupies up to 8 extra TCP slots. Don't run it while a PLC or HMI depends on the device.
$env:ALICAT_HIL_PROBE_CONNECTIONS = '1'; npm run test:hil 2>&1 | Tee-Object hil-report.txt
Remove-Item Env:ALICAT_HIL_HOST, Env:ALICAT_HIL_PROBE_CONNECTIONS
```

## 2. Bench probe (`npm run probe`)

- Register numbers are 1-based, as in the manual.
- Reads use FC04.
- Writes use FC16 only and need `--write`.
- Factory restore, the RTU-only commands and the EEPROM ramp are blocked.

```powershell
npm run probe -- 192.0.2.10 info                       # generation, firmware, serial, data-frame slots
npm run probe -- 192.0.2.10 status                     # decoded status bits
npm run probe -- 192.0.2.10 watch 1203 14 --as f32     # live data frame
npm run probe -- 192.0.2.10 command 6 1 --write        # ⚠ hold valves closed, with timeline
npm run probe -- 192.0.2.10 command 6 0 --write        # ⚠ resume closed-loop control
npm run probe -- 192.0.2.10 command 33 3000 --write --extended --duration 5000   # ⚠ timed flow tare (Gen-2)
npm run probe -- 192.0.2.10 idle --minutes 10          # does the device drop idle connections?
```

## 3. Checklist

| # | Item | Status | Result |
|---|---|---|---|
| 1 | Unit ID on native TCP | ✅ 10v20 | **Ignored**: IDs 0, 1, 2, 247 and 255 all answer. The default of 1 is fine. |
| 2 | FC03 on TCP | ✅ 10v20 | The function is implemented, but register 1200 gives **exception 02**, so the holding map differs. The library uses FC04 only. |
| 3 | Maximum FC04 quantity | ✅ 10v20 | **125**, the full Modbus maximum |
| 4 | Concurrent TCP connections | ✅ 10v20 | **At least 9** accepted (probe cap); the first connection survived. Not tested: whether extra connections are served. |
| 4b | Idle-disconnect timer | ✅ 10v20 | **The device closes an idle connection after about 20 s** (20.1 s measured). The client must send traffic well inside that window: heartbeat default 5 s. |
| 5 | Status bit 10 | ✅ 10v20 | **bit 10 = EXHAUST**. It sets within about 120 ms of `6 3` and clears on `6 0`. **This contradicts Rev 7** ("pressure over user limit") and matches the legacy manual. Bits 11–13: not yet seen. |
| 6 | Command 7 = display lock | ✅ 10v20 | `7 1` locks the front panel and `7 0` unlocks it. The result register reads 0 (success). |
| 7 | Missing readings over TCP | ✅ 10v20 | Return **NaN** (no exception), in both the optimized slots (8–20) and the standard block. Info **type is 0**, which isn't in Appendix A (the manual says 1 = None). |
| 8 | Firmware register format | ✅ 10v20 | `10,20,0,0` → `10v20.0` |
| 9 | Minimum request gap | ⏳ | Not stressed. Probe polls about every 110 ms were fine; RTT was about 5–7 ms. |
| 10 | Echo shows other masters' commands | ✅ 10v20 (partly) | The echo is **shared across interfaces**: limited `1000` showed 33 after an extended command, and extended `1002` showed 6 after a limited command. Another master still to test. |
| 11a | Does a NOP reset 1000 to 0? | ✅ 10v20 | Yes, about 120 ms after the write, **but only if the NOP is a change** (see 11d) |
| 11b | Completion timing | ✅ ext. on 10v20 / ⏳ limited on Gen-1 | Extended: the echo is set at **start** with status 1 (IN_PROGRESS), then status 0 after about 3.0 s for a 3000 ms tare. |
| 11c | ID and argument in one FC16 frame | ✅ 10v20 | Yes: `6 1` gives HLD |
| 11d | **Change detection** | ✅ 10v20 | A write runs only if it differs from the **previous write on the same interface**. An extended NOP right after limited commands did nothing (the extended registers already held 0). The echo stayed `6` for 2 s. |
| 11e | Command processing cycle | ✅ 10v20 | Echo and status bits update **about 110–125 ms** after a write |
| 12 | Command while another is IN_PROGRESS | ✅ 10v20 | **Queued, not pre-empting.** A limited `6 1` written about 1.5 s into a 3000 ms extended timed tare ran only when the tare finished (about 1.7 s later). The extended echo switched from 33 to `6, 1` at completion. While the tare ran, limited `1000` read **0**, so the limited view shows the last *completed* command. **A valve hold cannot interrupt a running command.** |
| 13 | Valve-hold → HLD | ✅ 10v20 | HLD (bit 8) set **≤ 125 ms** after the write, and cleared within 125 ms of `6 0` |
| 14 | Gen-1 "numeric readings 1–7" | ⏳ | Gen-1 unit needed |

### What this changes in the library
- **Status decoding:** Gen-2 bit 10 is decoded as `exhausting` (verified on hardware), not as the Rev 7 meaning.
- **NOP rule** in the command lane, replacing "poll until echo = 0", which can hang:
  - write the NOP;
  - if the echo was non-zero, wait until it reads 0;
  - otherwise wait 300 ms (≥ 2 device cycles);
  - then write the command.
  
  This is needed because change detection is per interface and the device samples on a ~120 ms cycle.
- **Keep-alive:** the device drops connections idle for about 20 s, so the heartbeat runs every 5 s when nothing else is talking.
- **Valve safety:** commands queue behind a running command (item 12). So:
  - timed tares default to the shortest duration (argument 0 = 256 ms);
  - an urgent hold-closed issued while a command is running is still written, and is reported as queued behind it;
  - with the opt-in fallback, an urgent hold-closed also writes setpoint 0 straight away, because the setpoint register isn't part of the command queue. Still to verify: that a setpoint write takes effect during a tare.
- **Identification:** a reading info type of **0 or 1** means "absent". The setpoint type can be **45 (valve-drive setpoint)**, so the controlled variable comes from the setpoint type and can't be assumed to be a flow or pressure class.

## 4. Results

### Gen-2 — firmware 10v20.0 — tested 2026-10-15
- **Link:** direct link from the test PC on a link-local address. Fine for the bench; use static addresses in production.
- **Configuration found:**
  - Gas 0 (Air).
  - **Setpoint type 45: valve-drive setpoint, %, −100…100.** The unit is in valve-drive (open-loop) mode.
  - Mass flow is in SCCM (±2000, so it measures both directions); volumetric flow is in LPM (±2).
  - Primary pressure is gauge (PSI); secondary is absolute (PSI).
  - Totalizers and humidity are absent.
- **Data frame:** 7 slots, identical to the production flow's buffer-parser layout:

| Slot | Register | Info type | Meaning | Units (code) | Production label |
|---|---|---|---|---|---|
| 1 | 1203 | 2 | absolute pressure | PSI (10) | `psia` |
| 2 | 1205 | 6 | gauge pressure | PSI (10) | `psig` |
| 3 | 1207 | 15 | barometric pressure | PSI (10) | `psib` |
| 4 | 1209 | 3 | temperature | °C (2) | `temp` |
| 5 | 1211 | 4 | volumetric flow | LPM (7) | `vflow?` → **confirmed** |
| 6 | 1213 | 5 | mass flow | SCCM (12) | `massflow` |
| 7 | 1215 | 45 | setpoint (valve drive) | % (63) | `setpoint` |

- Command timelines: see the table above (items 5, 10, 11, 13).
- **Loop control variable:** command 43 query (65535) returns **45** (Appendix A "valve-drive setpoint"), consistent with the setpoint info type. So the query answers in Appendix A codes, at least for valve drive.
- **PID gains** (command 14, limited interface, result in 1001): P = 5000, D = 0, I = 250.

### Gen-1 — firmware 9v07 — tested 2026-10-15 (read-only, plus queries)
- **Identification:** `1090` → **exception 02**. That is positive Gen-1 evidence, and it matches the plan's rule.
- **Register blocks:** everything else answers exception 02. That includes `1199` (alarm), `1002–1009` (extended commands), `1010` (setpoint, write-only), `1050`, `1086–1093`, `1246`, `1296`, `1346`, `1400`, `1640` and the legacy `2041`.

| Block | Registers |
|---|---|
| Limited commands | `1000–1001` |
| Header | `1200` gas, `1201–1202` status |
| Data frame | `1203–1216` |

- **Data frame:** **7 slots**, then exception 02 at slot 8. A missing pair raises an exception on Gen-1 TCP (Gen-2 returns NaN instead). The layout matches unit 1 and the production flow:

| Slot | Value | Meaning |
|---|---|---|
| 1 | 14.75 | absolute pressure |
| 2 | −0.02 | gauge pressure |
| 3 | 14.77 | barometric pressure |
| 4 | 24.1 | temperature |
| 5 | −0.0004 | volumetric flow |
| 6 | −0.39 | mass flow |
| 7 | 12.5 | setpoint |

  There are no units or info blocks, so this layout must be configured. The library ships it as a preset.
- **Unit IDs:** 0, 1, 2 and 247 answer; **255 gets no response** (timeout). That differs from 10v20, so the library never uses 255.
- **FC03** → exception 02, the same as 10v20.
- **PID gains** (command 14): P = 720, D = 610, I = 250.
- **Limitation:** the limited interface returns results in a u16 where ≥ 32769 means an error. A gain or result in the range 32769–32774 can't be told apart from an error code on Gen-1. Gen-2 uses the 32-bit extended interface instead.


### Device layer (M3), read-only, on both units — 2026-10-15
`npm run test:hil` with `ALICAT_HIL_HOST=192.0.2.10` and `ALICAT_HIL_GEN1_HOST=192.0.2.11` passed 7 of 7 read-only checks.

| Unit | Identification | Live snapshot | PID (P / D / I) | Mode query |
|---|---|---|---|---|
| 10v20 | gen2, 10v20.0, controlled variable **valveDrive** (type 45) | every reading named and labelled: setpoint %, valveDrive %, gaugePressure PSIG, absolutePressure PSIA, barometricPressure PSIA, temperature °C, volumetricFlow LPM, massFlow SCCM; RTT 4 ms | 5000 / 0 / 250 | command 43 → 45 |
| 9v07 | gen1 with the `extended-7` layout (no units over Modbus) | 7 values; RTT 2 ms | 720 / 610 / 250 | not available (Gen-1) |

### Device layer (M3), with writes (`ALICAT_HIL_WRITE=1`), both units, no gas connected — 2026-10-15
Three runs.

| Check | 10v20 | 9v07 |
|---|---|---|
| Valve hold closed → resume, confirmed by HLD | ✅ executed (≈ 420 ms each with the final lane timing; ≈ 310 ms before) | ✅ executed (≈ 420 ms; ≈ 290 ms before) |
| PID rewritten with current values + read back | ✅ | ✅ |
| Gas re-selected (Air) and confirmed at 1200 | ✅ | ✅ in runs 2–3. ❌ **Run 1: the device accepted the FC16 write but never executed the command** (see below) |
| Setpoint 0 in **massFlow** (SCCM), **gaugePressure** (PSIG), **valveDrive** (%), each confirmed by setpoint type and read-back, then original mode restored | ✅ all three, 3 of 3 runs | skipped: needs `ALICAT_HIL_GEN1_MODE` (the current mode can't be read on Gen-1) |

**Dropped command on 9v07 (seen once in 4 identical sequences).**
- **What happened:** after a NOP had executed, a limited-interface gas select (1, 0) was written and acknowledged by FC16. It never ran: 1000 stayed 0 for 10 s.
- **Couldn't reproduce:** three replays of the same order with logging all completed normally (≈ 300 ms).
- **Suspected cause:** the command was written within milliseconds of the NOP's echo appearing, possibly at the edge of the device cycle.
- **Mitigation in the library:**
  - **(1)** The command goes out at least **200 ms after the NOP**. This adds ≈ 70–110 ms per command.
  - **(2)** **Repeat-safe commands** (gas, valve, gains, mode, display, queries) that the device hasn't picked up within **1 s** are sent once more, with a warning.
  - **(3)** Tare and totalizer reset are **never** resent automatically. A dropped one ends with `ETIMEDOUT`, outcome `unknown`.
- After the fix, 2 of 2 full runs passed without needing a resend.

### Control-mode cycle on 9v07 — 2026-10-15
- **Method:** each step held the valve, sent command 11, wrote setpoint 0 and resumed, with 30 s between steps. Each switch took ≈ 1.35 s. Script: scratchpad `mode-cycle.js`.

| Step | Mode | Command 11 argument | Result |
|---|---|---|---|
| 1 | mass flow | 0 | ✅ executed, setpoint read back 0 |
| 2 | volumetric flow | 1 | ✅ |
| 3 | absolute pressure | 3 | ✅ |
| 4 | gauge pressure | 4 | ✅ |
| 5 | differential pressure | 2 | ❌ **refused with 1001 = 0x8002 = INVALID_ARGUMENT** (no differential sensor). The valve was released afterwards: step 6 started unheld. |
| 6 | valve drive | **45** (Appendix A code, accepted on 9v07) | ✅ |
| 7 | mass flow | 0 | ✅ (final state) |

- **Final state:** the unit stays in mass-flow mode, and the operator confirmed setpoint control works in that mode (2026-10-15). No restore needed.

- **Finding:** limited-interface error codes are **0x8000 + status − 1** (0x8001 INVALID_ID, 0x8002 INVALID_ARGUMENT, 0x8003 UNSUPPORTED). The library and simulator had used 0x8000 + status. That is fixed, with a regression test.

### Node-RED nodes (M4), read-only, both units — 2026-10-15
- **Setup:** Node-RED 5.0.8 on Node 24.15.0 (Windows 11), with the package installed from the working tree. The flow had:
  - one `alicat-device` per unit: 10v20 on `auto`, and 9v07 on `extended-7` with unit labels;
  - one `alicat-read` per unit at 1 s;
  - one `alicat-status` per unit.

| Check | Result |
|---|---|
| Deploy and identify | ✅ Both units READY within about 1 s of connecting. The 10v20 was identified as Gen-2 `10v20.0`, valve-drive control, units from the device (`%`, PSIG/PSIA, °C, LPM, SCCM). The 9v07 was identified as Gen-1 on the `extended-7` layout with the configured labels. |
| First connect | Both units' **first** connection attempt timed out at the same moment (the PC had several link-local adapters in "Tentative" state). Both nodes showed `retry 1: timeout` and reconnected 0.5–0.9 s later. The status node reported BACKOFF → CONNECTING → ONLINE / IDENTIFYING → READY. |
| Live data | ✅ 1 s snapshots with `quality: 'good'`, RTT 3 ms, gas Air, status bits clear. |
| Editor "Test connection" (`POST /alicat-modbus/probe`) | ✅ `reused: true` on both units, answered in 3 ms, **no extra socket** (2 established before and after). A public address (172.168.1.191) gets the "not a private address" hint, and bad input gets a 400. |
| Probe of an unreachable host | It reported only "not ready" after 8 s. **Fixed:** a probe now fails as soon as its connection attempt fails, with the real reason (`ECONNECT … ECONNREFUSED` / `ETIMEDOUT`), and there is a test. |
| 5 full redeploys | ✅ **The same two sockets throughout** (local ports unchanged), 0 new connections, 0 warnings. |
| Simulators via `npm run dev` | ✅ Example 05 plus a Gen-1 reader, deployed 4 times: each simulator logged exactly **one** connection and no rejections. All 7 examples are listed under Import → Examples. |
