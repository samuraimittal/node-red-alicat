(function () {
    'use strict';

    RED.nodes.registerType('alicat-setpoint', {
        category: 'Alicat',
        color: '#8BC6D8',
        defaults: {
            name: { value: '' },
            device: { value: '', type: 'alicat-device', required: true },
            value: { value: 'payload', validate: RED.validators.typedInput({ typeField: 'valueType' }) },
            valueType: { value: 'msg' },
            variable: { value: 'current' },
            switchMode: { value: 'bumpless' },
            outOfRange: { value: 'reject' },
            verify: { value: true },
            savePowerUp: { value: false }
        },
        inputs: 1,
        outputs: 1,
        icon: 'font-awesome/fa-crosshairs',
        paletteLabel() { return this._('alicat-setpoint.paletteLabel'); },
        label() {
            if (this.name) return this.name;
            return this.variable && this.variable !== 'current' && this.variable !== 'msg'
                ? this._('alicat-setpoint.label.forVariable', { variable: this.variable })
                : this._('alicat-setpoint.label.default');
        },
        inputLabels() { return this._('alicat-setpoint.port.input'); },
        outputLabels() { return this._('alicat-setpoint.port.output'); },
        oneditprepare() {
            $('#node-input-value').typedInput({
                default: 'msg',
                typeField: $('#node-input-valueType'),
                types: ['msg', 'flow', 'global', 'num', 'str', 'env']
            });
            $('#node-input-variable').on('change', function () {
                $('#alicat-switch-row').toggle($(this).val() !== 'current');
            }).trigger('change');
        }
    });
})();
