'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { BOUNDS } = require('../../lib/node-red/settings');

const ROOT = path.join(__dirname, '..', '..');
const PACKAGE = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const MODULE = PACKAGE.name;
const TYPES = Object.keys(PACKAGE['node-red'].nodes);
const LOCALES = path.join(ROOT, 'nodes', 'locales', 'en-US');

/**
 * Property names the editor gives its own meaning (Node-RED docs, "Node
 * properties"): every single character (`d` = disabled, `g` = group, `l` =
 * show label, `x`/`y`/`z` = position and tab, ...) plus these.
 */
const RESERVED = new Set(['id', 'type', 'wires', 'inputs', 'outputs']);

/** @param {string} type */
const html = (type) => fs.readFileSync(path.join(ROOT, PACKAGE['node-red'].nodes[type].replace(/\.js$/, '.html')), 'utf8');
/** @param {string} type @returns {Record<string, any>} */
const catalog = (type) => JSON.parse(fs.readFileSync(path.join(LOCALES, `${type}.json`), 'utf8'));
/** @param {string} type */
const template = (type) => {
    const match = new RegExp(`<script type="text/html" data-template-name="${type}">([\\s\\S]*?)</script>`).exec(html(type));
    assert.ok(match, `${type}: no edit template`);
    return match[1];
};

/**
 * Run a node's editor scripts (the resources its HTML loads, in order) with a
 * stub RED and return its definition and the shared helpers.
 * @param {string} type
 */
function editorDefinition(type) {
    /** @type {Record<string, any>} */
    const defs = {};
    const RED = {
        nodes: { registerType: (/** @type {string} */ t, /** @type {any} */ def) => { defs[t] = def; } },
        validators: { typedInput: () => () => true },
        settings: { context: { default: 'memory', stores: ['memory', 'file'] } },
        _: (/** @type {string} */ key) => key
    };
    const window = /** @type {Record<string, any>} */ ({});
    const context = vm.createContext({ RED, window, $: () => ({}) });
    const sources = [...html(type).matchAll(new RegExp(`<script src="resources/${MODULE}/([\\w.-]+\\.js)"></script>`, 'g'))].map((m) => m[1]);
    assert.ok(sources.length > 0, `${type}: loads no editor script`);
    for (const file of sources) {
        vm.runInContext(fs.readFileSync(path.join(ROOT, 'resources', /** @type {string} */ (file)), 'utf8'), context, { filename: file });
    }
    assert.ok(defs[type], `${type}: the scripts did not register the type`);
    return { def: defs[type], editor: window.AlicatEditor };
}

/**
 * Whether a message key exists. `ns:key` names another catalog; a key without
 * a namespace belongs to the node's own.
 * @param {string} type @param {string} key
 */
function hasMessage(type, key) {
    let file = type;
    let name = key;
    if (key.includes(':')) {
        const [ns, rest] = key.split(':');
        if (ns === 'node-red') return ['common.label.name', 'common.label.topic'].includes(/** @type {string} */ (rest));
        file = /** @type {string} */ (ns).replace(`${MODULE}/`, '');
        name = /** @type {string} */ (rest);
    }
    let node = catalog(file);
    for (const part of name.split('.')) {
        if (!node || typeof node !== 'object' || !Object.hasOwn(node, part)) return false;
        node = node[part];
    }
    return typeof node === 'string';
}

describe('editor definitions', () => {
    for (const type of TYPES) {
        describe(type, () => {
            it('uses no property name Node-RED reserves', () => {
                const { def } = editorDefinition(type);
                const names = [...Object.keys(def.defaults || {}), ...Object.keys(def.credentials || {})];
                const clashes = names.filter((n) => n.length === 1 || RESERVED.has(n));
                assert.deepEqual(clashes, [], `${type}: ${clashes.join(', ')} would be overwritten by the editor (e.g. \`d\` marks the node disabled)`);
            });

            it('keeps its help in the locale file only (inline help would win over it)', () => {
                assert.equal(/data-help-name/.test(html(type)), false, 'inline help in the node HTML');
                const help = fs.readFileSync(path.join(LOCALES, `${type}.html`), 'utf8');
                assert.match(help, new RegExp(`<script type="text/markdown" data-help-name="${type}">`));
                assert.equal(/: \*any\* \(any\)/.test(help), false, 'malformed property line');
            });

            it('has every message key its template and scripts use', () => {
                const missing = [];
                for (const [, attr] of template(type).matchAll(/data-i18n="([^"]+)"/g)) {
                    for (const entry of /** @type {string} */ (attr).split(';')) {
                        const key = entry.replace(/^\[[^\]]+\]/, '');
                        if (!hasMessage(type, key)) missing.push(key);
                    }
                }
                const script = fs.readFileSync(path.join(ROOT, 'resources', `${type}.js`), 'utf8');
                for (const [, key] of script.matchAll(/\b_\('([\w.-]+(?::[\w.-]+)?)'[,)]/g)) {
                    if (!hasMessage(type, /** @type {string} */ (key))) missing.push(/** @type {string} */ (key));
                }
                for (const [, key] of script.matchAll(/\bt\('([\w.-]+)'[,)]/g)) {
                    if (!hasMessage(type, `${type}.${key}`)) missing.push(`${type}.${key}`);
                }
                assert.deepEqual(missing, []);
            });

            it('labels its node, palette entry and ports from the catalog', () => {
                const { def } = editorDefinition(type);
                const node = { ...Object.fromEntries(Object.entries(def.defaults).map(([k, v]) => [k, /** @type {any} */ (v).value])), _: (/** @type {string} */ k) => k };
                assert.equal(typeof def.label.call(node), 'string');
                if (def.category === 'config') return;
                for (const fn of [def.paletteLabel, def.inputLabels, def.outputLabels]) {
                    assert.equal(typeof fn, 'function');
                    assert.ok(hasMessage(type, fn.call(node)), `${type}: ${fn.call(node)}`);
                }
            });
        });
    }

    it('the editor and the runtime share one table of ranges', () => {
        const { editor } = editorDefinition('alicat-read');
        assert.deepEqual(JSON.parse(JSON.stringify(editor.BOUNDS)), JSON.parse(JSON.stringify(BOUNDS)));
    });

    it('validates every numeric setting with the same range the runtime enforces, and says why', () => {
        /** @type {Record<keyof typeof BOUNDS, string>} */
        const OWNER = { device: 'alicat-device', read: 'alicat-read', control: 'alicat-control', status: 'alicat-status' };
        for (const [group, table] of Object.entries(BOUNDS)) {
            const type = OWNER[/** @type {keyof typeof BOUNDS} */ (group)];
            const defaults = editorDefinition(type).def.defaults;
            for (const [key, b] of Object.entries(table)) {
                const validate = defaults[key] && defaults[key].validate;
                assert.equal(typeof validate, 'function', `${type}.${key} has no validator`);
                const step = b.integer ? 1 : 0.001;
                for (const ok of [b.min, b.max, b.default, String(b.max)]) assert.equal(validate(ok), true, `${type}.${key} accepts ${ok}`);
                for (const bad of [b.min - step, b.max + step, '', 'x']) assert.equal(validate(bad), false, `${type}.${key} rejects ${JSON.stringify(bad)}`);
                if (b.integer) assert.equal(validate(b.min + 0.5), false, `${type}.${key} rejects a fraction`);
                assert.match(validate(b.max + step, {}), /^@samuraimittal\/node-red-alicat\/alicat-device:alicat\.validation\./, 'a message when asked');
                assert.equal(defaults[key].value, b.default, `${type}.${key}: the editor default matches the runtime default`);
            }
        }
    });

    it('fills the context store list from settings.js, keeping a store that has gone', () => {
        /** @type {{val: string, text: string}[]} */
        const options = [];
        /** @type {string | null} */
        let selected = null;
        const select = { empty: () => { options.length = 0; }, val: (/** @type {string} */ v) => { selected = v; } };
        // Just enough jQuery: $('<option>').val(v).text(t).appendTo(select)
        const $ = () => ({ val: (/** @type {string} */ v) => ({ text: (/** @type {string} */ text) => ({ appendTo: () => options.push({ val: v, text }) }) }) });
        const window = /** @type {Record<string, any>} */ ({});
        const RED = { settings: { context: { default: 'memory', stores: ['memory', 'file'] } }, _: (/** @type {string} */ k) => k };
        vm.runInContext(fs.readFileSync(path.join(ROOT, 'resources', 'alicat-editor.js'), 'utf8'), vm.createContext({ window, $, RED }));
        window.AlicatEditor.fillContextStores(select, 'redis');
        assert.deepEqual(options.map((o) => o.val), ['', 'memory', 'file', 'redis'], 'the default, each store, then the missing one');
        assert.equal(selected, 'redis');
        window.AlicatEditor.fillContextStores(select, '');
        assert.deepEqual(options.map((o) => o.val), ['', 'memory', 'file']);
        assert.equal(selected, '');
    });

    it('no example ships a disabled node', () => {
        const dir = path.join(ROOT, 'examples');
        for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.json'))) {
            for (const n of JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'))) {
                assert.equal(n.d, undefined, `${file}: node ${n.id} (${n.type}) has a "d" property, which the editor reads as disabled`);
            }
        }
    });
});
