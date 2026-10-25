'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const DIRS = ['lib', 'nodes', 'resources', 'tools', 'examples', 'docs', 'test'];
const FILES = ['README.md', 'CHANGELOG.md', 'CONTRIBUTING.md', 'SECURITY.md', 'package.json'];

/**
 * UTF-8 text that was decoded as Windows-1252 and saved again: an em dash
 * becomes a-circumflex + euro sign + ..., an arrow a-circumflex + dagger + ...,
 * an e-acute A-tilde + copyright sign. Built from character codes so this file
 * itself stays plain ASCII.
 */
const ch = (/** @type {number[]} */ ...codes) => String.fromCharCode(...codes);
const MOJIBAKE = new RegExp([
    `${ch(0xE2)}[${ch(0x20AC, 0x2020, 0x2021, 0x2030)}]`, // a-circumflex + euro / dagger / double dagger / per mille
    `${ch(0xC3)}[${ch(0x80)}-${ch(0xBF)}]`, // A-tilde + Latin-1 upper half
    `${ch(0xC2)}[${ch(0xA0)}-${ch(0xBF)}]`, // A-circumflex + Latin-1 symbol
    ch(0xFFFD) // replacement character
].join('|'));

/** @param {string} dir @returns {string[]} */
function walk(dir) {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) return e.name === 'node_modules' ? [] : walk(p);
        return /\.(js|json|html|md|css)$/.test(e.name) ? [p] : [];
    });
}

describe('source hygiene', () => {
    const files = [...DIRS.flatMap((d) => walk(path.join(ROOT, d))), ...FILES.map((f) => path.join(ROOT, f)).filter((f) => fs.existsSync(f))];

    it('has no mojibake or byte-order marks in sources, docs and examples', () => {
        /** @type {string[]} */
        const bad = [];
        for (const file of files) {
            const buf = fs.readFileSync(file);
            if (buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) bad.push(`${path.relative(ROOT, file)}: starts with a UTF-8 BOM`);
            buf.toString('utf8').split('\n').forEach((line, i) => {
                if (MOJIBAKE.test(line)) bad.push(`${path.relative(ROOT, file)}:${i + 1}: ${line.trim().slice(0, 100)}`);
            });
        }
        assert.deepEqual(bad, []);
    });

    it('recognises real mojibake and leaves correct text alone', () => {
        const cp1252 = new TextDecoder('windows-1252');
        const garble = (/** @type {string} */ s) => cp1252.decode(Buffer.from(s, 'utf8'));
        const correct = ch(0x2014, 0x2192, 0x21C4, 0x2248, 0xE9, 0xB0, 0x2013, 0x2026, 0x2265, 0xB1, 0xB5);
        for (const c of correct) assert.ok(MOJIBAKE.test(garble(c)), `garbled U+${c.charCodeAt(0).toString(16)}`);
        assert.equal(MOJIBAKE.test(`flow ${correct} done`), false);
    });
});

/**
 * The type expressions in a file's JSDoc: the balanced `{...}` after each tag.
 * @param {string} source
 * @returns {string[]}
 */
function jsdocTypes(source) {
    /** @type {string[]} */
    const types = [];
    for (const comment of source.match(/\/\*\*[\s\S]*?\*\//g) || []) {
        for (const tag of comment.matchAll(/@\w+\s*\{/g)) {
            let depth = 0;
            const start = /** @type {number} */ (tag.index) + tag[0].length - 1;
            for (let i = start; i < comment.length; i++) {
                if (comment[i] === '{') depth++;
                else if (comment[i] === '}' && --depth === 0) {
                    types.push(comment.slice(start + 1, i));
                    break;
                }
            }
        }
    }
    return types;
}

describe('typing and structure guards', () => {
    /** @param {string} dir */
    const sources = (dir) => walk(path.join(ROOT, dir)).filter((f) => f.endsWith('.js'));

    it('uses no `any` in the JSDoc types of lib/ and nodes/', () => {
        // Keep this empty: give the value a real type, or `unknown` and narrow it.
        /** @type {Set<string>} */
        const ALLOWED = new Set([]);
        /** @type {string[]} */
        const found = [];
        for (const file of [...sources('lib'), ...sources('nodes')]) {
            const rel = path.relative(ROOT, file).replace(/\\/g, '/');
            for (const type of jsdocTypes(fs.readFileSync(file, 'utf8'))) {
                if (/\bany\b/.test(type) && !ALLOWED.has(rel)) found.push(`${rel}: {${type.replace(/\s+/g, ' ').slice(0, 80)}}`);
            }
        }
        assert.deepEqual(found, []);
    });

    it('finds `any` in a type, but not in prose or other words', () => {
        const types = jsdocTypes('/** Reads any value. @param {any} a @param {{x: Record<string, any>}} b @param {Company} c */');
        assert.deepEqual(types.map((t) => /\bany\b/.test(t)), [true, true, false]);
    });

    it('lets only the config node register input and close handlers itself (the others use defineDeviceNode)', () => {
        const direct = sources('nodes')
            .filter((f) => path.basename(f) !== 'alicat-device.js')
            .filter((f) => /\.on\(\s*['"](input|close)['"]/.test(fs.readFileSync(f, 'utf8')))
            .map((f) => path.basename(f));
        assert.deepEqual(direct, []);
    });
});

/**
 * The words this public repository must never contain (the test bench's serial number,
 * internal names), as SHA-256 prefixes, so this file doesn't publish them itself.
 * Check a candidate: `printf %s word | sha256sum | cut -c1-16`.
 */
const FORBIDDEN_WORDS = new Set(['f3a531fc1c87f58c', '6cf0b6430dcaa779', '66d293bf7386149f', '1f13010abac30b19', 'add8bed82dd53765', '2c71eed45b06a1dd']);

/** Patterns that point at a real network, person, machine or secret; documentation uses 192.0.2.x. */
const LEAKS = [
    { name: 'link-local address', re: /\b169\.254\.\d{1,3}\.\d{1,3}\b/g, allow: ['test/unit/admin-api.test.js'] },
    { name: 'email address', re: /[\w.+-]+@[\w-]+(?:\.[\w-]+)*\.[a-z]{2,}\b/gi, allow: [] },
    { name: 'user profile path', re: /[A-Z]:[\\/]+Users[\\/]+\w|\/(?:home|Users)\/\w+\/|AppData[\\/]/gi, allow: [] },
    { name: 'private key or token', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:ghp|gho|ghs|ghu|github_pat|npm)_[A-Za-z0-9_]{20,}|\bAKIA[0-9A-Z]{16}\b/g, allow: [] }
];

describe('release hygiene (nothing private in the public repository)', () => {
    const { execFileSync } = require('child_process');
    const crypto = require('crypto');
    const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' }).split('\0').filter(Boolean);
    const text = tracked.map((rel) => ({ rel, buf: fs.readFileSync(path.join(ROOT, rel)) })).filter((f) => !f.buf.includes(0));

    it('has no bench addresses, emails, user paths or secrets', () => {
        /** @type {string[]} */
        const found = [];
        for (const { rel, buf } of text) {
            const s = buf.toString('utf8');
            for (const leak of LEAKS) {
                if (leak.allow.includes(rel)) continue;
                for (const m of s.matchAll(leak.re)) found.push(`${rel}: ${leak.name} "${m[0]}"`);
            }
        }
        assert.deepEqual(found, []);
    });

    it('has none of the forbidden words', () => {
        const hash = (/** @type {string} */ w) => crypto.createHash('sha256').update(w).digest('hex').slice(0, 16);
        /** @type {string[]} */
        const found = [];
        for (const { rel, buf } of text) {
            for (const word of new Set(buf.toString('utf8').toLowerCase().match(/[a-z0-9]+/g) ?? [])) {
                if (FORBIDDEN_WORDS.has(hash(word))) found.push(`${rel}: a forbidden word (hash ${hash(word)})`);
            }
        }
        assert.deepEqual(found, []);
    });

    it('recognises each kind of leak', () => {
        // Built from pieces, so this file doesn't trip its own check.
        const samples = [['169', '254', '1', '2'].join('.'), ['someone', 'example.org'].join('@'), ['C:', 'Users', 'someone'].join('/'), `ghp_${'a'.repeat(30)}`];
        LEAKS.forEach((leak, i) => assert.ok(new RegExp(leak.re.source, leak.re.flags.replace('g', '')).test(samples[i] ?? ''), leak.name));
    });
});
