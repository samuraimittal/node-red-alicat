# Contributing

How to work on @samuraimittal/node-red-alicat: the checks a change must pass, the conventions the code follows, and the rules for the bench hardware.

## Setup

Node.js 20.19 or newer for development (the package itself runs on Node.js 18.5+, as Node-RED 4 does).

```powershell
npm install
npm run check      # everything CI checks: lint, both typechecks, tests with coverage, runtime smoke test, package contents
```

`npm run check` must pass before every commit. CI runs it too, plus the test suite on Node 22 and 24 with Node-RED 4.0, 4.1 and 5.0, and the runtime smoke test on Node 18 and 20.

## Conventions

- **JavaScript with JSDoc types**, checked by `tsc` in strict mode (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` and more; see `tsconfig.json`). There is no build step. `lib/` and `nodes/` use no `any`: give a value a real type, or `unknown` and narrow it. A test enforces this.
- **No runtime dependencies.** Shipped code may require only Node's own modules; ESLint (`eslint-plugin-n`) enforces it, and checks that nothing newer than Node 18.5 is used.
- **Error codes are public API** (`lib/errors.js`): adding one is a minor change, renaming or removing one is major. OS errors travel in `err.cause`.
- **`msg.alicat` has one shape** (`lib/node-red/message.js`): the instrument, the node's `op`, then the operation's `outcome` and `result`; on failure `error` replaces it as a whole.
- **Every write reports an outcome**: `executed`, `accepted`, `rejected`, `unknown` or `not-sent`. When in doubt it is `unknown`, never `executed`.
- **Names from messages and configurations are looked up with `own()`** (`lib/util/own.js`), so `"constructor"` or `"__proto__"` is never taken for a valid name.
- **Nodes are built with `defineDeviceNode`** (`lib/node-red/device-node.js`): settings are checked before a connection is taken, inputs go through `handleInput`, cleanup through `onClose`. Only the config node registers its own input and close handlers.
- **Settings ranges live in one table** (`lib/node-red/settings.js` `BOUNDS`), mirrored in `resources/alicat-editor.js` for the editor; a test keeps the two equal.
- **Editor text and help are in the catalogs** (`nodes/locales/en-US/<node>.json` and `.html`), referenced with `data-i18n`; a test checks every key exists.
- Lint limits: complexity 15, nesting depth 4, five parameters, 80-line functions in `lib/`. Split a function rather than raise a limit.

## Tests

| Command | What |
|---|---|
| `npm test` | Unit, integration and node tests (about a minute) |
| `npm run coverage` | The same, with the coverage gate (97 % lines, 88 % branches, 94 % functions) |
| `npm run test:compat` | Deploys every node type in a real Node-RED with only Node-RED installed; `--package <dir>` loads the nodes from an unpacked tarball |
| `npm run check:pack` | What `npm pack` publishes: every node's files, every file the code requires, nothing else |

- Shared helpers are in `test/helpers/`: `wait.js` (`until`, `delay`), `assert.js` (`rejectsCode`, `throwsCode`, `failure`), `device.js` (simulator, client and device with fast test timings) and `nodes.js` (the Node-RED test helper, `quiet()`).
- Wait for an event or a state with `until()`, not for a fixed time. Where a bound matters, assert the one timers can't break (a timer never fires early).
- The simulator has public test hooks; don't patch its private fields: `sim.faults` (silence, dropped replies, exceptions, refused connections), `sim.engine.dropNextCommands`, `engine.running`, `engine.rewriteWrite`, `engine.commandHook`, `sim.bank.setReadable()`, and the server's `request` event (which carries written values).
- `test/integration/lane-characterisation.test.js` pins the exact command-register writes of the command handshake. A change to `lib/lane/` that changes them is a change in what reaches the device: explain it in the commit.
- A bug fix comes with a test that fails without it. Check by reverting the fix (`git stash push -- lib nodes`) and running the test.

## Architecture diagram

`docs/diagrams/` holds the architecture diagram: `architecture.excalidraw`, every view on one canvas (open it in [excalidraw.com](https://excalidraw.com) or the VS Code *Excalidraw* extension), and one SVG per view for GitHub and `docs/architecture.md`.

- `npm run diagram` builds them from `tools/diagram/spec.js` (zones, a role per file, the storyboards) and the code's own `require()` calls, which become the arrows. Don't edit the generated files: the next run overwrites them. For a one-off sketch, copy the `.excalidraw` file under another name.
- `test/unit/architecture-diagram.test.js` fails when the diagram falls behind the code: a source file without an entry, a new `require`, or a function or event named in a storyboard that no longer exists. Add or fix the entry in the spec, then run `npm run diagram`.
- A new file goes in its zone's `rows`. Its `incoming` rule decides how requires of it are drawn: arrows (default), `listed` under "uses" in the requiring files' boxes (for widely shared modules), or arrows only from the files named.

## Simulator and local Node-RED

```powershell
npm run sim                     # a 10v20 replica on 127.0.0.1:5020
npm run sim -- --list           # profiles (Gen-2 and Gen-1 replicas of the bench units)
npm run dev                     # Node-RED on http://127.0.0.1:1880 with this package linked, simulators on 5020-5022
```

The simulator follows the behaviour measured on hardware (see `docs/register-map.md`): command sampling every device cycle, a write runs only if it differs from the previous one on the same interface, idle connections dropped after 20 s, one connection at a time by default.

## Bench hardware

The bench units (see `docs/hardware-validation.md`) have **no process gas connected**, and stay that way unless a test plan says otherwise.

- Hardware tests are read-only by default: `npm run test:hil` with `ALICAT_HIL_HOST` (Gen-2) and/or `ALICAT_HIL_GEN1_HOST` (Gen-1) set. `ALICAT_HIL_WRITE=1` adds write tests; use it only on a unit with no process gas.
- `npm run probe -- <host> …` reads freely; anything that writes needs `--write`. Factory restore, RTU-only and EEPROM-ramp commands are blocked even then.
- Long-running tests (the soak) against real units are read-only.

## Soak test

```powershell
npm run soak -- --hours 24 --real 192.0.2.10
```

20 simulators with fault injection, optional real units read-only, redeploys and stop/starts throughout. Keep the PC plugged in and awake for the whole run (host sleep shows up as violations). Results go to `soak-results/`; record them in `docs/soak-results.md`.

## Commits and releases

One step per commit, each passing `npm run check`, with a message that says what changed and why. Releases follow `docs/release-checklist.md`; the release workflow publishes from a version tag once the package is no longer `private`.
