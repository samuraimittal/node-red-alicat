'use strict';

// Draws one frame of a laid-out scene (./layout.js) as a standalone SVG, for GitHub
// and the docs: the same boxes, texts and arrows as the Excalidraw file, in clean
// lines. Development tool, not shipped.

const { EDGE_STYLE, LINE_HEIGHT, INK } = require('./layout');

/** @import {SceneFrame, SceneRect, SceneText, SceneArrow, EdgeKind} from './layout' */

const MARGIN = 24;
const TITLE = 48;    // room above the frame for its name
const DASH = { solid: '', dashed: '8 6', dotted: '2 5' };
const FONTS = {
    body: 'Helvetica, Arial, sans-serif',
    code: "'Cascadia Code', Consolas, 'Courier New', monospace"
};

/** @param {string} s */
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * Each line on its own baseline, matching Excalidraw's line height.
 * @param {SceneText} t
 */
function text(t) {
    const anchor = t.align === 'center' ? ' text-anchor="middle"' : '';
    const x = t.align === 'center' ? t.x + t.w / 2 : t.x;
    const spans = t.text.split('\n').map((line, i) => {
        const baseline = t.y + i * t.size * LINE_HEIGHT + t.size * ((LINE_HEIGHT - 1) / 2 + 0.8);
        return `<tspan x="${x}" y="${baseline.toFixed(1)}">${esc(line)}</tspan>`;
    });
    return `<text class="${t.font}" font-size="${t.size}" fill="${t.colour}"${anchor}>${spans.join('')}</text>`;
}

/** @param {SceneRect} r */
function rect(r) {
    const dash = DASH[r.dash] ? ` stroke-dasharray="${DASH[r.dash]}"` : '';
    const width = r.kind === 'zone' ? 1 : 1.5;
    return [
        `<rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" rx="10" fill="${r.fill}" stroke="${r.stroke}" stroke-width="${width}"${dash}/>`,
        ...r.texts.map(text)
    ].join('\n');
}

/** @param {SceneArrow} a */
function arrow(a) {
    const style = EDGE_STYLE[a.kind];
    const dash = DASH[style.dash] ? ` stroke-dasharray="${DASH[style.dash]}"` : '';
    const points = a.points.map(([x, y]) => `${x},${y}`).join(' ');
    const out = [`<polyline points="${points}" fill="none" stroke="${style.stroke}" stroke-width="${style.width}" stroke-linejoin="round"${dash} marker-end="url(#head-${a.kind})"/>`];
    if (a.label) {
        const l = a.label;
        out.push(`<rect x="${l.x - 3}" y="${l.y - 2}" width="${l.w + 6}" height="${l.h + 4}" fill="#ffffff" fill-opacity="0.9"/>`, text(l));
    }
    return out.join('\n');
}

/** One arrowhead per edge kind, in its colour, the same size whatever the line width. */
function markers() {
    return Object.entries(EDGE_STYLE).map(([kind, style]) =>
        `<marker id="head-${/** @type {EdgeKind} */ (kind)}" viewBox="0 0 10 10" refX="10" refY="5" markerUnits="userSpaceOnUse" markerWidth="11" markerHeight="11" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="${style.stroke}"/></marker>`);
}

/**
 * @param {SceneFrame} frame
 * @returns {string}
 */
function toSvg(frame) {
    const x = frame.x - MARGIN;
    const y = frame.y - TITLE - MARGIN;
    const w = frame.w + 2 * MARGIN;
    const h = frame.h + TITLE + 2 * MARGIN;
    return [
        `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="${x} ${y} ${w} ${h}">`,
        `<title>${esc(frame.name)}</title>`,
        `<style>.body{font-family:${FONTS.body}}.code{font-family:${FONTS.code}}</style>`,
        `<defs>${markers().join('')}</defs>`,
        `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#ffffff"/>`,
        `<text class="body" x="${frame.x}" y="${frame.y - 16}" font-size="24" fill="${INK}">${esc(frame.name)}</text>`,
        `<rect x="${frame.x}" y="${frame.y}" width="${frame.w}" height="${frame.h}" rx="12" fill="none" stroke="#ced4da" stroke-width="1"/>`,
        ...frame.texts.map(text),
        ...frame.rects.map(rect),
        ...frame.arrows.map(arrow),
        '</svg>',
        ''
    ].join('\n');
}

module.exports = { toSvg };
