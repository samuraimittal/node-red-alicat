'use strict';

const { DeviceModel } = require('./DeviceModel');
const { ModbusTcpServer } = require('./ModbusTcpServer');
const { CommandEngine } = require('./CommandEngine');
const { buildGen2, MFC_10V20, BENCH_10V20 } = require('./profiles/gen2');
const { buildGen1, BENCH_9V07 } = require('./profiles/gen1');

/** @param {Record<string, {min: number, max: number}>} info */
const ranges = (info) => Object.fromEntries(Object.entries(info).map(([k, v]) => [k, { min: v.min, max: v.max }]));

/**
 * @type {Record<string, {
 *   description: string,
 *   model: ConstructorParameters<typeof DeviceModel>[0],
 *   build: (model: InstanceType<typeof DeviceModel>, options: {serial?: number | undefined, undefinedValue?: number | null}) =>
 *          {bank: any, refresh: () => void, refreshInfo: () => void, generation: number},
 *   engine: {extended: boolean, query43: boolean},
 *   ignoreUnitIds?: number[]
 * }>}
 */
const PROFILES = {
    '10v20-mfc': {
        description: 'Gen-2 mass flow controller, firmware 10v20.0, 0–20 SLPM N2, mass-flow control',
        model: { controlVariable: 'massFlow', gas: 8, flowFullScale: 20, setpointRanges: ranges(MFC_10V20.setpointInfo) },
        build: (model, options) => buildGen2(model, MFC_10V20, options),
        engine: { extended: true, query43: true }
    },
    '10v20-bench': {
        description: 'Replica of a 10v20 bench unit: 10v20.0, ±2000 SCCM, 7-slot frame, valve-drive control, dual valve',
        model: {
            controlVariable: 'valveDrive', gas: 0, flowFullScale: 2000, dualValve: true,
            setpointRanges: ranges(BENCH_10V20.setpointInfo), gains: { P: 5000, D: 0, I: 250 }, state: { barometricPressure: 14.8 }
        },
        build: (model, options) => buildGen2(model, BENCH_10V20, { ...options, serial: options.serial ?? 123456 }),
        engine: { extended: true, query43: true }
    },
    '9v07-bench': {
        description: 'Replica of bench unit 2: Gen-1 firmware 9v07, 7-slot frame, limited commands only, ignores unit ID 255',
        model: {
            controlVariable: 'massFlow', gas: 0, flowFullScale: 2000, dualValve: false, gains: { P: 720, D: 610, I: 250 },
            setpointRanges: {
                massFlow: { min: -2000, max: 2000 }, volumetricFlow: { min: -2, max: 2 }, valveDrive: { min: -100, max: 100 },
                gaugePressure: { min: -15, max: 160 }, absolutePressure: { min: 0, max: 160 }
            },
            state: { setpoint: 12.5, barometricPressure: 14.77 }
        },
        build: (model, options) => buildGen1(model, BENCH_9V07, options),
        engine: { extended: false, query43: false },
        ignoreUnitIds: [255]
    }
};

/**
 * A simulated Alicat instrument on Modbus TCP: process model + register map +
 * command engine + server. One instance = one device = one IP:port, as on
 * native Ethernet. It accepts a single connection by default (stricter than
 * the ≥9 a real 10v20 accepts), so tests catch socket collisions.
 */
class AlicatSimulator {
    /**
     * @param {{profile?: string, maxConnections?: number, clock?: () => number, idleTimeoutMs?: number,
     *          tauMs?: number, undefinedValue?: number | null, serial?: number, commandCycleMs?: number}} [options]
     */
    constructor(options = {}) {
        const name = options.profile || '10v20-mfc';
        const profile = PROFILES[name];
        if (!profile) {
            throw new Error(`Unknown simulator profile "${name}". Known: ${Object.keys(PROFILES).join(', ')}`);
        }
        this.profileName = name;
        this.model = new DeviceModel({ ...profile.model, clock: options.clock, tauMs: options.tauMs });
        this.map = profile.build(this.model, { undefinedValue: options.undefinedValue ?? null, serial: options.serial });
        const { bank, refresh } = this.map;
        this.bank = bank;
        this.engine = new CommandEngine({
            bank,
            model: this.model,
            extended: profile.engine.extended,
            query43: profile.engine.query43,
            cycleMs: options.commandCycleMs,
            onLoopChange: this.map.refreshInfo,
            clock: options.clock
        });
        this.server = new ModbusTcpServer({
            registers: bank,
            maxConnections: options.maxConnections ?? 1,
            idleTimeoutMs: options.idleTimeoutMs ?? 0,
            ignoreUnitIds: profile.ignoreUnitIds,
            beforeRequest: refresh
        });
        this.faults = this.server.faults;
        this.host = '127.0.0.1';
        this.port = 0;
    }

    /**
     * @param {number} [port] 0 = ephemeral
     * @param {string} [host]
     */
    async start(port = 0, host = '127.0.0.1') {
        this.host = host;
        this.port = await this.server.listen(port, host);
        this.engine.start();
        return this;
    }

    stop() {
        this.engine.stop();
        return this.server.close();
    }

    get stats() {
        return this.server.stats;
    }

    static get profiles() {
        return Object.fromEntries(Object.entries(PROFILES).map(([k, v]) => [k, v.description]));
    }
}

module.exports = { AlicatSimulator };
