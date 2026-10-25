'use strict';

// Writes a laid-out scene (./layout.js) as an Excalidraw file (format version 2).
// Ids come from the spec and seeds from a hash of the id, so the file only changes
// when the diagram does. Development tool, not shipped.

const { EDGE_STYLE, LINE_HEIGHT, INK, ARROW_GAP } = require('./layout');

/** @import {Scene, SceneFrame, SceneRect, SceneText, SceneArrow} from './layout' */

/** Helvetica and Cascadia: available in every Excalidraw version, unlike the newer fonts. */
const FONT_FAMILY = { body: 2, code: 3 };

/**
 * FNV-1a, folded to a positive 31-bit integer: a stable seed per element.
 * @param {string} text
 */
function hash(text) {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
        h ^= text.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return (h >>> 1) || 1;
}

/**
 * The properties every element has.
 * @param {string} id
 * @param {string} type
 * @param {{x: number, y: number, w: number, h: number}} at
 * @param {string | null} frameId
 */
function base(id, type, at, frameId) {
    return {
        id,
        type,
        x: at.x,
        y: at.y,
        width: at.w,
        height: at.h,
        angle: 0,
        strokeColor: INK,
        backgroundColor: 'transparent',
        fillStyle: 'solid',
        strokeWidth: 1,
        strokeStyle: 'solid',
        roughness: 0,
        opacity: 100,
        groupIds: /** @type {string[]} */ ([]),
        frameId,
        roundness: /** @type {{type: number} | null} */ (null),
        seed: hash(id),
        version: 1,
        versionNonce: hash(`${id}#`),
        isDeleted: false,
        boundElements: /** @type {{type: 'arrow' | 'text', id: string}[] | null} */ (null),
        updated: 1,
        link: null,
        locked: false
    };
}

/**
 * @param {SceneText} t
 * @param {string} frameId
 * @param {string[]} groupIds
 * @param {string | null} containerId  the arrow a label belongs to
 */
function textElement(t, frameId, groupIds, containerId = null) {
    return {
        ...base(t.id, 'text', t, frameId),
        strokeColor: t.colour,
        groupIds,
        text: t.text,
        fontSize: t.size,
        fontFamily: FONT_FAMILY[t.font],
        textAlign: t.align,
        verticalAlign: containerId ? 'middle' : 'top',
        containerId,
        originalText: t.text,
        autoResize: true,
        lineHeight: LINE_HEIGHT
    };
}

/**
 * A rectangle, then its texts, grouped so they move together.
 * @param {SceneRect} rect
 * @param {string} frameId
 * @param {{type: 'arrow', id: string}[]} arrows bound to it
 * @param {number} roughness
 */
function rectElements(rect, frameId, arrows, roughness) {
    const groupIds = [`group:${rect.id}`];
    return [
        {
            ...base(rect.id, 'rectangle', rect, frameId),
            strokeColor: rect.stroke,
            backgroundColor: rect.fill,
            strokeWidth: rect.kind === 'zone' ? 1 : 1.5,
            strokeStyle: rect.dash,
            roughness,
            groupIds,
            roundness: { type: 3 },
            boundElements: arrows.length ? arrows : null
        },
        ...rect.texts.map((t) => textElement(t, frameId, groupIds))
    ];
}

/**
 * An arrow bound to the boxes at both ends, and its label.
 * @param {SceneArrow} arrow
 * @param {string} frameId
 * @param {number} roughness
 */
function arrowElements(arrow, frameId, roughness) {
    const [x0, y0] = arrow.points[0] ?? [0, 0];
    const points = arrow.points.map(([x, y]) => [x - x0, y - y0]);
    const xs = points.map(([x]) => x ?? 0);
    const ys = points.map(([, y]) => y ?? 0);
    const style = EDGE_STYLE[arrow.kind];
    const at = { x: x0, y: y0, w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
    const element = {
        ...base(arrow.id, 'arrow', at, frameId),
        strokeColor: style.stroke,
        strokeWidth: style.width,
        strokeStyle: style.dash,
        roughness,
        boundElements: arrow.label ? [{ type: /** @type {const} */ ('text'), id: arrow.label.id }] : null,
        points,
        lastCommittedPoint: null,
        startBinding: { elementId: arrow.from, focus: 0, gap: ARROW_GAP },
        endBinding: { elementId: arrow.to, focus: 0, gap: ARROW_GAP },
        startArrowhead: null,
        endArrowhead: 'arrow',
        elbowed: false
    };
    return arrow.label ? [element, textElement(arrow.label, frameId, [], arrow.id)] : [element];
}

/**
 * The frame first, then its zones and boxes, then the arrows on top.
 * @param {SceneFrame} frame
 * @param {number} roughness
 */
function frameElements(frame, roughness) {
    /** @type {Map<string, {type: 'arrow', id: string}[]>} */
    const bound = new Map();
    for (const a of frame.arrows) {
        for (const end of [a.from, a.to]) bound.set(end, [...(bound.get(end) ?? []), { type: 'arrow', id: a.id }]);
    }
    return [
        { ...base(frame.id, 'frame', frame, null), strokeColor: '#bbbbbb', name: frame.name },
        ...frame.texts.map((t) => textElement(t, frame.id, [])),
        ...frame.rects.flatMap((r) => rectElements(r, frame.id, bound.get(r.id) ?? [], roughness)),
        ...frame.arrows.flatMap((a) => arrowElements(a, frame.id, roughness))
    ];
}

/**
 * The scene as an .excalidraw file: one element per line, so a change shows as a small diff.
 * @param {Scene} scene
 * @returns {string}
 */
function toExcalidraw(scene) {
    const elements = scene.frames.flatMap((f) => frameElements(f, scene.roughness));
    const lines = elements.map((e) => `    ${JSON.stringify(e)}`);
    return [
        '{',
        '  "type": "excalidraw",',
        '  "version": 2,',
        '  "source": "@samuraimittal/node-red-alicat: tools/architecture-diagram.js (generated; edit tools/diagram/spec.js)",',
        '  "elements": [',
        lines.join(',\n'),
        '  ],',
        `  "appState": ${JSON.stringify({ viewBackgroundColor: '#ffffff', gridSize: 20 })},`,
        '  "files": {}',
        '}',
        ''
    ].join('\n');
}

module.exports = { toExcalidraw, hash };
