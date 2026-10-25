# Security

## Reporting a vulnerability

Please report suspected vulnerabilities **privately** to the maintainers, not in a public issue. Once the repository is public, use the repository's private vulnerability reporting. Include the package version, Node-RED and Node.js versions, and steps to reproduce. You will get an acknowledgement, and a fix or mitigation plan once the report is confirmed.

Only the latest release receives fixes during the 0.x series.

## What this package does on the network

- It connects **only** to the instrument addresses you configure, on Modbus TCP (normally port 502). It makes no other outbound connections.
- It has **no runtime dependencies**, so the installed code is only what is in this package.
- It stores **no credentials**. Device configurations hold addresses, ports and timing settings only.
- It adds three editor endpoints under the Node-RED admin API:
  - `POST /alicat-modbus/probe` (the **Test connection** button) connects to an address given in the request. It requires the `alicat-device.write` permission. It reuses the live connection if there is one, and never writes to the instrument. To keep it from being used to probe other services, it only opens new connections to port 502, unless more ports are listed in `settings.js` (`alicatModbus: {probePorts: [5020]}`). At most two tests run at once, and a test's own connection is closed as soon as it finishes.
  - `GET /alicat-modbus/gases` and `GET /alicat-modbus/meta` return static lookup tables.
- **Frame trace** (off by default) logs every Modbus frame, which includes process values. Treat those logs as operational data.

## Deploying in an OT network

Modbus TCP has **no authentication and no encryption**. Anyone who can reach an instrument's port 502 can change its setpoint, valve state and gains. Protect the network path and the Node-RED editor. Check the points below against your site's OT security policy with the network and OT-safety owners:

1. **Segment the instruments.** Put them on an isolated control network or VLAN, and allow port 502 only from the Node-RED host. Don't route that network to office or internet segments.
2. **Use private addressing.** Use RFC 1918 or link-local ranges for instrument networks. The *Test connection* result warns when an address is not private (for example `172.168.x.x`, which is public address space; the private range is `172.16.0.0/12`).
3. **Lock down the Node-RED editor.** Enable `adminAuth` in `settings.js`, serve the editor over HTTPS or bind it to `localhost`, and give read-only users a role without `alicat-device.write` (and without `flows.write`), so they can't run probes or change control flows.
4. **One master per instrument.** The command registers are shared by every Modbus master. Don't let a PLC, an HMI and Node-RED send commands to the same instrument; the library warns when it sees another master's commands.
5. **Raw commands are off by default.** The command node only sends raw command IDs when *Allow raw commands* is ticked. Even then, factory restore (26), RTU-only commands (32765, 32767) and EEPROM ramp settings (65546) are always refused.
6. **Node-RED is not a safety system.** On deploy, stop and shutdown the library leaves the instrument as it is: setpoint, mode and valve state don't change. Alicat's communications watchdog is not available over Modbus TCP. Use independent interlocks for anything that must fail safe, and an explicit safe-state sequence at the end of a test (example 06).
7. **Keep EEPROM writes rare.** *Save as power-up setpoint* (command 12) writes non-volatile memory. Don't trigger it from a loop.
