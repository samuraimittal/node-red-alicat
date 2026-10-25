# Release checklist

The package stays `"private": true` until the first public release. `npm publish` refuses private packages, so nothing can be published by accident.

## Decisions

| # | Item | Status | Notes |
|---|---|---|---|
| 1 | **Open-source release approval** | Done | |
| 2 | **Licence** | Done | Apache-2.0 (the same as Node-RED, with a patent grant): `LICENSE`, `"license"` in `package.json`. |
| 3 | **Package name** | Done | `@samuraimittal/node-red-alicat`: scoped, as Node-RED asks, and without "modbus", so Modbus RTU and serial can be added later. |
| 4 | **Repository and issue tracker** | Done | github.com/samuraimittal/node-red-alicat, in `package.json` and `.github/CODEOWNERS`. |
| 5 | **Stop and shutdown behaviour** | Documented | The library leaves instruments as they are on deploy, stop and shutdown; *hold closed → setpoint 0* is opt-in. See the README section "Deploys, stop and safety". |
| 6 | **Trademark wording** | Done | README states the package is not affiliated with Alicat Scientific; no Alicat logos are used. |

## Engineering gates

| # | Gate | Status |
|---|---|---|
| 1 | `npm run check` (lint, both typechecks, tests with coverage ≥ 97 % lines / 88 % branches / 94 % functions, runtime smoke test, package contents) | Passing |
| 2 | Node-RED 4.0, 4.1 and 5.0 test suites; runtime smoke test on Node 18 with Node-RED 4.0 and 4.1, and against the packed tarball | Passing locally (Node 18.20.8 + Node-RED 4.0.9 from the packed files); CI workflow ready (needs the repository) |
| 3 | `node-red-dev validate` | Passing apart from P03 (item 4), P04 (item 3) and P05 (below) |
| 4 | 24-hour soak (20 simulated + 2 real instruments, faults every 5 min) | Run 1 done: the library passed; all 28 violations came from the host PC being unplugged or asleep ([soak-results.md](soak-results.md)). Run 2 (8 h compressed, after the code-quality changes, 10v20 only): PASS, 0 violations, 287/287 faults recovered. Still to do: a full 24 h run with both instruments before the pilot. |
| 5 | Hardware validation on Gen-1 and Gen-2 | Done (10v20.0, 9v07) |
| 6 | Manual editor check (dialogs, help, dark theme, validation, Test connection) | Done on Node-RED 5.0.8 (2026-10-17) after the editor rework: dialogs, dark theme, validation messages, the help panel, and Test connection against the 10v20 bench unit. (The M4 review found the PID-gain property bug, since fixed.) |
| 7 | Pilot on two test stations (v0.9) | Not started |

## Publishing (after the decisions above)

1. Apply items 2–4 in `package.json`; remove `"private": true`.
2. Add `"node-red"` to `keywords` (`node-red-dev` P05). This keyword is what makes the Node-RED Flow Library index the package, so add it only when the package should be public.
3. Set the version, move the `[Unreleased]` section of `CHANGELOG.md` under it, and tag the release.
4. `npm run check:pack` (part of `npm run check`) verifies the file list: `nodes/` with its locales, `resources/`, `lib/`, `examples/`, the simulator and probe (`tools/`), `README.md`, `CHANGELOG.md`, `SECURITY.md`, and `LICENSE` once a licence is set.
5. Publish from CI with npm provenance (`npm publish --provenance --access public`, using npm trusted publishing so no long-lived token is stored).
6. Submit the package to the Node-RED Flow Library (flows.nodered.org → *Add a node*).
