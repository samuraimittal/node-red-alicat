(function () {
    'use strict';
    const E = window.AlicatEditor;

    RED.nodes.registerType('alicat-command', {
        category: 'Alicat',
        color: '#8BC6D8',
        defaults: {
            name: { value: '' },
            device: { value: '', type: 'alicat-device', required: true },
            command: { value: 'tareFlow' },
            arg: { value: 'payload', validate: RED.validators.typedInput({ typeField: 'argType' }) },
            argType: { value: 'msg' },
            allowRaw: { value: false },
            rawId: { value: '', validate: E.pattern(/^\d+$/, 'alicat.validation.commandId') },
            rawArg: { value: '', validate: E.pattern(/^-?\d+(\.\d+)?$/, 'alicat.validation.argument') },
            fallbackSetpointZero: { value: false }
        },
        inputs: 1,
        outputs: 1,
        icon: 'font-awesome/fa-bolt',
        paletteLabel() { return this._('alicat-command.paletteLabel'); },
        label() {
            if (this.name) return this.name;
            const label = this._(`alicat-command.short.${this.command}`);
            return label === `alicat-command.short.${this.command}` ? this._('alicat-command.label.default') : label;
        },
        inputLabels() { return this._('alicat-command.port.input'); },
        outputLabels() { return this._('alicat-command.port.output'); },
        oneditprepare() {
            $('#node-input-arg').typedInput({
                default: 'msg',
                typeField: $('#node-input-argType'),
                types: ['msg', 'flow', 'global', 'str', 'num', 'env']
            });
            const sync = function () {
                const c = $('#node-input-command').val();
                $('#alicat-arg-row').toggle(c === 'selectGas');
                $('#alicat-raw-rows').toggle(c === 'raw');
                $('#alicat-raw-allow').toggle(c === 'raw' || c === 'msg');
                $('#alicat-fallback-row').toggle(c === 'holdClosed');
            };
            $('#node-input-command').on('change', sync);
            sync();
        }
    });
})();
