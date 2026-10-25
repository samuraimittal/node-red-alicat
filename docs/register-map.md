# Alicat Modbus TCP register map (as used by this package)

Sources:
- the Alicat Modbus manual, Rev 7 (Nov 2024);
- the legacy Modbus RTU manual;
- measurements on a 10v20.0 and a 9v07 instrument ([hardware-validation.md](hardware-validation.md)).

Where the hardware disagreed with the manual, this document follows the hardware, and says so. The constants are in [`lib/alicat/registers.js`](../lib/alicat/registers.js).

## Wire conventions

| Rule | Detail |
|---|---|
| Numbering | Register **numbers** are 1-based, as in the manual. The address on the wire is number − 1 (`toAddress()` is the only conversion). |
| Reads | **FC04** (input registers) only. On 10v20, FC03 maps differently (register 1200 gives exception 02). |
| Writes | **FC16** only, one frame per value. A 32-bit value is never split across two writes. |
| Encoding | Big-endian words and bytes (ABCD). Float32 is IEEE 754. |
| Invalid values | Float `0xFFFFFFFF` and int32 `−2147483648` decode to `null`. A reading the instrument doesn't have reads as NaN (also `null`). |
| Block size | FC04 accepts 125 registers per request (10v20). |
| Unit ID | Ignored by native-Ethernet 10v20 (any ID answers). 9v07 doesn't answer 255. Use 1. |
| Idle timeout | Connections idle for about 20 s are closed by the instrument. |
| RTU-only registers | 21–24, 46, 65, 2041–2059: never used over TCP. |

## Generations

| Generation | Firmware | Live data | Setpoint | Commands | Metadata |
|---|---|---|---|---|---|
| Gen-1 "data frame" | 6v17 – 10v06 | 1200 gas, 1201–1202 status, float slots from 1203. A slot past the end gives exception 02. | 1010–1011, write-only | Limited (1000–1001) | None |
| Gen-2 | 10v07+ | Standard block 1346–1371 | 1010–1011 and 1350–1351, read/write | Limited and extended (1002–1009) | Info blocks 1640–1771, firmware 1090–1093 |
| Gen-2b | 10v19+ | As Gen-2 | As Gen-2 | Adds 43 (loop variable with query), 80 (totalizer 1/2 reset) | Self-test 1086–1089, serial 1094–1095, dates 1096–1099 |

## Device information (Gen-2)

| Register | Content |
|---|---|
| 1086–1087 | Scratch register (10v19+) |
| 1088–1089 | Fixed value `0x3F9E064B` = 1.234567 (10v19+). A different value means another word order: identification fails with `EIDENTIFY`. |
| 1090–1093 | Firmware major, minor, custom, internal. `10, 20, 0, 0` = 10v20.0. Gen-1 gives exception 02 or `0xFFFF`. |
| 1094–1095 | Serial number, u32 (10v19+) |
| 1096 / 1097 | Manufacture date: `month << 8 | day`, then year |
| 1098 / 1099 | Calibration date, same format |

## Live data

### Gen-2 standard block (1346–1371, one read)

| Register | Key | Type | Info block |
|---|---|---|---|
| 1346 | alarms (bit 0 alarm 1, bit 1 alarm 2) | u16 | |
| 1347 | gas number | u16 | |
| 1348–1349 | status bits | u32 | |
| 1350–1351 | setpoint (read/write) | f32 | 1640 |
| 1352–1353 | valve drive | f32 | 1652 |
| 1354–1355 | primary pressure | f32 | 1664 |
| 1356–1357 | secondary pressure | f32 | 1676 |
| 1358–1359 | barometric pressure | f32 | 1688 |
| 1360–1361 | temperature | f32 | 1700 |
| 1362–1363 | volumetric flow | f32 | 1712 |
| 1364–1365 | mass flow | f32 | 1724 |
| 1366–1367 | totalizer 1 | f32 | 1736 |
| 1368–1369 | totalizer 2 | f32 | 1748 |
| 1370–1371 | humidity | f32 | 1760 |

Output keys follow each reading's **statistic type** from its info block, not its position. On a 10v20 unit, the primary pressure is type 6 → `gaugePressure` and the secondary is `absolutePressure`. Readings with info type 0 or 1 ("none") are left out.

**Info blocks** (12 registers each, from the block start):

| Offset | Content |
|---|---|
| +0 | Statistic type (Appendix A) |
| +1 | Source (Appendix C) |
| +2–3 / +4–5 | Minimum / maximum, i32 |
| +6–7 / +8–9 | Minimum / maximum, f32 |
| +10 | Units code (Appendix B; the meaning depends on the category, e.g. 7 = SLPM for flow but bar for pressure) |
| +11 | Displayed decimal places |

### Gen-1 data frame (1200 … 1202 + 2N)

1200 is the gas number, 1201–1202 the status, then N float slots from 1203 in the order of the instrument's data frame. The firmware doesn't describe the slots, so the layout comes from the device configuration:

| Preset | Slots |
|---|---|
| `extended-7` | absolute pressure, gauge pressure, barometric pressure, temperature, volumetric flow, mass flow, setpoint (both bench units and the production frame) |
| `mfc` / `mfc-totalizer` | pressure, temperature, volumetric flow, mass flow, setpoint (+ totalizer) |
| `mfm` / `mfm-totalizer` | pressure, temperature, volumetric flow, mass flow (+ totalizer) |
| `pc` | pressure, setpoint |
| `pg` | pressure |

Identification probes the slots until exception 02 and checks that the count matches the layout.

## Status bits (1201–1202 / 1348–1349)

| Bit | Value | Key | Notes |
|---|---|---|---|
| 0, 1 | 1, 2 | temperatureOverrange, temperatureUnderrange | |
| 2, 3 | 4, 8 | volumetricFlowOverrange, volumetricFlowUnderrange | |
| 4, 5 | 16, 32 | massFlowOverrange, massFlowUnderrange | |
| 6 | 64 | pressureOverrange | |
| 7 | 128 | totalizerAtMax | |
| 8 | 256 | **holding** | Set within about 125 ms of a valve hold (10v20, 9v07) |
| 9 | 512 | hardwareError | |
| 10 | 1024 | **exhausting** | Verified on 10v20: set by command 6,3 and cleared by 6,0. The Rev 7 manual's "pressure over user limit" is wrong for this firmware. |
| 11 | 2048 | Gen-2: flowOverrangeWhileTotalizing · Gen-1: overPressureLimit | Not yet verified on hardware |
| 12, 13 | | Gen-1: flowOverrangeWhileTotalizing, measurementAborted | Not yet verified on hardware |

`raw` is always reported. Unexpected bits are listed in `unknownBits`.

## Setpoint and control variable

The setpoint is written as float32 to **1010–1011** on every generation. It is read back from 1350–1351 on Gen-2, and from the data-frame setpoint slot on Gen-1, where 1010 is write-only (exception 02).

Its meaning depends on the loop control variable:

| Variable | Argument to command 11 / 43 | Setpoint info type |
|---|---|---|
| massFlow | 0 | 37 |
| volumetricFlow | 1 | 36 |
| differentialPressure | 2 | 39 (refused by 9v07 without that sensor) |
| absolutePressure | 3 | 34 |
| gaugePressure | 4 | 38 |
| valveDrive | 45 (Appendix A code; command 11 accepts it from 8v24, verified on 9v07) | 45 |

Gen-2 reports the current variable through the setpoint info type, and 10v19+ also answers command 43 with argument 65535 (query). Gen-1 can't report it.

## Command interface

| Register | Interface | Write | Read |
|---|---|---|---|
| 1000 | Limited (all firmware) | Command ID (u16) | Last **completed** command ID |
| 1001 | Limited | Argument (u16) | **Result**, not an echo: ≤ 32767 is a return value; ≥ 0x8001 is an error, status = value − 0x8000 + 1 (0x8001 invalid ID, 0x8002 invalid argument, 0x8003 unsupported; 0x8002 seen on 9v07) |
| 1002–1003 | Extended (10v07+) | Command ID (u32) | Command running or last run |
| 1004–1005 | Extended | Argument (i32, u32 or f32) | Argument echo |
| 1006–1007 | Extended | | Status: 0 success, 1 in progress, 2 invalid ID, 3 invalid argument, 4 unsupported, 5–7 mix errors |
| 1008–1009 | Extended | | Return value (i32 or f32) |

Measured behaviour (10v20 unless noted):
- **Change detection:** a write runs only if it differs from the **previous write on the same interface**. The previous write can't be read back, so every command is preceded by a NOP.
- The instrument samples the command registers every **110–125 ms**.
- The echo registers are **shared** between the limited and extended interfaces, and between all masters.
- A NOP resets the echo. ID and argument are taken from one FC16 frame.
- A command written while another is running is **queued** and runs after it; it doesn't interrupt. While an extended command runs, 1000 shows the last completed command.
- 9v07 once dropped a command sent less than 200 ms after the NOP. The library now waits at least 200 ms.

## Commands used

| Command | ID / argument | Firmware | Confirmed by |
|---|---|---|---|
| Select gas | 1 / gas number | 6v17 | Reading the gas back |
| Tare flow / absolute / gauge pressure | 4 / 2 · 1 · 0 | 6v17 | Echo |
| Reset totalizer | 5 (totalizer 1, 7v05+); 80 / 1 · 2 (10v19+) | 7v05 | Echo |
| Valve: resume / hold closed / hold current / exhaust | 6 / 0 · 1 · 2 · 3 | 6v17.1 | Status bit 8 or 10 |
| Front-panel lock / unlock | 7 / 1 · 0 | | Echo |
| P / D / I gain | 8 / 9 / 10, 0–65535 | 6v17 (I: 7v05) | Read back with 14 |
| Read gain | 14 / 0 P · 1 D · 2 I | 7v08 | |
| Loop variable | 11 (or 43 on 10v19+) | 7v05 | Setpoint info type (Gen-2) |
| Save power-up setpoint | 12 | 7v05 | Echo (writes EEPROM) |
| Loop algorithm | 13 / 1 PD/PDF · 2 PD²I | 7v08 | Write-only |

Never sent, even as raw commands: 26 (factory restore), 32765 and 32767 (RTU only), 65546 (EEPROM ramp setting).

## PID semantics

Over Modbus TCP there are no gain registers; gains are commands 8–10 and 14. In Alicat's default **PD/PDF** algorithm the *D* gain acts like a classical proportional term and the *P* gain like an integral term. In **PD²I** they behave classically.
