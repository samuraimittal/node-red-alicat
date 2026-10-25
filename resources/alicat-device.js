(function () {
    'use strict';
    const E = window.AlicatEditor;

    /** @param {string} key @param {object} [vars] */
    function t(key, vars) {
        return RED._(`@samuraimittal/node-red-alicat/alicat-device:alicat-device.${key}`, vars);
    }

    /** The probe's answer, as lines for the result box. */
    function describe(r) {
        const id = r.identity;
        const s = r.snapshot;
        const lines = [
            t('test.connected', { ms: r.elapsedMs }) + (r.reused ? ` ${t('test.reused')}` : ''),
            id.generation === 'gen2'
                ? t('test.firmware', { firmware: id.firmware }) + (id.serial ? t('test.serial', { serial: id.serial }) : '')
                : t('test.gen1'),
            t('test.controls', { variable: id.controlledVariable || t('test.controlsUnknown') }),
            t('test.gas', { gas: s.gas.symbol }) + (s.status.length ? t('test.status', { status: s.status.join(', ') }) : '')
        ];
        Object.keys(s.values).forEach(function (k) {
            const v = s.values[k];
            lines.push(`  ${k}: ${v === null ? '—' : Number(v.toPrecision(5))} ${s.units[k] || ''}`);
        });
        if (r.hint) lines.push(`⚠ ${r.hint}`);
        return lines.join('\n');
    }

    RED.nodes.registerType('alicat-device', {
        category: 'config',
        defaults: {
            name: { value: '' },
            host: {
                value: '', required: true,
                validate(v, opt) {
                    if (typeof v === 'string' && v.trim().length > 0 && !/[\s/]/.test(v.trim())) return true;
                    return opt ? RED._(`${E.NS}alicat.validation.host`) : false;
                }
            },
            port: { value: 502, required: true, validate: E.range('device', 'port') },
            unitId: { value: 1, required: true, validate: E.range('device', 'unitId') },
            mapMode: { value: 'auto' },
            deviceType: { value: 'auto' },
            layout: { value: 'auto' },
            customLayout: { value: '', validate: E.pattern(/^\s*[A-Za-z]+(\s*,\s*[A-Za-z]+)*\s*$/, 'alicat.validation.slots') },
            controlVariable: { value: 'unknown' },
            unitLabels: { value: '' },
            requestTimeout: { value: 1000, validate: E.range('device', 'requestTimeout') },
            connectTimeout: { value: 5000, validate: E.range('device', 'connectTimeout') },
            interFrameDelay: { value: 20, validate: E.range('device', 'interFrameDelay') },
            heartbeat: { value: 5000, validate: E.range('device', 'heartbeat') },
            backoffMax: { value: 30000, validate: E.range('device', 'backoffMax') },
            maxQueue: { value: 200, validate: E.range('device', 'maxQueue') },
            trace: { value: false }
        },
        label() {
            return this.name || (`${this.host || this._('alicat-device.label.default')}:${this.port || 502}`);
        },
        oneditprepare() {
            const layoutRow = $('#alicat-custom-layout-row');
            $('#node-config-input-layout').on('change', function () {
                layoutRow.toggle($(this).val() === 'custom');
            }).trigger('change');

            E.disclosure($('#alicat-advanced-toggle'), $('#alicat-advanced'));

            const out = $('#alicat-test-result');
            $('#alicat-test-button').on('click', function (e) {
                e.preventDefault();
                const button = $(this);
                let layout = $('#node-config-input-layout').val();
                if (layout === 'custom') layout = $('#node-config-input-customLayout').val().split(',').map(function (s) { return s.trim(); }).filter(Boolean);
                if (layout === 'auto') layout = null;
                button.prop('disabled', true);
                out.removeClass('alicat-ok alicat-fail').text(t('test.running')).show();
                $.ajax({
                    url: 'alicat-modbus/probe',
                    type: 'POST',
                    contentType: 'application/json',
                    data: JSON.stringify({
                        host: $('#node-config-input-host').val(),
                        port: Number($('#node-config-input-port').val()),
                        unitId: Number($('#node-config-input-unitId').val()),
                        mapMode: $('#node-config-input-mapMode').val(),
                        deviceType: $('#node-config-input-deviceType').val(),
                        layout
                    })
                }).done(function (r) {
                    if (!r.ok) {
                        out.addClass('alicat-fail').text(`✗ ${r.code}: ${r.message}${r.hint ? `\n${r.hint}` : ''}`);
                        return;
                    }
                    out.addClass('alicat-ok').text(describe(r));
                }).fail(function (xhr) {
                    const body = xhr.responseJSON || {};
                    out.addClass('alicat-fail').text(`✗ ${body.message || xhr.statusText || t('test.failed')}`);
                }).always(function () {
                    button.prop('disabled', false);
                });
            });
        }
    });
})();
