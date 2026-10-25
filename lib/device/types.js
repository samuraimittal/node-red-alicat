'use strict';

/**
 * Types shared by AlicatDevice and its parts in lib/device/. Typedefs only.
 *
 * Settings:
 * @typedef {{
 *   mapMode: string, deviceType: string, layout: string | string[] | null, controlVariable: string,
 *   unitLabels: Record<string, string>, setpointLimits: Record<string, {min: number, max: number}>,
 *   refreshMs: number, identifyRetryMs: number, reidentifyMinMs: number, minPollMs: number, effectTimeoutMs: number
 * }} DeviceSettings
 *   All resolved. A configuration supplies a DeviceSettingsUpdate, checked by validateSettings().
 * @typedef {{[K in keyof DeviceSettings]?: DeviceSettings[K] | undefined}} DeviceSettingsUpdate
 * @typedef {DeviceSettingsUpdate & {unitId?: number | undefined, lane?: import('../CommandLane').LaneTimings | undefined}} DeviceOptions
 *
 * Identity (what identification found), narrowed on `generation`:
 * @typedef {{
 *   key: string, slot: string | number, type?: number, category: string, reference: string | null,
 *   units: string, unitsCode?: number, decimals: number | null, min: number | null, max: number | null, register: number
 * }} ReadingInfo
 * @typedef {{
 *   serial: number | null, manufactured: string | null, calibrated: string | null,
 *   controlledVariable: string | null, readings: ReadingInfo[],
 *   liveBlock: {start: number, quantity: number}, unitId: number
 * }} IdentityBase
 * @typedef {IdentityBase & {
 *   generation: 'gen2', firmware: string, extendedCommands: true, setpointReadable: true,
 *   setpointType: number, layout: 'standard'
 * }} Gen2Identity
 *   10v07 and newer: everything is read from the device.
 * @typedef {IdentityBase & {
 *   generation: 'gen1', firmware: null, extendedCommands: false, setpointReadable: boolean,
 *   setpointType: null, layout: string[]
 * }} Gen1Identity
 *   6v17–10v06: the layout comes from the configuration; no firmware, serial or dates.
 * @typedef {Gen1Identity | Gen2Identity} Identity
 *
 * Live data:
 * @typedef {ReturnType<typeof import('../alicat/status-bits').decodeStatus>} Status
 * @typedef {{
 *   values: Record<string, number | null>, setpoint: number | null, controlledVariable: string | null,
 *   gas: {number: number, symbol: string, name: string},
 *   status: Status, alarms: ReturnType<typeof import('../alicat/status-bits').decodeAlarms> | null,
 *   units: Record<string, string>, ts: number, quality: 'good' | 'stale' | 'offline', ageMs: number,
 *   rttMs: number | null, generation: 'gen1' | 'gen2', firmware: string | null, error?: {code: string, message: string}
 * }} Snapshot
 *
 * State and events:
 * @typedef {'IDLE' | 'IDENTIFYING' | 'READY' | 'FAILED' | 'CLOSED'} DeviceState
 * @typedef {{
 *   identity: [event: {identity: Identity, changed: boolean, metadataChanged?: boolean}],
 *   state: [state: DeviceState],
 *   warning: [message: string]
 * }} DeviceEvents
 *
 * Results:
 * @typedef {'resume' | 'holdClosed' | 'holdCurrent' | 'exhaust'} ValveAction
 * @typedef {import('../CommandLane').CommandResult} CommandResult
 * @typedef {{
 *   requested: number, written: number, variable: string | null, units: string, actual: number | null,
 *   clamped: boolean, verified: boolean, superseded?: boolean,
 *   outcome: 'executed' | 'accepted' | 'unknown' | 'not-sent'
 * }} SetpointResult
 *   `written` is `requested` clamped to the range (when allowed); `verified`: the read-back matched.
 * @typedef {{
 *   variable: string, previous: string | null, outcome: 'accepted' | 'executed', bumpless: boolean,
 *   command: CommandResult, setpoint: SetpointResult | null
 * }} SwitchResult
 * @typedef {CommandResult & {effect: boolean, fallback?: string | null}} ValveResult
 *   `effect`: the status bits confirmed the valve state; `fallback`: what was done while queued behind a running command.
 * @typedef {CommandResult & {gas: {number: number, symbol: string, name: string}}} GasResult
 * @typedef {{p: number | null, d: number | null, i: number | null}} PidGains
 *
 * What the setpoint and command helpers may use of their device. AlicatDevice
 * builds it once, so they never reach into the rest of its state.
 * @typedef {{
 *   client: InstanceType<typeof import('../AlicatClient').AlicatClient>,
 *   lane: InstanceType<typeof import('../CommandLane').CommandLane>,
 *   unitId: number,
 *   ready(): Promise<Identity>,
 *   identity(): Identity | null,
 *   settings(): DeviceSettings,
 *   refreshMetadata(): Promise<Identity | null>,
 *   declareVariable(variable: string): void,
 *   nextSetpointSeq(): number,
 *   setpointSeq(): number,
 *   warn(message: string): void
 * }} DeviceHost
 */

module.exports = {};
