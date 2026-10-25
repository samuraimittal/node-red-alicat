# Soak test results

How to run a soak: [`test/soak/soak.js`](../test/soak/soak.js) (`npm run soak -- --hours 24 --real <ip> …`). Each run writes `metrics.jsonl`, `events.jsonl` and `summary.md` under `soak-results/`.

## Run 1: 2026-10-15 16:31 → 2026-10-16 17:02 (local time), 24.5 h

**Setup**
- Node 24.15, Node-RED 5.0.8 embedded in one process, Windows 11.
- 20 simulated instruments with a mixed workload:
  - reads at 200 ms and 1 s;
  - maintained setpoints;
  - setpoint writes, valve hold and resume, tares, gas changes, PID reads.
- The two bench instruments, read-only: 10v20 at 192.0.2.10 and 9v07 at 192.0.2.11.
- A fault every 5 minutes, a redeploy every 15 minutes, and a stop/start of the flows every hour.

**Verdict:** the library passed. The harness reported *FAIL* for 28 violations, and all 28 were caused by the host PC rather than the library (details below).

| Check | Result |
|---|---|
| Faults injected / recovered | 287 / 286; the last one was still inside its recovery limit when the run ended |
| Slowest recovery | 27.7 s (connections refused for 30 s); every other fault type recovered within 14.1 s |
| Socket collisions (two connections to one instrument) | 0, across 96 redeploys and 23 stop/starts |
| Connections left open after *Stop flows* | 0 of 23 |
| Reads | 5,542,170 (99.99 % good) |
| Read round trip | p50 2 ms · p95 4 ms · p99 5 ms |
| Unhandled rejections, stuck command lanes, listener or subscriber leaks | 0 |
| Live heap (after GC) | +0.5 MB/h, from the **simulator's** command log, not the library (see below) |

### The 28 violations

| Count | Kind | Cause |
|---|---|---|
| 8 | `real-device-stale` | The PC was unplugged from the instrument hub four times: 10:01, 12:06, 13:56 and 14:42 on 10-16. Both instruments dropped in the same second each time, because their USB Ethernet adapter disappeared. The library retried about twice a minute and reconnected on its own each time the PC was plugged back in. |
| 20 | `stale-without-fault` | The PC went to sleep from 16:23:42 to 17:02:54 on 10-16 (Windows Kernel-Power events). The process was suspended, and on wake every simulator looked silent for 39 minutes. |

The harness flagged five errors outside fault windows. All five are sim-14's valve hold timing out after the *drop two commands* fault. The library resends a dropped command once, so when the device drops two in a row, the second attempt fails as well. The error appears 10 s after the fault, which is outside the harness's error window.

### Memory

**The library doesn't leak.** The live heap grew 0.5 MB/h (36 → 48 MB). To find the source, heap snapshots were taken 27 minutes apart in separate runs (normal traffic only, continuous faults, rapid redeploys, rapid stop/starts) and compared object by object. Almost all the growth was the simulator's per-command log (`CommandEngine.log`, about 80 bytes per command). It shows up here because the simulators run inside the soak process. The log is now capped at 1,000 entries. The library's own objects were flat in every case.

**RSS** levels off at about 210–240 MB. That is V8 keeping heap space reserved (about 4× the live heap under a constant allocation rate), not a leak.

### Fixed in the harness after this run

- The hourly forced reconnect of the real instruments never fired: its timer collided with the hourly stop/start. It is now offset by half an interval.
- Accelerated fault schedules could queue faults without limit. Ticks are now skipped while a fault is still pending.
- Host sleep (a jump in the harness clock) is reported as an environment event; the error window covers command-drop faults; violations include the client state.

## Run 2: 2026-10-17 14:26 → 22:26 (local time), 8 h compressed

The first run after the code-quality overhaul (bug fixes, the `lib/device/` and `lib/lane/` split, the new node scaffolding).

**Setup**
- Node 24.15, Node-RED 5.0.8 embedded in one process, Windows 11; PC plugged in, sleep disabled.
- 20 simulated instruments with the same workload as run 1.
- The 10v20 at 192.0.2.10, read-only. The 9v07 was not available.
- A compressed schedule with about run 1's event counts in a third of the time:
  - a fault every 100 s;
  - a redeploy every 400 s;
  - a stop/start every 25 min;
  - a forced reconnect of the real instrument every 20 min.

  The command was `npm run soak -- --hours 8 --fault-every 100 --redeploy-every 400 --stop-start-every 1500 --reconnect-real-every 1200 --real 192.0.2.10`.

**Verdict: PASS, 0 violations.**

| Check | Result |
|---|---|
| Faults injected / recovered | 287 / 287 (ten fault types, 28 or 29 of each) |
| Slowest recovery | 25.1 s (connections refused for 30 s), then 15.5 s (instrument restart); every other fault type within 9.2 s |
| Socket collisions | 0, across 72 redeploys and 19 stop/starts |
| Connections left open after *Stop flows* | 0 of 19 |
| Reads | 1,820,238 (99.97 % good; 70 stale and 396 offline, during faults and the one real-instrument reconnect below; no stale-data violations) |
| Read round trip | p50 2 ms · p95 4 ms · p99 5 ms (limit 250 ms) |
| Errors outside fault and deploy windows | 0 |
| Unhandled rejections, stuck command lanes, listener or subscriber leaks | 0 |
| Live heap after warm-up | 36.8 → 38.7 MB, +0.18 MB/h (limit 1 MB/h); run 1's simulator-log growth is gone |
| RSS / active handles | −0.16 MB/h / 169 → 161 |

**The real instrument:** 28,500 good reads, 0 stale and 20 offline. All 20 offline reads came from one event at 19:36. Five seconds after a forced reconnect, the 10v20 reset the new connection (`ECONNRESET`), and the next attempt failed with `EHOSTUNREACH`. The library retried and was reading again 21 s later. The other 18 forced reconnects needed no retry.

**Expected errors:** 747 `EPREEMPTED` are urgent valve commands in the workload interrupting a running command, as designed. 11 commands ended `unknown` (`ETIMEDOUT`): tares and totalizer resets dropped by the *drop two commands* fault, which the library never resends.

### Next

A full 24-hour run before the pilot, with both instruments (the 9v07 back on the network), for slow effects that a compressed schedule can't show.
