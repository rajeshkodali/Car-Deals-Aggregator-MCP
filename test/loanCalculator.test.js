'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { monthlyPayment, parsePrice, totalCostBreakdown } = require('../src/loanCalculator.js');

// Reference values verified with the standard amortization formula:
//   M = P * r * (1+r)^n / ((1+r)^n - 1)

test('monthlyPayment computes amortized payment with explicit downPayment', () => {
    // $20,000 loan @ 7%/yr over 60 mo => $396.02/mo (rounded)
    const m = monthlyPayment({ price: 25000, downPayment: 5000, apr: 7, termMonths: 60 });
    assert.equal(m, 396.02);
});

test('monthlyPayment defaults downPayment to 10% of price', () => {
    // 22500 @ 7% over 60 => 445.52 (= monthlyPayment with explicit dp=2500)
    const a = monthlyPayment({ price: 25000, apr: 7, termMonths: 60 });
    const b = monthlyPayment({ price: 25000, downPayment: 2500, apr: 7, termMonths: 60 });
    assert.equal(a, b);
});

test('monthlyPayment defaults apr=7 and termMonths=60', () => {
    const explicit = monthlyPayment({ price: 25000, downPayment: 2500, apr: 7, termMonths: 60 });
    const defaults = monthlyPayment({ price: 25000, downPayment: 2500 });
    assert.equal(explicit, defaults);
});

test('monthlyPayment handles zero APR (straight-line)', () => {
    const m = monthlyPayment({ price: 12000, downPayment: 0, apr: 0, termMonths: 24 });
    assert.equal(m, 500); // 12000 / 24
});

test('monthlyPayment returns 0 when down payment >= price', () => {
    assert.equal(monthlyPayment({ price: 10000, downPayment: 10000, apr: 7, termMonths: 60 }), 0);
    assert.equal(monthlyPayment({ price: 10000, downPayment: 12000, apr: 7, termMonths: 60 }), 0);
});

test('monthlyPayment returns null on invalid inputs', () => {
    assert.equal(monthlyPayment({ price: 0 }), null);
    assert.equal(monthlyPayment({ price: -100 }), null);
    assert.equal(monthlyPayment({}), null);
    assert.equal(monthlyPayment({ price: 'abc' }), null);
    assert.equal(monthlyPayment({ price: 10000, termMonths: 0 }), null);
});

test('parsePrice strips currency formatting', () => {
    assert.equal(parsePrice('$23,491'), 23491);
    assert.equal(parsePrice('$1,234,567'), 1234567);
    assert.equal(parsePrice('23491'), 23491);
    assert.equal(parsePrice('USD 23,491.50'), 23491.50);
    assert.equal(parsePrice(23491), 23491);
});

test('parsePrice returns null for non-parseable values', () => {
    assert.equal(parsePrice(null), null);
    assert.equal(parsePrice(undefined), null);
    assert.equal(parsePrice(''), null);
    assert.equal(parsePrice('Contact Seller'), null);
    assert.equal(parsePrice({}), null);
});

// ---------- totalCostBreakdown ----------

test('totalCostBreakdown finances tax into principal and matches a manual calc', () => {
    // $30,000 car, 10% sales tax, 10% down, 7% APR, 60mo
    //   financedPrincipal = 30000 * 1.10 = 33000
    //   downPayment = 33000 * 0.10 = 3300
    //   loaned = 29700; monthlyRate = 7/12/100 = 0.005833...
    //   payment = 29700 * 0.005833 * (1.005833^60) / (1.005833^60 - 1) ≈ 587.92
    const b = totalCostBreakdown({
        price: 30000,
        salesTaxRate: 0.10,
        apr: 7,
        termMonths: 60
    });
    assert.equal(b.salesTaxDollars, 3000);
    assert.equal(b.financedPrincipal, 33000);
    assert.equal(b.downPayment, 3300);
    // Manual amortization:
    const r = 7/12/100;
    const f = Math.pow(1+r, 60);
    const expected = Math.round((29700 * r * f / (f-1)) * 100) / 100;
    assert.equal(b.loanMonthly, expected);
});

test('totalCostBreakdown adds EV surcharge only when isElectric=true', () => {
    const ev = totalCostBreakdown({
        price: 30000, salesTaxRate: 0.06, apr: 5, termMonths: 60,
        evSurchargeAnnual: 300, registrationAnnual: 60, isElectric: true
    });
    const ice = totalCostBreakdown({
        price: 30000, salesTaxRate: 0.06, apr: 5, termMonths: 60,
        evSurchargeAnnual: 300, registrationAnnual: 60, isElectric: false
    });
    assert.equal(ev.evMonthly, 25); // 300/12
    assert.equal(ice.evMonthly, 0);
    assert.equal(ev.registrationMonthly, 5); // 60/12
    assert.equal(ice.registrationMonthly, 5);
    assert.equal(ev.monthlyFees, 30);
    assert.equal(ice.monthlyFees, 5);
});

test('totalCostBreakdown defaults missing fee inputs to zero', () => {
    const b = totalCostBreakdown({ price: 25000, apr: 5, termMonths: 60 });
    assert.equal(b.salesTaxRate, 0);
    assert.equal(b.salesTaxDollars, 0);
    assert.equal(b.evMonthly, 0);
    assert.equal(b.registrationMonthly, 0);
    assert.equal(b.monthlyFees, 0);
    assert.equal(b.financedPrincipal, 25000);
});

test('totalCostBreakdown returns null on bad price', () => {
    assert.equal(totalCostBreakdown({ price: 0 }), null);
    assert.equal(totalCostBreakdown({ price: -100 }), null);
    assert.equal(totalCostBreakdown({}), null);
});

test('totalCostBreakdown applies an explicit downPayment over the 10% default', () => {
    const a = totalCostBreakdown({ price: 30000, salesTaxRate: 0, downPayment: 6000, apr: 5, termMonths: 60 });
    const b = totalCostBreakdown({ price: 30000, salesTaxRate: 0, apr: 5, termMonths: 60 });
    assert.equal(a.downPayment, 6000);
    assert.equal(b.downPayment, 3000); // 10% default
    assert.ok(a.loanMonthly < b.loanMonthly, 'larger down payment lowers monthly');
});
