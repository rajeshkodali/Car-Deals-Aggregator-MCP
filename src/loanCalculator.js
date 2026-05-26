'use strict';

// Standard amortizing-loan monthly payment.
// Inputs:
//   price        — vehicle price in dollars (number > 0)
//   downPayment  — dollars down (number >= 0). Default 10% of price.
//   apr          — annual percentage rate as a percent (e.g. 7 for 7%). Default 7.
//   termMonths   — loan term in months. Default 60.
// Returns null if price is missing/invalid. Returns 0 if loan amount is 0 or negative.

function monthlyPayment({ price, downPayment, apr = 7, termMonths = 60 } = {}) {
    if (!Number.isFinite(price) || price <= 0) return null;
    if (!Number.isFinite(termMonths) || termMonths <= 0) return null;

    const dp = Number.isFinite(downPayment) ? downPayment : price * 0.10;
    const principal = price - dp;
    if (principal <= 0) return 0;

    const monthlyRate = (Number.isFinite(apr) ? apr : 7) / 100 / 12;
    if (monthlyRate === 0) {
        return Math.round((principal / termMonths) * 100) / 100;
    }
    const factor = Math.pow(1 + monthlyRate, termMonths);
    const payment = principal * monthlyRate * factor / (factor - 1);
    return Math.round(payment * 100) / 100;
}

// Parse a price string like "$23,491" -> 23491. Returns null on failure.
function parsePrice(s) {
    if (typeof s === 'number') return Number.isFinite(s) ? s : null;
    if (typeof s !== 'string') return null;
    const digits = s.replace(/[^0-9.]/g, '');
    if (!digits) return null;
    const n = Number(digits);
    return Number.isFinite(n) ? n : null;
}

// Build a full breakdown for a vehicle purchase.
//   - Sales tax is FINANCED into the loan principal (standard auto-loan practice):
//     financedPrincipal = price × (1 + salesTaxRate) − downPayment
//   - EV surcharge + registration are annual fees, amortized to /mo separately
//     (they're paid at registration time, not financed)
// All cost inputs default safely so the function is usable with partial data.
//
// Returns null when price is invalid; otherwise an object with the components
// callers want to render. Callers control which fields show up in output.
function totalCostBreakdown({
    price,
    downPayment,
    apr = 7,
    termMonths = 60,
    salesTaxRate = 0,
    evSurchargeAnnual = 0,
    registrationAnnual = 0,
    isElectric = false
} = {}) {
    if (!Number.isFinite(price) || price <= 0) return null;

    const taxRate = Number.isFinite(salesTaxRate) && salesTaxRate >= 0 ? salesTaxRate : 0;
    const salesTaxDollars = price * taxRate;
    const financedPrincipal = price + salesTaxDollars;

    const dp = Number.isFinite(downPayment) ? downPayment : financedPrincipal * 0.10;
    const loan = monthlyPayment({
        price: financedPrincipal,
        downPayment: dp,
        apr,
        termMonths
    });
    if (loan == null) return null;

    const evMonthly = isElectric && Number.isFinite(evSurchargeAnnual)
        ? evSurchargeAnnual / 12 : 0;
    const regMonthly = Number.isFinite(registrationAnnual)
        ? registrationAnnual / 12 : 0;
    const monthlyFees = Math.round((evMonthly + regMonthly) * 100) / 100;

    return {
        price,
        salesTaxRate: taxRate,
        salesTaxDollars: Math.round(salesTaxDollars * 100) / 100,
        financedPrincipal: Math.round(financedPrincipal * 100) / 100,
        downPayment: Math.round(dp * 100) / 100,
        loanMonthly: loan,
        evMonthly: Math.round(evMonthly * 100) / 100,
        registrationMonthly: Math.round(regMonthly * 100) / 100,
        monthlyFees
    };
}

module.exports = { monthlyPayment, parsePrice, totalCostBreakdown };
