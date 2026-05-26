'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { evSurchargeAnnual, registrationEstimateAnnual,
        EV_SURCHARGE_BY_STATE, REGISTRATION_ESTIMATE_BY_STATE } = require('../src/feeData.js');

test('evSurchargeAnnual returns known values', () => {
    assert.equal(evSurchargeAnnual('WA'), 300);
    assert.equal(evSurchargeAnnual('GA'), 213);
    assert.equal(evSurchargeAnnual('TX'), 200);
});

test('evSurchargeAnnual returns 0 for states with explicit no-fee', () => {
    assert.equal(evSurchargeAnnual('AK'), 0);
    assert.equal(evSurchargeAnnual('NY'), 0);
    assert.equal(evSurchargeAnnual('DC'), 0);
});

test('evSurchargeAnnual is case-insensitive', () => {
    assert.equal(evSurchargeAnnual('wa'), 300);
    assert.equal(evSurchargeAnnual('Wa'), 300);
});

test('evSurchargeAnnual returns null for unknown state', () => {
    assert.equal(evSurchargeAnnual('ZZ'), null);
    assert.equal(evSurchargeAnnual(''), null);
    assert.equal(evSurchargeAnnual(null), null);
    assert.equal(evSurchargeAnnual(undefined), null);
});

test('registrationEstimateAnnual returns known values', () => {
    assert.equal(registrationEstimateAnnual('WA'), 95);
    assert.equal(registrationEstimateAnnual('CA'), 300);
});

test('registrationEstimateAnnual is case-insensitive and handles unknown', () => {
    assert.equal(registrationEstimateAnnual('wa'), 95);
    assert.equal(registrationEstimateAnnual('ZZ'), null);
});

test('all 50 states + DC are present in both tables', () => {
    const states = ['AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY','DC'];
    for (const s of states) {
        assert.ok(s in EV_SURCHARGE_BY_STATE, `EV table missing ${s}`);
        assert.ok(s in REGISTRATION_ESTIMATE_BY_STATE, `registration table missing ${s}`);
    }
});

test('all values in both tables are non-negative integers', () => {
    for (const [k, v] of Object.entries(EV_SURCHARGE_BY_STATE)) {
        assert.ok(Number.isFinite(v) && v >= 0, `EV[${k}] = ${v}`);
    }
    for (const [k, v] of Object.entries(REGISTRATION_ESTIMATE_BY_STATE)) {
        assert.ok(Number.isFinite(v) && v >= 0, `REG[${k}] = ${v}`);
    }
});
