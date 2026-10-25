#!/usr/bin/env node
'use strict';

// Bench probe for Gate 0 hardware validation. Register numbers are 1-based, as in
// the Alicat manual. Reads use FC04; writes always use FC16 (Alicat has no FC06)
// and require --write.
//
//   npm run probe -- <host> info
//   npm run probe -- <host> read <register> [count] [--as u16|u32|i32|f32]
//   npm run probe -- <host> watch <register> [count] [--as …] [--interval 100] [--duration 5000]
//   npm run probe -- <host> status
//   npm run probe -- <host> write <register> <value> [value …] --write
//   npm run probe -- <host> command <id> <arg> --write [--extended] [--duration 5000] [--interval 100]
//   npm run probe -- <host> idle [--minutes 5]
//
// Options: --port 502  --unit 1  --timeout 1500

const { ModbusTcpTransport } = require('../lib/modbus/ModbusTcpTransport');
const pdu = require('../lib/modbus/pdu');
const codec = require('../lib/alicat/codec');
const firmware = require('../lib/alicat/firmware');
const { REG, BLOCKS, toAddress } = require('../lib/alicat/registers');
const { statusName, assertRawCommand } = require('../lib/alicat/commands');
const { BITS } = require('../lib/alicat/status-bits');
const { codeOf } = require('../lib/errors');
const { sleep } = require('../lib/util/timers');
const { parseCli, numberOption, choiceOption, usage } = require('./cli');

/**
 * What every action gets.
 * @typedef {{
 *   transport: InstanceType<typeof ModbusTcpTransport>,
 *   read: (register: number, count: number) => Promise<number[]>,
 *   write: (register: number, values: number[]) => Promise<unknown>,
 *   requireWrite: () => void,
 *   args: string[],
 *   as: string, interval: number, duration: number, minutes: number, extended: boolean
 * }} Probe
 */

const OPTIONS = /** @type {const} */ ({
    port: { type: 'string' }, unit: { type: 'string' }, timeout: { type: 'string' }, as: { type: 'string' },
    interval: { type: 'string' }, duration: { type: 'string' }, minutes: { type: 'string' },
    write: { type: 'boolean' }, extended: { type: 'boolean' }, help: { type: 'boolean' }
});

/** @param {string | undefined} text @param {string} name @param {number} [min] @param {number} [max] */
function int(text, name, min = -Infinity, max = Infinity) {
    const value = Number(text);
    if (text === undefined || text.trim() === '' || !Number.isInteger(value) || value < min || value > max) {
        throw new Error(`${name} must be an integer${Number.isFinite(min) ? ` from ${min} to ${max}` : ''}, got ${String(text)}`);
    }
    return value;
}

/** @param {unknown} err */
function describeError(err) {
    const e = /** @type {{exceptionCode?: number, exceptionName?: string, message?: string}} */ (err);
    return codeOf(err) === 'EMODBUS' ? `Modbus exception ${e.exceptionCode} (${e.exceptionName})` : `${codeOf(err) || 'ERROR'}: ${e.message}`;
}

/** @param {number} bits */
function describeStatus(bits) {
    const set = [];
    for (let b = 0; b < 32; b++) {
        if (bits & (1 << b)) set.push(b);
    }
    if (set.length === 0) return '0x00000000 (no bits set)';
    const names = set.map((b) => `bit ${b} [Gen-2: ${BITS.gen2[b] || 'reserved'} | Gen-1: ${BITS.gen1[b] || 'reserved'}]`);
    return `0x${(bits >>> 0).toString(16).padStart(8, '0')} → ${names.join(', ')}`;
}

/** @param {number[]} words @param {string} as */
function format(words, as) {
    if (as === 'u16') {
        return words.map((w) => `${w} (0x${w.toString(16).padStart(4, '0')})`).join('  ');
    }
    const decode = as === 'f32' ? codec.f32 : as === 'u32' ? codec.u32 : codec.i32;
    const out = [];
    for (let i = 0; i + 1 < words.length; i += 2) out.push(String(decode(words, i)));
    return out.join('  ');
}

/** "YYYY-MM-DD" from Alicat's month/day and year registers. @param {number} monthDay @param {number} year */
const date = (monthDay, year) => `${year}-${String(monthDay >> 8).padStart(2, '0')}-${String(monthDay & 0xFF).padStart(2, '0')}`;

/** @param {Probe} p */
async function info(p) {
    try {
        const fw = await p.read(BLOCKS.FIRMWARE.start, 4);
        if (firmware.isPlausibleGen2(fw)) {
            console.log(`Generation : Gen-2 (firmware ${firmware.fromRegisters(fw).text}, raw ${fw.join(',')})`);
        } else {
            console.log(firmware.looksUndefined(fw) ? 'Generation : Gen-1 likely (1090–1093 read 0xFFFF)' : `Generation : UNEXPECTED firmware registers ${fw.join(',')}`);
        }
        if (firmware.isPlausibleGen2(fw) && firmware.supports(firmware.fromRegisters(fw), 'testRegisters')) {
            const test = await p.read(REG.TEST_FIXED, 2);
            console.log(`Word order : ${codec.detectWordOrder(test) || 'UNKNOWN'} (1088–1089 = ${format(test, 'u16')})`);
            const dev = await p.read(BLOCKS.DEVICE_INFO.start, BLOCKS.DEVICE_INFO.quantity);
            console.log(`Serial     : ${codec.u32(dev, 0)}`);
            console.log(`Made       : ${date(codec.u16(dev, 2), codec.u16(dev, 3))}`);
            console.log(`Calibrated : ${date(codec.u16(dev, 4), codec.u16(dev, 5))}`);
        }
    } catch (err) {
        console.log(`Generation : Gen-1 likely (1090–1093 → ${describeError(err)})`);
    }
    const header = await p.read(REG.OPT_GAS, 3);
    console.log(`Gas number : ${codec.u16(header, 0)}`);
    console.log(`Status     : ${describeStatus(codec.u32(header, 1))}`);
    /** @type {(number | null)[]} */
    const values = [];
    for (let n = 1; n <= 20; n++) {
        try {
            values.push(codec.f32(await p.read(REG.OPT_READING_BASE + (n - 1) * 2, 2), 0));
        } catch (err) {
            console.log(`Data frame : ${values.length} slot(s) before ${describeError(err)}`);
            break;
        }
    }
    values.forEach((v, i) => console.log(`  slot ${i + 1} (reg ${REG.OPT_READING_BASE + i * 2}): ${v}`));
}

/** @param {Probe} p */
async function read(p) {
    const register = int(p.args[0], 'register', 1, 65536);
    const count = p.args[1] ? int(p.args[1], 'count', 1, 125) : 1;
    console.log(`${register}…${register + count - 1}: ${format(await p.read(register, count), p.as)}`);
}

/** @param {Probe} p */
async function watch(p) {
    const register = int(p.args[0], 'register', 1, 65536);
    const count = p.args[1] ? int(p.args[1], 'count', 1, 125) : 1;
    const start = Date.now();
    while (Date.now() - start < p.duration) {
        const ms = String(Date.now() - start).padStart(6);
        try {
            console.log(`+${ms} ms  ${format(await p.read(register, count), p.as)}`);
        } catch (err) {
            console.log(`+${ms} ms  ${describeError(err)}`);
        }
        await sleep(p.interval);
    }
}

/** @param {Probe} p */
async function status(p) {
    console.log(`Status: ${describeStatus(codec.u32(await p.read(REG.OPT_STATUS, 2), 0))}`);
}

/** @param {Probe} p */
async function write(p) {
    p.requireWrite();
    const register = int(p.args[0], 'register', 1, 65536);
    const values = p.args.slice(1).map((v, i) => int(v, `value ${i + 1}`, 0, 0xFFFF));
    if (values.length === 0 || values.length > 123) throw new Error('write needs 1 to 123 register values');
    await p.write(register, values);
    console.log(`FC16 wrote ${values.join(', ')} to ${register}…${register + values.length - 1}`);
}

/**
 * The command echo and the hold/exhaust bits, for logging.
 * @param {Probe} p
 */
async function commandEcho(p) {
    const cmd = await p.read(p.extended ? REG.EXT_COMMAND_ID : REG.LIMITED_COMMAND_ID, p.extended ? 8 : 2);
    const bits = codec.u32(await p.read(REG.OPT_STATUS, 2), 0);
    const result = p.extended ? 0 : codec.u16(cmd, 1);
    const echo = p.extended
        ? `id ${codec.u32(cmd, 0)} arg ${codec.i32(cmd, 2)} status ${codec.u32(cmd, 4)} return ${codec.i32(cmd, 6)}`
        : `1000=${codec.u16(cmd, 0)} 1001=${result}${result >= 32769 ? ` (ERROR ${statusName(result - 0x8000 + 1)})` : ''}`;
    return { first: p.extended ? codec.u32(cmd, 0) : codec.u16(cmd, 0), text: `${echo} | HLD=${(bits >> 8) & 1} bit10=${(bits >> 10) & 1}` };
}

/** @param {Probe} p */
async function command(p) {
    p.requireWrite();
    const { extended } = p;
    const id = int(p.args[0], 'command id', 0, extended ? 0xFFFFFFFF : 0xFFFF);
    const arg = int(p.args[1], 'argument', extended ? -0x80000000 : 0, extended ? 0xFFFFFFFF : 0xFFFF);
    assertRawCommand(id, arg); // the library's blocked commands (factory restore, RTU-only, EEPROM ramp)
    const reg = extended ? REG.EXT_COMMAND_ID : REG.LIMITED_COMMAND_ID;
    const encode = (/** @type {number} */ i, /** @type {number} */ a) => (extended ? [...codec.encodeU32(i), ...codec.encodeU32(a >>> 0)] : [i, a]);
    const start = Date.now();
    const log = (/** @type {string} */ text) => console.log(`+${String(Date.now() - start).padStart(6)} ms  ${text}`);
    const before = await commandEcho(p);
    log(`before      ${before.text}`);
    // Verified on 10v20: the device samples the command registers every ~110–120 ms and only
    // runs a write that differs from the previous write ON THE SAME INTERFACE. A NOP that is
    // not a change never shows in the echo, so wait for the echo to drop to 0 when it can,
    // otherwise let 300 ms (≥ 2 device cycles) pass before writing the command.
    await p.write(reg, encode(0, 0));
    const nopAt = Date.now();
    log('wrote NOP (0, 0)');
    for (;;) {
        await sleep(Math.min(p.interval, 100));
        const s = await commandEcho(p);
        log(`after NOP   ${s.text}`);
        if ((before.first !== 0 && s.first === 0) || Date.now() - nopAt >= 300) break;
    }
    await p.write(reg, encode(id, arg));
    log(`wrote command (${id}, ${arg}) on the ${extended ? 'extended' : 'limited'} interface`);
    while (Date.now() - start < p.duration) {
        log(`            ${(await commandEcho(p)).text}`);
        await sleep(p.interval);
    }
}

/** Does the device drop an idle connection, and after how long? @param {Probe} p */
async function idle(p) {
    const start = Date.now();
    /** @type {number | null} */
    let droppedAt = null;
    p.transport.on('down', (err) => {
        if (codeOf(err) === 'ECANCELED') return; // our own close at the end of the run
        droppedAt = Date.now();
        console.log(`Device closed the connection after ${((droppedAt - start) / 1000).toFixed(1)} s idle (${codeOf(err)})`);
    });
    await p.read(REG.OPT_GAS, 1);
    console.log(`Connected; staying idle for ${p.minutes} min (Ctrl+C to stop)…`);
    while (Date.now() - start < p.minutes * 60000 && droppedAt === null) {
        await sleep(1000);
        const elapsed = Math.round((Date.now() - start) / 1000);
        if (elapsed % 60 === 0) console.log(`  ${elapsed / 60} min idle, connection ${p.transport.isOpen ? 'open' : 'closed'}`);
    }
    if (droppedAt === null) {
        await p.read(REG.OPT_GAS, 1);
        console.log(`Still open after ${p.minutes} min idle; a read succeeded.`);
    }
}

/** @type {Readonly<Record<string, (p: Probe) => Promise<void>>>} */
const ACTIONS = Object.freeze({ info, read, watch, status, write, command, idle });

async function main() {
    const { values: flags, positionals } = parseCli(process.argv.slice(2), OPTIONS);
    const [host, action, ...args] = positionals;
    if (flags.help) {
        console.log(usage(__filename));
        return;
    }
    if (!host || !action) {
        console.error(usage(__filename));
        process.exitCode = 1;
        return;
    }
    const run = Object.hasOwn(ACTIONS, action) ? ACTIONS[action] : undefined;
    if (!run) throw new Error(`Unknown action "${action}". Use ${Object.keys(ACTIONS).join(', ')}.`);
    const port = numberOption(flags, 'port', { fallback: 502, min: 1, max: 65535 });
    const unit = numberOption(flags, 'unit', { fallback: 1, min: 0, max: 255 });
    const timeout = numberOption(flags, 'timeout', { fallback: 1500, min: 50, max: 60000 });
    const transport = new ModbusTcpTransport({ host, port });
    /** @type {Probe} */
    const probe = {
        transport,
        read: async (register, count) => (await transport.send(unit, pdu.buildReadInputRegisters(toAddress(register), count), timeout)).registers,
        write: (register, values) => transport.send(unit, pdu.buildWriteMultipleRegisters(toAddress(register), values), timeout),
        requireWrite: () => {
            if (!flags.write) throw new Error('This changes the device. Re-run with --write once the unit is on the bench with no process gas.');
        },
        args,
        as: choiceOption(flags, 'as', 'u16', ['u16', 'u32', 'i32', 'f32']),
        // At least 20 ms between polls: the instrument's documented request rate is about 50 Hz.
        interval: numberOption(flags, 'interval', { fallback: 100, min: 20, max: 60000 }),
        duration: numberOption(flags, 'duration', { fallback: 5000, min: 0, max: 86400000 }),
        minutes: numberOption(flags, 'minutes', { fallback: 5, min: 0, max: 1440, integer: false }),
        extended: Boolean(flags.extended)
    };
    try {
        await transport.connect();
    } catch (err) {
        throw new Error(`Cannot connect to ${host}:${port} — ${describeError(err)}`, { cause: err });
    }
    try {
        await run(probe);
    } finally {
        await transport.close();
    }
}

main().catch((err) => {
    console.error(`[probe] ${err.message}`);
    process.exit(1);
});
