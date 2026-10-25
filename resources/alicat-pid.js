(function () {
    'use strict';

    /** A gain source: empty means "leave this gain unchanged". @param {string} name */
    function gain(name) {
        return { value: `payload.${name}`, validate: RED.validators.typedInput({ typeField: `${name}GainType`, allowBlank: true }) };
    }

    RED.nodes.registerType('alicat-pid', {
        category: 'Alicat',
        color: '#8BC6D8',
        defaults: {
            name: { value: '' },
            device: { value: '', type: 'alicat-device', required: true },
            action: { value: 'read' },
            // Not p/d/i: Node-RED reserves `d` for "node disabled".
            pGain: gain('p'),
            pGainType: { value: 'msg' },
            dGain: gain('d'),
            dGainType: { value: 'msg' },
            iGain: gain('i'),
            iGainType: { value: 'msg' },
            algorithm: { value: 'PDF' }
        },
        inputs: 1,
        outputs: 1,
        icon: 'font-awesome/fa-sliders',
        paletteLabel() { return this._('alicat-pid.paletteLabel'); },
        label() {
            return this.name || this._(`alicat-pid.label.${this.action === 'write' ? 'write' : this.action === 'algorithm' ? 'algorithmNode' : 'read'}`);
        },
        inputLabels() { return this._('alicat-pid.port.input'); },
        outputLabels() { return this._('alicat-pid.port.output'); },
        oneditprepare() {
            ['pGain', 'dGain', 'iGain'].forEach(function (g) {
                $(`#node-input-${g}`).typedInput({
                    default: 'msg',
                    typeField: $(`#node-input-${g}Type`),
                    types: ['msg', 'flow', 'global', 'num', 'env']
                });
            });
            $('#node-input-action').on('change', function () {
                $('#alicat-gains').toggle($(this).val() === 'write');
                $('#alicat-algorithm-row').toggle($(this).val() === 'algorithm');
            }).trigger('change');
        }
    });
})();
