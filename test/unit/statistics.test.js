'use strict';

const assert = require('node:assert/strict');
const statistics = require('../../lib/alicat/statistics');
const { throwsCode } = require('../helpers/assert');

describe('alicat/statistics', () => {
    it('maps setpoint types to the controlled variable (45 = valve drive, seen on a 10v20 unit)', () => {
        assert.equal(statistics.controlledVariableFromSetpointType(37), 'massFlow');
        assert.equal(statistics.controlledVariableFromSetpointType(38), 'gaugePressure');
        assert.equal(statistics.controlledVariableFromSetpointType(34), 'absolutePressure');
        assert.equal(statistics.controlledVariableFromSetpointType(45), 'valveDrive');
        assert.equal(statistics.controlledVariableFromSetpointType(1), null);
        assert.equal(statistics.controlledVariableFromSetpointType(5), null);
    });

    it('decodes loop-variable answers given as 0–4 or as Appendix A codes', () => {
        assert.equal(statistics.controlledVariableFromLoopValue(0), 'massFlow');
        assert.equal(statistics.controlledVariableFromLoopValue(4), 'gaugePressure');
        assert.equal(statistics.controlledVariableFromLoopValue(45), 'valveDrive');
        assert.equal(statistics.controlledVariableFromLoopValue(999), null);
    });

    it('treats type 0 (seen on hardware) and 1 as absent; unknown types get a generic key', () => {
        assert.equal(statistics.isAbsent(0), true);
        assert.equal(statistics.isAbsent(1), true);
        assert.equal(statistics.isAbsent(2), false);
        assert.equal(statistics.isKnown(45), true);
        assert.equal(statistics.isKnown(999), false);
        assert.equal(statistics.statistic(999).key, 'statistic999');
    });

    it('knows the loop arguments for each control variable', () => {
        assert.equal(statistics.controlVariable('massFlow').loopArg, 0);
        assert.equal(statistics.controlVariable('gaugePressure').loopArg, 4);
        assert.equal(statistics.controlVariable('valveDrive').loopArg, 45);
        throwsCode(() => statistics.controlVariable('flux'), 'EINVALIDARG');
    });
});
