'use strict';

// Lays out the architecture diagram: turns the spec (./spec.js) and the package's
// require graph into frames of boxes, texts and arrows with absolute coordinates.
// ./excalidraw.js and ./svg.js draw the same scene. Development tool, not shipped.

const { requireEdges } = require('../require-graph');

/**
 * @typedef {'violet' | 'blue' | 'cyan' | 'teal' | 'green' | 'yellow' | 'orange' | 'grey' | 'pink' | 'red' | 'grape'} Colour
 * @typedef {'require' | 'event' | 'flow' | 'failure' | 'drives'} EdgeKind
 * @typedef {'code' | 'body'} Font
 * @typedef {'solid' | 'dashed' | 'dotted'} Dash
 */

/**
 * A source file, drawn as a box in a map frame.
 * @typedef {object} FileSpec
 * @property {string} zone      the zone it sits in
 * @property {string} role      what it does, in a sentence or two
 * @property {'arrow' | 'listed' | string[]} [incoming] how requires of this file are drawn: as arrows
 *     (the default), listed in the requiring file's box, or as arrows only from the files named
 * @property {string[]} [also]  non-JS files the box stands for (templates, catalogs, styles)
 */

/**
 * A box that is not a source file (the instrument, a test suite).
 * @typedef {object} BoxSpec
 * @property {string} id
 * @property {string} title
 * @property {string} text
 * @property {Colour} [colour]   default: the zone's
 * @property {boolean} [outside] outside this package: dashed outline
 */

/**
 * A titled group of boxes in a map frame. Rows line up across the zones of a band, so a
 * box can sit in a row of its own above or below the boxes it has arrows to.
 * @typedef {object} ZoneSpec
 * @property {string} id
 * @property {string} title
 * @property {string} [note]
 * @property {Colour} colour
 * @property {string[][]} [rows]  file paths and box ids row by row, '' for an empty cell;
 *     without it the zone's files, then its boxes, fill `columns` columns
 * @property {number} [columns]
 * @property {BoxSpec[]} [boxes]
 */

/**
 * An arrow the require graph doesn't give: an event, or what a test suite drives.
 * @typedef {object} LinkSpec
 * @property {string} from      a file path, a box id or `zone:<id>`
 * @property {string} to
 * @property {EdgeKind} kind
 * @property {string} [label]
 * @property {string[]} [events] event names `from` emits (the sync test checks them)
 */

/**
 * @typedef {object} MapFrameSpec
 * @property {'map'} kind
 * @property {string} id         also the SVG's file name
 * @property {string} title
 * @property {string} [subtitle]
 * @property {string[][]} bands  zone ids, one array per band, top to bottom; '' leaves a zone-wide gap
 * @property {LinkSpec[]} [links]
 */

/**
 * One box of a storyboard.
 * @typedef {object} StepSpec
 * @property {string} id
 * @property {[number, number]} at  column (may be fractional) and row
 * @property {string} text
 * @property {string} [file]    the file doing the work; its zone gives the colour
 * @property {string} [symbol]  names in `file`, e.g. `subscribe · readLive` (the sync test checks each)
 * @property {string} [title]   a heading (above the file, if there is one)
 * @property {number} [n]       step number
 * @property {'step' | 'failure' | 'note' | 'outside'} [kind]  failure: red; note: yellow; outside
 *     this package (Node-RED, the instrument): dashed
 * @property {Colour} [colour]  instead of the colour from the kind or the file
 */

/** @typedef {[from: string, to: string, label?: string, kind?: EdgeKind]} EdgeSpec */

/**
 * @typedef {object} FlowFrameSpec
 * @property {'flow'} kind
 * @property {string} id
 * @property {string} title
 * @property {string} [subtitle]
 * @property {number} [columnWidth]
 * @property {StepSpec[]} steps
 * @property {EdgeSpec[]} edges
 */

/**
 * @typedef {object} Spec
 * @property {{roughness: number}} style    0: clean lines; 1: Excalidraw's hand-drawn look
 * @property {ZoneSpec[]} zones
 * @property {Record<string, FileSpec>} files  keyed by repo-relative path, in drawing order
 * @property {(MapFrameSpec | FlowFrameSpec)[]} frames
 * @property {string[][]} canvas            frame ids, one array per row of frames
 */

/**
 * @typedef {object} SceneText
 * @property {string} id
 * @property {number} x
 * @property {number} y
 * @property {number} w
 * @property {number} h
 * @property {string} text  lines joined by `\n`
 * @property {Font} font
 * @property {number} size
 * @property {string} colour
 * @property {'left' | 'center'} align
 *
 * @typedef {object} SceneRect
 * @property {string} id
 * @property {'zone' | 'box'} kind
 * @property {number} x
 * @property {number} y
 * @property {number} w
 * @property {number} h
 * @property {string} stroke
 * @property {string} fill
 * @property {Dash} dash
 * @property {SceneText[]} texts  drawn and moved with the rectangle
 *
 * @typedef {object} SceneArrow
 * @property {string} id
 * @property {string} from  rectangle ids
 * @property {string} to
 * @property {[number, number][]} points  absolute
 * @property {EdgeKind} kind
 * @property {SceneText | null} label
 *
 * @typedef {object} SceneFrame
 * @property {string} id
 * @property {string} name
 * @property {number} x
 * @property {number} y
 * @property {number} w
 * @property {number} h
 * @property {SceneRect[]} rects
 * @property {SceneArrow[]} arrows
 * @property {SceneText[]} texts  free texts (the subtitle)
 *
 * @typedef {{frames: SceneFrame[], roughness: number}} Scene
 */

const INK = '#1e1e1e';
const MUTED = '#868e96';
const SOFT = '#495057';

/** Stroke, box fill and zone fill per colour (shades 8, 1 and 0 of open-color, Excalidraw's palette). */
const PALETTE = /** @type {const} */ ({
    violet: { stroke: '#6741d9', fill: '#e5dbff', zone: '#f3f0ff' },
    blue: { stroke: '#1971c2', fill: '#d0ebff', zone: '#e7f5ff' },
    cyan: { stroke: '#0c8599', fill: '#c5f6fa', zone: '#e3fafc' },
    teal: { stroke: '#099268', fill: '#c3fae8', zone: '#e6fcf5' },
    green: { stroke: '#2f9e44', fill: '#d3f9d8', zone: '#ebfbee' },
    yellow: { stroke: '#f08c00', fill: '#fff3bf', zone: '#fff9db' },
    orange: { stroke: '#e8590c', fill: '#ffe8cc', zone: '#fff4e6' },
    grey: { stroke: '#495057', fill: '#e9ecef', zone: '#f8f9fa' },
    pink: { stroke: '#c2255c', fill: '#ffdeeb', zone: '#fff0f6' },
    red: { stroke: '#e03131', fill: '#ffe3e3', zone: '#fff5f5' },
    grape: { stroke: '#9c36b5', fill: '#f3d9fa', zone: '#f8f0fc' }
});

/** @type {Record<EdgeKind, {stroke: string, width: number, dash: Dash}>} */
const EDGE_STYLE = {
    require: { stroke: '#868e96', width: 1, dash: 'solid' },
    event: { stroke: '#9c36b5', width: 1.5, dash: 'dashed' },
    flow: { stroke: '#1971c2', width: 2.5, dash: 'solid' },
    failure: { stroke: '#e03131', width: 2, dash: 'dashed' },
    drives: { stroke: '#c2255c', width: 1.5, dash: 'dotted' }
};

const LINE_HEIGHT = 1.25;
const SIZE = { title: 14, heading: 16, symbol: 13, body: 14, small: 12, label: 13, zone: 20, subtitle: 16 };
const MAP_BOX_WIDTH = 300;
const FLOW_BOX_WIDTH = 330;     // fits a numbered `6 · lib/modbus/ModbusTcpTransport.js` on one line
const BOX_PAD = 12;     // inside a box
const PART_GAP = 4;     // between the text parts of a box
const BOX_GAP = 20;     // between boxes in a zone
const ZONE_PAD = 20;
const ZONE_GAP = 40;
const BAND_GAP = 70;
const FLOW_GAP_X = 110;         // room for a label between two columns
const FLOW_GAP_Y = 60;
const FRAME_PAD = 40;
const CANVAS_GAP = 160;
const ARROW_GAP = 6;    // between an arrow's end and the box it is bound to
const LABEL_WIDTH = 220;

// ---------------------------------------------------------------------------------------------
// Text

/** Advance widths in em of Helvetica (and Arial, which shares its metrics); others are 0.556. */
const NARROW = new Map(Object.entries({
    ' ': 0.278, i: 0.222, j: 0.222, l: 0.222, f: 0.278, t: 0.278, r: 0.333, I: 0.278,
    '.': 0.278, ',': 0.278, ':': 0.278, ';': 0.278, "'": 0.191, '|': 0.26, '!': 0.278,
    '(': 0.333, ')': 0.333, '[': 0.278, ']': 0.278, '{': 0.334, '}': 0.334, '-': 0.333, '/': 0.278, '·': 0.278,
    c: 0.5, k: 0.5, s: 0.5, v: 0.5, x: 0.5, y: 0.5, z: 0.5
}));
const WIDE = new Map(Object.entries({
    m: 0.833, w: 0.722, M: 0.833, W: 0.944, '%': 0.889, '@': 1.015, '→': 1, '←': 1, '↔': 1, '…': 1, '—': 1, '≥': 0.6, '≤': 0.6, '×': 0.584
}));

/**
 * @param {string} ch
 * @returns {number} width in em
 */
function em(ch) {
    const known = NARROW.get(ch) ?? WIDE.get(ch);
    if (known !== undefined) return known;
    return /[A-Z]/.test(ch) ? 0.667 : 0.556;
}

/**
 * Estimated width of one line: Cascadia (code) is monospaced at about 0.6 em.
 * @param {string} line
 * @param {Font} font
 * @param {number} size
 */
function lineWidth(line, font, size) {
    if (font === 'code') return line.length * 0.6 * size;
    let total = 0;
    for (const ch of line) total += em(ch);
    return total * size;
}

/**
 * Greedy word wrap; `\n` starts a new line. A path too long for a line of its own starts a
 * new line and breaks after a `/`.
 * @param {string} text
 * @param {Font} font
 * @param {number} size
 * @param {number} max
 * @returns {string[]}
 */
function wrap(text, font, size, max) {
    /** @type {string[]} */
    const lines = [];
    for (const paragraph of text.split('\n')) {
        let line = '';
        for (const word of paragraph.split(' ')) {
            const long = lineWidth(word, font, size) > max;
            if (long && line) {
                lines.push(line);
                line = '';
            }
            (long ? word.split(/(?<=\/)/) : [word]).forEach((piece, i) => {
                const next = `${line}${line && i === 0 ? ' ' : ''}${piece}`;
                if (line && lineWidth(next, font, size) > max) {
                    lines.push(line);
                    line = piece;
                } else {
                    line = next;
                }
            });
        }
        lines.push(line);
    }
    return lines;
}

/**
 * @typedef {{key: string, text: string, font: Font, size: number, colour: string}} Part
 */

/**
 * Wraps the parts to `width` and stacks them from (x, y) down.
 * @param {string} id   prefix of the text ids
 * @param {{x: number, y: number, width: number}} at
 * @param {Part[]} parts
 * @returns {{texts: SceneText[], bottom: number}}
 */
function stack(id, at, parts) {
    /** @type {SceneText[]} */
    const texts = [];
    let y = at.y;
    for (const part of parts.filter((p) => p.text)) {
        const lines = wrap(part.text, part.font, part.size, at.width);
        const w = Math.ceil(Math.max(...lines.map((l) => lineWidth(l, part.font, part.size))));
        const h = Math.ceil(lines.length * part.size * LINE_HEIGHT);
        if (texts.length > 0) y += PART_GAP;
        texts.push({ id: `${id}:${part.key}`, x: at.x, y, w, h, text: lines.join('\n'), font: part.font, size: part.size, colour: part.colour, align: 'left' });
        y += h;
    }
    return { texts, bottom: y };
}

// ---------------------------------------------------------------------------------------------
// Boxes

/**
 * A box at (0, 0) sized to its text; `place()` moves it.
 * @param {{id: string, width: number, colour: Colour, dash?: Dash, kind?: 'zone' | 'box'}} style
 * @param {Part[]} parts
 * @returns {SceneRect}
 */
function box(style, parts) {
    const swatch = PALETTE[style.colour];
    const zone = style.kind === 'zone';
    const pad = zone ? ZONE_PAD : BOX_PAD;
    const { texts, bottom } = stack(style.id, { x: pad, y: pad, width: style.width - 2 * pad }, parts);
    return {
        id: style.id,
        kind: zone ? 'zone' : 'box',
        x: 0,
        y: 0,
        w: style.width,
        h: bottom + pad,
        stroke: swatch.stroke,
        fill: zone ? swatch.zone : swatch.fill,
        dash: style.dash ?? 'solid',
        texts
    };
}

/**
 * Moves a rectangle and its texts by (dx, dy).
 * @param {SceneRect} rect
 * @param {number} dx
 * @param {number} dy
 */
function place(rect, dx, dy) {
    rect.x += dx;
    rect.y += dy;
    for (const t of rect.texts) {
        t.x += dx;
        t.y += dy;
    }
}

/** `lib/device/live.js` → `device/live`: how a file is named inside other boxes. */
function shortName(/** @type {string} */ file) {
    return file.replace(/^(lib|nodes|resources|tools)\//, '').replace(/\.js$/, '');
}

/**
 * The files a box stands for, with a catalog and its help merged: `x.{json,html}`.
 * @param {string[]} files
 */
function alsoText(files) {
    /** @type {string[]} */
    const out = [];
    for (const file of files) {
        const stem = file.replace(/\.[^./]+$/, '');
        const i = out.findIndex((f) => f.startsWith(`${stem}.`) && f.includes('nodes/locales/'));
        if (i >= 0) out[i] = `${stem}.{${(out[i] ?? '').slice(stem.length + 1)},${file.slice(stem.length + 1)}}`;
        else out.push(file);
    }
    return `+ ${out.join(' · ')}`;
}

/**
 * @param {string[]} names
 * @param {boolean} more  some requirers already have arrows
 */
function usedByText(names, more) {
    const also = more ? 'also ' : '';
    return names.length <= 4 ? `${also}used by: ${names.join(' · ')}` : `${also}used by ${names.length} files`;
}

/**
 * @typedef {object} Graph
 * @property {[from: string, to: string][]} drawn  require edges drawn as arrows
 * @property {Map<string, string[]>} uses          per file: required files listed in its box
 * @property {Map<string, string[]>} usedBy        per file: requiring files listed in its box
 * @property {Set<string>} arrowed                  files with at least one incoming arrow
 */

/**
 * @param {string} file
 * @param {Spec} spec
 * @param {Graph} graph
 * @returns {SceneRect}
 */
function fileBox(file, spec, graph) {
    const entry = /** @type {FileSpec} */ (spec.files[file]);
    const zone = zoneOf(spec, entry.zone);
    const uses = graph.uses.get(file) ?? [];
    const usedBy = graph.usedBy.get(file) ?? [];
    const small = [uses.length ? `uses: ${uses.join(' · ')}` : '', usedBy.length ? usedByText(usedBy, graph.arrowed.has(file)) : ''].filter(Boolean).join('\n');
    return box({ id: `file:${file}`, width: MAP_BOX_WIDTH, colour: zone.colour }, [
        { key: 'title', text: file, font: 'code', size: SIZE.title, colour: INK },
        { key: 'role', text: entry.role, font: 'body', size: SIZE.body, colour: INK },
        { key: 'also', text: entry.also ? alsoText(entry.also) : '', font: 'code', size: SIZE.small, colour: SOFT },
        { key: 'deps', text: small, font: 'body', size: SIZE.small, colour: MUTED }
    ]);
}

/**
 * @param {BoxSpec} spec
 * @param {ZoneSpec} zone
 */
function extraBox(spec, zone) {
    return box({ id: `box:${spec.id}`, width: MAP_BOX_WIDTH, colour: spec.colour ?? zone.colour, dash: spec.outside ? 'dashed' : 'solid' }, [
        { key: 'title', text: spec.title, font: 'body', size: SIZE.heading, colour: INK },
        { key: 'text', text: spec.text, font: 'body', size: SIZE.body, colour: INK }
    ]);
}

/**
 * @param {Spec} spec
 * @param {string} id
 */
function zoneOf(spec, id) {
    const zone = spec.zones.find((z) => z.id === id);
    if (!zone) throw new Error(`tools/diagram/spec.js: no zone "${id}"`);
    return zone;
}

// ---------------------------------------------------------------------------------------------
// Require graph

/**
 * The frame each file is drawn in.
 * @param {Spec} spec
 * @returns {Map<string, string>}
 */
function frameOfFiles(spec) {
    /** @type {Map<string, string>} */
    const zoneFrame = new Map();
    for (const frame of spec.frames) {
        if (frame.kind === 'map') for (const id of frame.bands.flat()) zoneFrame.set(id, frame.id);
    }
    return new Map(Object.entries(spec.files).map(([file, entry]) => [file, zoneFrame.get(entry.zone) ?? '']));
}

/**
 * Sorts every relative require into an arrow or a listing, following each target's `incoming` rule.
 * Requires across frames are always listed.
 * @param {Spec} spec
 * @returns {Graph}
 */
function analyse(spec) {
    const frameOf = frameOfFiles(spec);
    /** @type {Graph} */
    const graph = { drawn: [], uses: new Map(), usedBy: new Map(), arrowed: new Set() };
    /** @type {(map: Map<string, string[]>, key: string, value: string) => void} */
    const add = (map, key, value) => map.set(key, [...(map.get(key) ?? []), value]);
    for (const from of Object.keys(spec.files).filter((f) => f.endsWith('.js'))) {
        for (const to of requireEdges(from)) {
            const rule = spec.files[to]?.incoming;
            if (rule === undefined && !spec.files[to]) throw new Error(`tools/diagram/spec.js: ${to} (required by ${from}) has no entry`);
            const allowed = rule === undefined || rule === 'arrow' || (Array.isArray(rule) && rule.includes(from));
            if (allowed && frameOf.get(from) === frameOf.get(to)) {
                graph.drawn.push([from, to]);
                graph.arrowed.add(to);
            } else {
                add(graph.uses, from, shortName(to));
                add(graph.usedBy, to, shortName(from));
            }
        }
    }
    return graph;
}

// ---------------------------------------------------------------------------------------------
// Arrows

/**
 * @typedef {'top' | 'bottom' | 'left' | 'right'} Side
 *
 * @typedef {object} Edge  an arrow before its end points are known
 * @property {string} id
 * @property {SceneRect} from
 * @property {SceneRect} to
 * @property {EdgeKind} kind
 * @property {string | undefined} [label]
 */

/** @param {SceneRect} r @returns {[number, number]} */
const centre = (r) => [r.x + r.w / 2, r.y + r.h / 2];

/**
 * The sides of `a` and `b` that face each other: bottom and top when one is above the other,
 * else right and left. An arrow between neighbouring rows so stays in the gap between them
 * instead of crossing the boxes beside its ends.
 * @param {SceneRect} a
 * @param {SceneRect} b
 * @returns {[Side, Side]}
 */
function facing(a, b) {
    if (b.y >= a.y + a.h) return ['bottom', 'top'];
    if (a.y >= b.y + b.h) return ['top', 'bottom'];
    return centre(b)[0] >= centre(a)[0] ? ['right', 'left'] : ['left', 'right'];
}

/**
 * A point just outside `side` of `rect`, at fraction `f` along the side's middle 70 %.
 * @param {SceneRect} rect
 * @param {Side} side
 * @param {number} f
 * @returns {[number, number]}
 */
function attach(rect, side, f) {
    const t = 0.15 + 0.7 * f;
    switch (side) {
        case 'top': return [Math.round(rect.x + rect.w * t), rect.y - ARROW_GAP];
        case 'bottom': return [Math.round(rect.x + rect.w * t), rect.y + rect.h + ARROW_GAP];
        case 'left': return [rect.x - ARROW_GAP, Math.round(rect.y + rect.h * t)];
        default: return [rect.x + rect.w + ARROW_GAP, Math.round(rect.y + rect.h * t)];
    }
}

/**
 * The label centred on the middle of the arrow.
 * @param {string} id
 * @param {string} label
 * @param {[number, number][]} points
 * @returns {SceneText | null}
 */
function labelAt(id, label, points) {
    const a = points[0] ?? [0, 0];
    const b = points[points.length - 1] ?? a;
    const [t] = stack(id, { x: 0, y: 0, width: LABEL_WIDTH }, [{ key: 'label', text: label, font: 'body', size: SIZE.label, colour: SOFT }]).texts;
    return t ? { ...t, x: Math.round((a[0] + b[0]) / 2 - t.w / 2), y: Math.round((a[1] + b[1]) / 2 - t.h / 2), align: 'center' } : null;
}

/**
 * Straight arrows between facing sides. The ends sharing a side are spread along it in the
 * order of the boxes at their other ends, so they neither overlap nor cross each other.
 * @param {Edge[]} edges
 * @returns {SceneArrow[]}
 */
function route(edges) {
    /** @type {Map<string, {edge: number, end: 0 | 1, rect: SceneRect, side: Side, other: SceneRect}[]>} */
    const groups = new Map();
    edges.forEach((e, i) => {
        const [out, into] = facing(e.from, e.to);
        groups.set(`${e.from.id}|${out}`, [...(groups.get(`${e.from.id}|${out}`) ?? []), { edge: i, end: 0, rect: e.from, side: out, other: e.to }]);
        groups.set(`${e.to.id}|${into}`, [...(groups.get(`${e.to.id}|${into}`) ?? []), { edge: i, end: 1, rect: e.to, side: into, other: e.from }]);
    });
    /** @type {[number, number][][]} */
    const points = edges.map(() => [[0, 0], [0, 0]]);
    for (const ends of groups.values()) {
        const axis = ends[0]?.side === 'top' || ends[0]?.side === 'bottom' ? 0 : 1;
        const id = (/** @type {{edge: number}} */ p) => edges[p.edge]?.id ?? '';
        ends.sort((p, q) => centre(p.other)[axis] - centre(q.other)[axis] || id(p).localeCompare(id(q)));
        ends.forEach((end, i) => {
            /** @type {[number, number][]} */ (points[end.edge])[end.end] = attach(end.rect, end.side, (i + 1) / (ends.length + 1));
        });
    }
    return edges.map((e, i) => {
        const line = /** @type {[number, number][]} */ (points[i]);
        return { id: e.id, from: e.from.id, to: e.to.id, points: line, kind: e.kind, label: e.label ? labelAt(e.id, e.label, line) : null };
    });
}

/**
 * @param {Map<string, SceneRect>} rects
 * @param {string} ref  a file path, box id or `zone:<id>`
 * @param {string} frame
 */
function rectFor(rects, ref, frame) {
    const id = ref.startsWith('zone:') ? ref : ref.includes('/') ? `file:${ref}` : `box:${ref}`;
    const rect = rects.get(id);
    if (!rect) throw new Error(`tools/diagram/spec.js: frame "${frame}" links ${ref}, which is not in that frame`);
    return rect;
}

// ---------------------------------------------------------------------------------------------
// Frames

/**
 * A zone's boxes, row by row (null: an empty cell). Every file of the zone must be placed.
 * @param {ZoneSpec} zone
 * @param {Spec} spec
 * @param {Graph} graph
 * @returns {(SceneRect | null)[][]}
 */
function zoneCells(zone, spec, graph) {
    const files = Object.keys(spec.files).filter((f) => spec.files[f]?.zone === zone.id);
    const extras = new Map((zone.boxes ?? []).map((b) => [b.id, b]));
    const all = [...files, ...extras.keys()];
    const columns = zone.columns ?? 4;
    const refs = zone.rows ?? Array.from({ length: Math.ceil(all.length / columns) }, (_, i) => all.slice(i * columns, (i + 1) * columns));
    const missing = files.filter((f) => !refs.flat().includes(f));
    if (missing.length > 0) throw new Error(`tools/diagram/spec.js: zone "${zone.id}" rows leave out ${missing.join(', ')}`);
    return refs.map((row) => row.map((ref) => {
        if (!ref) return null;
        const extra = extras.get(ref);
        if (extra) return extraBox(extra, zone);
        if (spec.files[ref]?.zone !== zone.id) throw new Error(`tools/diagram/spec.js: zone "${zone.id}" places ${ref}, which is not one of its files or boxes`);
        return fileBox(ref, spec, graph);
    }));
}

/**
 * @typedef {{header: SceneRect, cells: (SceneRect | null)[][]}} MeasuredZone
 */

/**
 * @param {ZoneSpec} zone
 * @param {Spec} spec
 * @param {Graph} graph
 * @returns {MeasuredZone}
 */
function measureZone(zone, spec, graph) {
    const cells = zoneCells(zone, spec, graph);
    const columns = Math.max(1, ...cells.map((r) => r.length));
    const width = 2 * ZONE_PAD + columns * MAP_BOX_WIDTH + (columns - 1) * BOX_GAP;
    const header = box({ id: `zone:${zone.id}`, width, colour: zone.colour, kind: 'zone', dash: 'dashed' }, [
        { key: 'title', text: zone.title, font: 'body', size: SIZE.zone, colour: PALETTE[zone.colour].stroke },
        { key: 'note', text: zone.note ?? '', font: 'body', size: SIZE.body, colour: SOFT }
    ]);
    return { header, cells };
}

/**
 * One band of zones from (0, y). Headers, rows and box heights line up across the band, so
 * arrows between neighbouring rows run through the gaps between them.
 * @param {string[]} band  zone ids; '' leaves a gap one box wide
 * @param {Spec} spec
 * @param {Graph} graph
 * @param {number} y
 * @returns {{rects: SceneRect[], width: number, height: number}}
 */
function layoutBand(band, spec, graph, y) {
    const zones = band.map((id) => (id ? measureZone(zoneOf(spec, id), spec, graph) : null));
    const headerHeight = Math.max(0, ...zones.map((z) => z?.header.h ?? 0));
    const rowCount = Math.max(0, ...zones.map((z) => z?.cells.length ?? 0));
    const rowHeight = Array.from({ length: rowCount }, (_, i) => Math.max(0, ...zones.flatMap((z) => (z?.cells[i] ?? []).map((c) => c?.h ?? 0))));
    const height = headerHeight + rowHeight.reduce((sum, h) => sum + h + BOX_GAP, 0) - BOX_GAP + ZONE_PAD;
    /** @type {SceneRect[]} */
    const rects = [];
    let x = 0;
    for (const zone of zones) {
        if (!zone) {
            x += MAP_BOX_WIDTH + 2 * ZONE_PAD + ZONE_GAP;
            continue;
        }
        zone.header.h = height;
        place(zone.header, x, y);
        rects.push(zone.header);
        let top = y + headerHeight;
        zone.cells.forEach((row, i) => {
            const h = rowHeight[i] ?? 0;
            row.forEach((cell, col) => {
                if (!cell) return;
                cell.h = h;
                place(cell, x + ZONE_PAD + col * (MAP_BOX_WIDTH + BOX_GAP), top);
                rects.push(cell);
            });
            top += h + BOX_GAP;
        });
        x += zone.header.w + ZONE_GAP;
    }
    return { rects, width: x - ZONE_GAP, height };
}

/**
 * Adds the subtitle above content laid out from (0, 0) and wraps the frame around both.
 * @param {MapFrameSpec | FlowFrameSpec} spec
 * @param {SceneRect[]} rects
 * @param {{w: number, h: number}} content
 * @returns {SceneFrame}
 */
function frameAround(spec, rects, content) {
    const { texts, bottom } = stack(`${spec.id}:subtitle`, { x: FRAME_PAD, y: FRAME_PAD, width: content.w },
        [{ key: 'text', text: spec.subtitle ?? '', font: 'body', size: SIZE.subtitle, colour: SOFT }]);
    const top = texts.length ? bottom + 30 : FRAME_PAD;
    for (const r of rects) place(r, FRAME_PAD, top);
    return { id: `frame:${spec.id}`, name: spec.title, x: 0, y: 0, w: content.w + 2 * FRAME_PAD, h: top + content.h + FRAME_PAD, rects, arrows: [], texts };
}

/**
 * @param {MapFrameSpec} spec
 * @param {Spec} all
 * @param {Graph} graph
 * @returns {SceneFrame}
 */
function buildMap(spec, all, graph) {
    /** @type {SceneRect[]} */
    const rects = [];
    let y = 0;
    let width = 0;
    for (const band of spec.bands) {
        const laid = layoutBand(band, all, graph, y);
        rects.push(...laid.rects);
        width = Math.max(width, laid.width);
        y += laid.height + BAND_GAP;
    }
    const frame = frameAround(spec, rects, { w: width, h: y - BAND_GAP });
    const byId = new Map(rects.map((r) => [r.id, r]));
    /** @type {Edge[]} */
    const edges = [];
    for (const [from, to] of graph.drawn) {
        const a = byId.get(`file:${from}`);
        const b = byId.get(`file:${to}`);
        if (a && b) edges.push({ id: `edge:${from}->${to}`, from: a, to: b, kind: 'require' });
    }
    for (const link of spec.links ?? []) {
        edges.push({ id: `link:${link.from}->${link.to}`, from: rectFor(byId, link.from, spec.id), to: rectFor(byId, link.to, spec.id), kind: link.kind, label: link.label });
    }
    frame.arrows = route(edges);
    return frame;
}

/**
 * @param {StepSpec} step
 * @param {Spec} spec
 */
function stepColour(step, spec) {
    if (step.colour) return step.colour;
    if (step.kind === 'failure') return 'red';
    if (step.kind === 'note') return 'yellow';
    const zone = step.file ? spec.files[step.file]?.zone : undefined;
    return zone ? zoneOf(spec, zone).colour : 'grey';
}

/**
 * A heading (when the step has a title), the file, the symbols, the text; the step number
 * leads the first line.
 * @param {StepSpec} step
 * @param {FlowFrameSpec} frame
 * @param {Spec} spec
 */
function stepBox(step, frame, spec) {
    const number = step.n === undefined ? '' : `${step.n} · `;
    const dash = step.kind === 'outside' || step.kind === 'note' ? 'dashed' : 'solid';
    return box({ id: `step:${frame.id}:${step.id}`, width: frame.columnWidth ?? FLOW_BOX_WIDTH, colour: stepColour(step, spec), dash }, [
        { key: 'title', text: step.title ? `${number}${step.title}` : '', font: 'body', size: SIZE.heading, colour: INK },
        { key: 'file', text: step.file ? `${step.title ? '' : number}${step.file}` : '', font: 'code', size: SIZE.title, colour: INK },
        { key: 'symbol', text: step.symbol ?? '', font: 'code', size: SIZE.symbol, colour: SOFT },
        { key: 'text', text: step.text, font: 'body', size: SIZE.body, colour: INK }
    ]);
}

/**
 * A storyboard: steps on a grid of columns and rows, joined by arrows.
 * @param {FlowFrameSpec} spec
 * @param {Spec} all
 * @returns {SceneFrame}
 */
function buildFlow(spec, all) {
    const width = spec.columnWidth ?? FLOW_BOX_WIDTH;
    const boxes = spec.steps.map((s) => stepBox(s, spec, all));
    const rows = Math.max(...spec.steps.map((s) => s.at[1])) + 1;
    /** @type {number[]} */
    const rowTop = [];
    let y = 0;
    for (let row = 0; row < rows; row++) {
        rowTop.push(y);
        const inRow = boxes.filter((_, i) => spec.steps[i]?.at[1] === row);
        const height = Math.max(0, ...inRow.map((b) => b.h));
        for (const b of inRow) b.h = height;
        y += height + FLOW_GAP_Y;
    }
    let right = 0;
    spec.steps.forEach((step, i) => {
        const b = /** @type {SceneRect} */ (boxes[i]);
        place(b, Math.round(step.at[0] * (width + FLOW_GAP_X)), rowTop[step.at[1]] ?? 0);
        right = Math.max(right, b.x + b.w);
    });
    const frame = frameAround(spec, boxes, { w: right, h: y - FLOW_GAP_Y });
    const byId = new Map(spec.steps.map((s, i) => [s.id, /** @type {SceneRect} */ (boxes[i])]));
    frame.arrows = route(spec.edges.map(([from, to, label, kind]) => {
        const a = byId.get(from);
        const b = byId.get(to);
        if (!a || !b) throw new Error(`tools/diagram/spec.js: frame "${spec.id}" joins unknown step ${a ? to : from}`);
        return { id: `flow:${spec.id}:${from}->${to}`, from: a, to: b, kind: kind ?? 'flow', label };
    }));
    return frame;
}

/**
 * Moves a frame and everything in it by (dx, dy).
 * @param {SceneFrame} frame
 * @param {number} dx
 * @param {number} dy
 */
function shiftFrame(frame, dx, dy) {
    frame.x += dx;
    frame.y += dy;
    for (const r of frame.rects) place(r, dx, dy);
    for (const t of frame.texts) {
        t.x += dx;
        t.y += dy;
    }
    for (const a of frame.arrows) {
        a.points = a.points.map(([x, y]) => [x + dx, y + dy]);
        if (a.label) {
            a.label.x += dx;
            a.label.y += dy;
        }
    }
}

/**
 * Lays out every frame and arranges the frames on the canvas, row by row.
 * @param {Spec} spec
 * @returns {Scene}
 */
function buildScene(spec) {
    const graph = analyse(spec);
    const built = new Map(spec.frames.map((f) => [f.id, f.kind === 'map' ? buildMap(f, spec, graph) : buildFlow(f, spec)]));
    /** @type {SceneFrame[]} */
    const frames = [];
    let y = 0;
    for (const row of spec.canvas) {
        let x = 0;
        let height = 0;
        for (const id of row) {
            const frame = built.get(id);
            if (!frame) throw new Error(`tools/diagram/spec.js: canvas names unknown frame "${id}"`);
            shiftFrame(frame, x, y);
            frames.push(frame);
            x += frame.w + CANVAS_GAP;
            height = Math.max(height, frame.h);
        }
        y += height + CANVAS_GAP;
    }
    return { frames, roughness: spec.style.roughness };
}

module.exports = { buildScene, analyse, shortName, wrap, lineWidth, PALETTE, EDGE_STYLE, LINE_HEIGHT, ARROW_GAP, INK, MUTED };
