#!/usr/bin/env node
'use strict';

// Builds the architecture diagram in docs/diagrams/ (development tool, not shipped):
// architecture.excalidraw (every view on one canvas; open it in excalidraw.com or the
// VS Code Excalidraw extension) and one SVG per view. The boxes and texts come from
// tools/diagram/spec.js, the require arrows from the code itself.
//
//   npm run diagram              write the files
//   npm run diagram -- --check   exit 1 if the files in docs/diagrams/ are out of date

const fs = require('fs');
const path = require('path');
const { parseCli, usage } = require('./cli');
const { ROOT } = require('./require-graph');
const { buildScene } = require('./diagram/layout');
const { toExcalidraw } = require('./diagram/excalidraw');
const { toSvg } = require('./diagram/svg');
const spec = require('./diagram/spec');

const OUT = path.join(ROOT, 'docs', 'diagrams');

/**
 * Every output file, by name.
 * @returns {Map<string, string>}
 */
function render() {
    const scene = buildScene(spec);
    /** @type {Map<string, string>} */
    const files = new Map([['architecture.excalidraw', toExcalidraw(scene)]]);
    for (const frame of scene.frames) files.set(`${frame.id.replace(/^frame:/, '')}.svg`, toSvg(frame));
    return files;
}

/**
 * The output files that differ from what is in docs/diagrams/, or are missing there.
 * @param {Map<string, string>} files
 * @returns {string[]}
 */
function stale(files) {
    return [...files].filter(([name, content]) => {
        const file = path.join(OUT, name);
        return !fs.existsSync(file) || fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n') !== content;
    }).map(([name]) => name);
}

function main() {
    let check;
    try {
        check = parseCli(process.argv.slice(2), { check: { type: 'boolean' } }).values.check === true;
    } catch (err) {
        console.error(`${/** @type {Error} */ (err).message}\n\n${usage(__filename)}`);
        process.exit(2);
    }
    const files = render();
    if (check) {
        const out = stale(files);
        if (out.length > 0) {
            console.error(`[diagram] out of date: ${out.join(', ')}; run npm run diagram`);
            process.exit(1);
        }
        console.log(`[diagram] up to date: ${files.size} files`);
        return;
    }
    fs.mkdirSync(OUT, { recursive: true });
    for (const [name, content] of files) fs.writeFileSync(path.join(OUT, name), content, 'utf8');
    console.log(`[diagram] wrote ${files.size} files to ${path.relative(ROOT, OUT)}`);
}

if (require.main === module) main();

module.exports = { render, stale, OUT };
