'use strict';

/**
 * Types for the Node-RED side of the package. Node-RED ships no type
 * definitions, so these describe the part of its runtime API the nodes use.
 * Typedefs only.
 *
 * Messages and node settings:
 * @typedef {{[key: string]: unknown, payload?: unknown, topic?: unknown, alicat?: unknown}} NodeMessage
 * @typedef {(msg: NodeMessage | null) => void} SendFn
 * @typedef {(err?: unknown) => void} DoneFn
 * @typedef {{fill?: string, shape?: string, text?: string}} StatusObject  `{}` clears the status.
 * @typedef {{[key: string]: unknown, id: string, type: string, name?: string, z?: string}} NodeConfig
 *   A node's settings as saved by the editor. Numeric fields may arrive as strings
 *   (flows imported through the Admin API, or edited by hand), so nodes parse them.
 *
 * The runtime objects:
 * @typedef {{
 *   get(key: string, store?: string): unknown,
 *   set(key: string, value: unknown, store?: string): void
 * }} ContextStore
 * @typedef {{
 *   id: string, type: string, name?: string, z?: string,
 *   on(event: 'input', listener: (msg: NodeMessage, send: SendFn, done: DoneFn) => void): void,
 *   on(event: 'close', listener: (removed: boolean, done: () => void) => void): void,
 *   send(msg: NodeMessage | null): void,
 *   status(status: StatusObject): void,
 *   log(message: string): void,
 *   warn(message: string): void,
 *   error(message: string, msg?: NodeMessage): void,
 *   context(): ContextStore & {flow: ContextStore, global: ContextStore}
 * }} NodeRedNode
 * @typedef {{
 *   body?: unknown
 * }} AdminRequest
 * @typedef {{
 *   status(code: number): AdminResponse,
 *   json(body: unknown): void
 * }} AdminResponse
 * @typedef {(req: AdminRequest, res: AdminResponse, next?: () => void) => void | Promise<void>} AdminHandler
 * @typedef {{
 *   get(path: string, ...handlers: AdminHandler[]): void,
 *   post(path: string, ...handlers: AdminHandler[]): void
 * }} AdminApp
 * @typedef {{
 *   nodes: {
 *     createNode(node: object, config: NodeConfig): void,
 *     registerType(type: string, constructor: (this: NodeRedNode, config: NodeConfig) => void): void,
 *     getNode(id: string): unknown
 *   },
 *   util: {
 *     evaluateNodeProperty(value: string, type: string, node: NodeRedNode, msg: NodeMessage,
 *                          callback: (err: Error | null, result: unknown) => void): void
 *   },
 *   events: import('events').EventEmitter,
 *   settings: {alicatModbus?: {probePorts?: unknown}},
 *   httpAdmin?: AdminApp & {[key: symbol]: unknown},
 *   auth: {needsPermission(permission: string): AdminHandler}
 * }} NodeRedRuntime
 *
 * This package's objects:
 * @typedef {{
 *   device: string, host: string, port: number, unitId: number,
 *   generation: 'gen1' | 'gen2' | null, firmware: string | null, serial: number | null
 * }} DeviceMeta
 *   Which instrument a message is about; the start of every msg.alicat.
 * @typedef {NodeRedNode & {
 *   host: string, port: number, unitId: number, problems: string[],
 *   acquire(user: {id: string}): InstanceType<typeof import('../ConnectionRegistry').Lease>,
 *   release(user: {id: string}): void
 * }} AlicatDeviceConfigNode
 *   An alicat-device config node, as the nodes that use it see it.
 */

module.exports = {};
