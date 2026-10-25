(function () {
    'use strict';
    const E = window.AlicatEditor;

    RED.nodes.registerType('alicat-status', {
        category: 'Alicat',
        color: '#8BC6D8',
        defaults: {
            name: { value: '' },
            device: { value: '', type: 'alicat-device', required: true },
            periodic: { value: 0, validate: E.range('status', 'periodic') }
        },
        inputs: 1,
        outputs: 1,
        icon: 'font-awesome/fa-heartbeat',
        paletteLabel() { return this._('alicat-status.paletteLabel'); },
        label() { return this.name || this._('alicat-status.label.default'); },
        inputLabels() { return this._('alicat-status.port.input'); },
        outputLabels() { return this._('alicat-status.port.output'); }
    });
})();
