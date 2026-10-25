(function () {
    'use strict';
    const E = window.AlicatEditor;

    RED.nodes.registerType('alicat-read', {
        category: 'Alicat',
        color: '#8BC6D8',
        defaults: {
            name: { value: '' },
            device: { value: '', type: 'alicat-device', required: true },
            trigger: { value: 'interval' },
            interval: { value: 1000, validate: E.range('read', 'interval') },
            dataset: { value: 'live' },
            output: { value: 'object' },
            reading: { value: 'massFlow' },
            emit: { value: 'always' },
            topic: { value: '' },
            contextScope: { value: 'global' },
            contextKey: { value: '' },
            contextStore: { value: '' }
        },
        inputs: 1,
        outputs: 1,
        icon: 'font-awesome/fa-tachometer',
        paletteLabel() { return this._('alicat-read.paletteLabel'); },
        label() {
            if (this.name) return this.name;
            const what = this.output === 'value' ? this.reading
                : (this.dataset === 'identity' ? this._('alicat-read.label.identity') : this._('alicat-read.label.default'));
            return this.trigger === 'interval' && this.dataset !== 'identity'
                ? this._('alicat-read.label.every', { what, seconds: this.interval / 1000 })
                : what;
        },
        inputLabels() { return this._('alicat-read.port.input'); },
        outputLabels() { return this._('alicat-read.port.output'); },
        oneditprepare() {
            E.fillContextStores($('#node-input-contextStore'), this.contextStore);
            const sync = function () {
                const live = $('#node-input-dataset').val() === 'live';
                const interval = $('#node-input-trigger').val() === 'interval' && live;
                $('#alicat-interval-row, #alicat-emit-row').toggle(interval);
                $('#alicat-reading-row').toggle($('#node-input-output').val() === 'value' && live);
                $('#alicat-output-row, #alicat-context').toggle(live);
            };
            $('#node-input-trigger, #node-input-dataset, #node-input-output').on('change', sync);
            sync();
        }
    });
})();
