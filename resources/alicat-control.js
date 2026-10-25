(function () {
    'use strict';
    const E = window.AlicatEditor;

    RED.nodes.registerType('alicat-control', {
        category: 'Alicat',
        color: '#8BC6D8',
        defaults: {
            name: { value: '' },
            device: { value: '', type: 'alicat-device', required: true },
            interval: { value: 500, validate: E.range('control', 'interval') },
            tolerance: { value: '', validate: E.optionalNumber(0) },
            correctionMs: { value: 1000, validate: E.range('control', 'correctionMs') },
            maxAttempts: { value: 5, validate: E.range('control', 'maxAttempts') },
            onExternalChange: { value: 'revert' },
            switchMode: { value: 'bumpless' }
        },
        inputs: 1,
        outputs: 1,
        icon: 'font-awesome/fa-anchor',
        paletteLabel() { return this._('alicat-control.paletteLabel'); },
        label() { return this.name || this._('alicat-control.label.default'); },
        inputLabels() { return this._('alicat-control.port.input'); },
        outputLabels() { return this._('alicat-control.port.output'); }
    });
})();
