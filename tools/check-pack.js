#!/usr/bin/env node
'use strict';

// Checks what `npm pack` would publish (development tool, not shipped):
// - every node's code, editor HTML, message catalog, help and editor script;
// - every file the shipped code requires, followed from the node files and bins;
// - nothing outside the published areas (tests, docs, configs, tarballs).
//
//   npm run check:pack

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { ROOT, requiredFiles } = require('./require-graph');

const PACKAGE = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

/** Top-level files and directories that may be published. */
const ALLOWED = [/^package\.json$/, /^README\.md$/, /^CHANGELOG\.md$/, /^SECURITY\.md$/, /^LICENSE$/,
    /^nodes\//, /^resources\//, /^lib\//, /^examples\/[\w-]+\.json$/, /^tools\/sim\//, /^tools\/(alicat-sim|alicat-probe|cli)\.js$/];

/** @returns {Set<string>} paths `npm pack` would include */
function packedFiles() {
    // A fixed command line (no user input), so the shell that runs npm on every platform is safe.
    const out = execSync('npm pack --dry-run --json --ignore-scripts', { cwd: ROOT, encoding: 'utf8' });
    const [pack] = JSON.parse(out);
    return new Set(pack.files.map((/** @type {{path: string}} */ f) => f.path.replace(/\\/g, '/')));
}

function main() {
    const packed = packedFiles();
    /** @type {string[]} */
    const problems = [];
    const need = (/** @type {string} */ file, /** @type {string} */ why) => {
        if (!packed.has(file)) problems.push(`missing ${file} (${why})`);
    };

    for (const [type, file] of Object.entries(PACKAGE['node-red'].nodes)) {
        const js = /** @type {string} */ (file);
        need(js, `node ${type}`);
        need(js.replace(/\.js$/, '.html'), `editor for ${type}`);
        need(`nodes/locales/en-US/${type}.json`, `messages for ${type}`);
        need(`nodes/locales/en-US/${type}.html`, `help for ${type}`);
        need(`resources/${type}.js`, `editor script for ${type}`);
    }
    need('resources/alicat-editor.js', 'shared editor helpers');
    for (const file of fs.readdirSync(path.join(ROOT, 'examples')).filter((f) => f.endsWith('.json'))) need(`examples/${file}`, 'example flow');
    for (const doc of ['README.md', 'CHANGELOG.md', 'SECURITY.md']) need(doc, 'documentation');
    if (PACKAGE.license !== 'UNLICENSED') need('LICENSE', `license ${PACKAGE.license}`);

    const entries = [...Object.values(PACKAGE['node-red'].nodes), ...Object.values(PACKAGE.bin)].map((f) => String(f).replace(/^\.\//, ''));
    const reached = new Set();
    for (const entry of entries) requiredFiles(entry, reached);
    for (const file of reached) need(file, 'required by shipped code');

    for (const file of packed) {
        if (!ALLOWED.some((re) => re.test(file))) problems.push(`unexpected ${file}`);
    }

    if (problems.length > 0) {
        console.error(`[check-pack] ${problems.length} problem(s):\n  ${problems.join('\n  ')}`);
        process.exit(1);
    }
    console.log(`[check-pack] OK: ${packed.size} files; ${reached.size} required by the nodes and bins, all included`);
}

main();
