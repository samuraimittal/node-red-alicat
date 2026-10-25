/**
 * Editor helpers shared by the alicat nodes. Every node's HTML loads this file
 * before its own script, so it must be safe to run more than once.
 */
(function () {
    'use strict';
    if (window.AlicatEditor) return;

    /** Catalog of the shared messages (the config node's, always loaded). */
    const NS = '@samuraimittal/node-red-alicat/alicat-device:';

    /**
     * The ranges the runtime enforces (lib/node-red/settings.js BOUNDS). The
     * editor can't load that module, so a test keeps the two tables equal.
     */
    const BOUNDS = {
        device: {
            port: { min: 1, max: 65535, default: 502, integer: true },
            unitId: { min: 0, max: 247, default: 1, integer: true },
            requestTimeout: { min: 100, max: 30000, default: 1000, integer: true },
            connectTimeout: { min: 500, max: 60000, default: 5000, integer: true },
            interFrameDelay: { min: 0, max: 1000, default: 20, integer: true },
            heartbeat: { min: 0, max: 15000, default: 5000, integer: true },
            backoffMax: { min: 1000, max: 300000, default: 30000, integer: true },
            maxQueue: { min: 10, max: 10000, default: 200, integer: true }
        },
        read: {
            interval: { min: 100, max: 3600000, default: 1000, integer: true }
        },
        control: {
            interval: { min: 100, max: 60000, default: 500, integer: true },
            correctionMs: { min: 100, max: 10000, default: 1000, integer: true },
            maxAttempts: { min: 1, max: 1000, default: 5, integer: true }
        },
        status: {
            periodic: { min: 0, max: 86400, default: 0, integer: false }
        }
    };

    /** @param {unknown} v */
    function isNumeric(v) {
        if (typeof v === 'number') return isFinite(v);
        return typeof v === 'string' && v.trim() !== '' && isFinite(Number(v));
    }

    /**
     * Validator for a numeric setting, from BOUNDS. Node-RED (3.1+) shows the
     * returned text when it asks for one (`opt`).
     * @param {string} group @param {string} key
     */
    function range(group, key) {
        const b = BOUNDS[group][key];
        return function (v, opt) {
            const n = Number(v);
            if (isNumeric(v) && n >= b.min && n <= b.max && (!b.integer || Math.floor(n) === n)) return true;
            return opt ? RED._(NS + (b.integer ? 'alicat.validation.intRange' : 'alicat.validation.numberRange'), { min: b.min, max: b.max }) : false;
        };
    }

    /** Empty (automatic), or a number of at least `min`. @param {number} min */
    function optionalNumber(min) {
        return function (v, opt) {
            if (v === '' || v === undefined || v === null || (isNumeric(v) && Number(v) >= min)) return true;
            return opt ? RED._(`${NS}alicat.validation.optionalNumber`, { min }) : false;
        };
    }

    /** Empty, or matching `re`. @param {RegExp} re @param {string} message key in the shared catalog */
    function pattern(re, message) {
        return function (v, opt) {
            if (v === '' || v === undefined || v === null || re.test(String(v))) return true;
            return opt ? RED._(NS + message) : false;
        };
    }

    /**
     * Turn a select into a list of the configured context stores, keeping a
     * configured store that no longer exists visible rather than dropping it.
     * @param {JQuery} select @param {string} current
     */
    function fillContextStores(select, current) {
        const context = RED.settings.context || {};
        const stores = context.stores || [];
        select.empty();
        $('<option>').val('').text(RED._(`${NS}alicat.context.defaultStore`, { store: context.default || 'memory' })).appendTo(select);
        stores.forEach(function (s) { $('<option>').val(s).text(s).appendTo(select); });
        if (current && stores.indexOf(current) === -1) {
            $('<option>').val(current).text(RED._(`${NS}alicat.context.missingStore`, { store: current })).appendTo(select);
        }
        select.val(current || '');
    }

    /**
     * A link that shows and hides a section, keeping aria-expanded in step.
     * @param {JQuery} toggle @param {JQuery} section
     */
    function disclosure(toggle, section) {
        toggle.attr({ role: 'button', 'aria-expanded': 'false', 'aria-controls': section.attr('id') });
        toggle.on('click', function (e) {
            e.preventDefault();
            const open = !section.is(':visible');
            section.toggle(open);
            toggle.attr('aria-expanded', String(open));
            toggle.find('i').toggleClass('fa-caret-right', !open).toggleClass('fa-caret-down', open);
        });
    }

    window.AlicatEditor = {
        NS,
        BOUNDS,
        range,
        optionalNumber,
        pattern,
        fillContextStores,
        disclosure
    };
})();
