'use strict';

const assert = require('node:assert/strict');
const { unitLabel } = require('../../lib/alicat/units');

describe('alicat/units', () => {
    it('picks the table by category, since codes collide across tables', () => {
        assert.equal(unitLabel('massFlow', 7), 'SLPM');
        assert.equal(unitLabel('massFlow', 12), 'SCCM');
        assert.equal(unitLabel('volumetricFlow', 7), 'LPM');
        assert.equal(unitLabel('pressure', 7), 'bar');
        assert.equal(unitLabel('massFlow', 70), 'kg/h');
        assert.equal(unitLabel('temperature', 2), '°C');
        assert.equal(unitLabel('percent', 63), '%');
        assert.equal(unitLabel('totalMass', 4), 'SL');
        assert.equal(unitLabel('totalVolume', 5), 'US gal');
    });

    it('adds the pressure reference (PSIA / PSIG / PSID, or a suffix for other units)', () => {
        assert.equal(unitLabel('pressure', 10, 'absolute'), 'PSIA');
        assert.equal(unitLabel('pressure', 10, 'gauge'), 'PSIG');
        assert.equal(unitLabel('pressure', 10, 'differential'), 'PSID');
        assert.equal(unitLabel('pressure', 10, 'barometric'), 'PSIA');
        assert.equal(unitLabel('pressure', 4, 'gauge'), 'kPa g');
        assert.equal(unitLabel('pressure', 10), 'PSI');
    });

    it('labels unknown codes visibly', () => {
        assert.equal(unitLabel('pressure', 99), 'units#99');
        assert.equal(unitLabel(/** @type {any} */ ('nonsense'), 0), '');
    });
});
