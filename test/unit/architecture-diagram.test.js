'use strict';

// The architecture diagram (docs/diagrams/) against the code: every file has a box,
// the committed files are what the generator makes now, and the storyboards name only
// functions and events that exist. Fix a failure with `npm run diagram`, after updating
// tools/diagram/spec.js if a file, function or event changed.

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { render, stale } = require('../../tools/architecture-diagram');
const { ROOT } = require('../../tools/require-graph');
const spec = require('../../tools/diagram/spec');

/**
 * Repo-relative paths of the files under `dir`.
 * @param {string} dir
 * @returns {string[]}
 */
function walk(dir) {
    return fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((e) => {
        const rel = `${dir}/${e.name}`;
        return e.isDirectory() ? walk(rel) : [rel];
    });
}

/** @param {string} file */
const source = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

/** @param {string} name @param {string} text */
const defines = (name, text) => new RegExp(`(^|[^\\w$])${name.replace(/\$/g, '\\$')}($|[^\\w$])`).test(text);

/**
 * @typedef {object} Element  the parts of an Excalidraw element the checks read
 * @property {string} id
 * @property {string} type
 * @property {number} x
 * @property {number} y
 * @property {number} width
 * @property {number} height
 * @property {string | null} frameId
 * @property {string[]} groupIds
 * @property {{type: string, id: string}[] | null} boundElements
 * @property {{elementId: string} | null} [startBinding]
 * @property {{elementId: string} | null} [endBinding]
 * @property {string | null} [containerId]
 */

describe('architecture diagram', () => {
    /** @type {Map<string, string>} */
    let files = new Map();
    before(() => {
        files = render(); // throws, naming the file, if a required file has no entry in the spec
    });

    it('has a box for every source file in lib/, nodes/, resources/ and tools/, and none for a missing one', () => {
        const sources = ['lib', 'nodes', 'resources', 'tools'].flatMap(walk).filter((f) => f.endsWith('.js')).sort();
        assert.deepEqual(Object.keys(spec.files).sort(), sources);
    });

    it('puts every editor template, catalog, help file and stylesheet in a box', () => {
        const others = ['nodes', 'resources'].flatMap(walk).filter((f) => !f.endsWith('.js')).sort();
        const shown = Object.values(spec.files).flatMap((f) => f.also ?? []).sort();
        assert.deepEqual(shown, others);
    });

    it('is up to date in docs/diagrams/ (else run `npm run diagram`)', () => {
        assert.deepEqual(stale(files), []);
    });

    it('names only files, functions and events that exist', () => {
        /** @type {string[]} */
        const problems = [];
        for (const frame of spec.frames) {
            if (frame.kind === 'map') {
                for (const link of frame.links ?? []) {
                    const text = link.events ? source(link.from) : '';
                    for (const name of link.events ?? []) {
                        if (!text.includes(`emit('${name}'`)) problems.push(`${frame.id}: ${link.from} never emits '${name}'`);
                    }
                }
                continue;
            }
            for (const step of frame.steps) {
                if (step.file && !spec.files[step.file]) problems.push(`${frame.id}/${step.id}: ${step.file} has no entry`);
                if (!step.symbol) continue;
                if (!step.file) {
                    problems.push(`${frame.id}/${step.id}: a symbol needs a file`);
                    continue;
                }
                const text = source(step.file);
                for (const name of step.symbol.match(/[A-Za-z_$][\w$]*/g) ?? []) {
                    if (!defines(name, text)) problems.push(`${frame.id}/${step.id}: ${step.file} has no ${name}`);
                }
            }
        }
        assert.deepEqual(problems, []);
    });

    it('writes an Excalidraw scene whose references all resolve, with no overlapping boxes', () => {
        const scene = JSON.parse(/** @type {string} */ (files.get('architecture.excalidraw')));
        /** @type {Element[]} */
        const elements = scene.elements;
        const byId = new Map(elements.map((e) => [e.id, e]));
        assert.equal(byId.size, elements.length, 'ids are unique');
        assert.equal(scene.type, 'excalidraw');

        /** @type {string[]} */
        const problems = [];
        const groups = new Set(elements.filter((e) => e.type === 'rectangle').map((e) => `group:${e.id}`));
        for (const e of elements) {
            if (![e.x, e.y, e.width, e.height].every(Number.isFinite) || e.width < 0 || e.height < 0) problems.push(`${e.id}: bad geometry`);
            if (e.frameId && byId.get(e.frameId)?.type !== 'frame') problems.push(`${e.id}: no frame ${e.frameId}`);
            for (const g of e.groupIds) if (!groups.has(g)) problems.push(`${e.id}: no group ${g}`);
            for (const b of e.boundElements ?? []) {
                const other = byId.get(b.id);
                const back = b.type === 'text' ? other?.containerId === e.id : other?.startBinding?.elementId === e.id || other?.endBinding?.elementId === e.id;
                if (!back) problems.push(`${e.id}: ${b.type} ${b.id} is not bound back`);
            }
            for (const binding of [e.startBinding, e.endBinding]) {
                if (binding && !byId.get(binding.elementId)?.boundElements?.some((b) => b.id === e.id)) problems.push(`${e.id}: ${binding.elementId} does not list it`);
            }
            if (e.containerId && !byId.get(e.containerId)?.boundElements?.some((b) => b.id === e.id)) problems.push(`${e.id}: container does not list it`);
        }

        const boxes = elements.filter((e) => e.type === 'rectangle' && !e.id.startsWith('zone:'));
        for (const [i, a] of boxes.entries()) {
            for (const b of boxes.slice(i + 1)) {
                const apart = a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y;
                if (!apart) problems.push(`${a.id} overlaps ${b.id}`);
            }
            const frame = a.frameId ? byId.get(a.frameId) : undefined;
            if (!frame || a.x < frame.x || a.y < frame.y || a.x + a.width > frame.x + frame.width || a.y + a.height > frame.y + frame.height) problems.push(`${a.id}: outside its frame`);
        }
        assert.deepEqual(problems, []);
    });

    it('writes one SVG per view', () => {
        const svgs = [...files.keys()].filter((f) => f.endsWith('.svg')).sort();
        assert.deepEqual(svgs, spec.frames.map((f) => `${f.id}.svg`).sort());
        for (const name of svgs) assert.match(/** @type {string} */ (files.get(name)), /^<svg [^>]*viewBox="[-\d. ]+">[\s\S]*<\/svg>\n$/);
    });
});
