'use strict';

// The package's own require graph (development tool, not shipped), read from the
// sources: used by the pack check and the architecture diagram, so both agree on
// what a require is. Only relative requires count; Node's modules are not files here.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const REQUIRE = /require\('(\.{1,2}\/[^']+)'\)/g;

/**
 * The repo-relative file a relative require resolves to.
 * @param {string} from repo-relative path of the requiring file
 * @param {string} spec the required path, e.g. `'../errors'`
 * @returns {string}
 */
function resolveRequire(from, spec) {
    const base = path.posix.join(path.posix.dirname(from), spec);
    const file = [base, `${base}.js`, `${base}/index.js`].find((f) => fs.existsSync(path.join(ROOT, f)) && fs.statSync(path.join(ROOT, f)).isFile());
    if (!file) throw new Error(`${from} requires ${spec}, which does not exist`);
    return file;
}

/**
 * The files `file` requires directly, in source order, without duplicates.
 * @param {string} file repo-relative path
 * @returns {string[]}
 */
function requireEdges(file) {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const targets = [...source.matchAll(REQUIRE)].map(([, spec]) => resolveRequire(file, /** @type {string} */ (spec)));
    return [...new Set(targets)];
}

/**
 * The files `entry` needs, following relative requires.
 * @param {string} entry repo-relative path
 * @param {Set<string>} seen
 * @returns {Set<string>}
 */
function requiredFiles(entry, seen = new Set()) {
    if (seen.has(entry)) return seen;
    seen.add(entry);
    for (const file of requireEdges(entry)) requiredFiles(file, seen);
    return seen;
}

module.exports = { ROOT, resolveRequire, requireEdges, requiredFiles };
