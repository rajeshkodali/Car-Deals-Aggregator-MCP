'use strict';

// Static state-level fee tables. Coarse by design — see CLAUDE.md for honest
// limitations. Refresh when rates change.
//
// Sources:
//   EV surcharge: NCSL, "Special Fees on Plug-In Hybrid and Electric Vehicles"
//     https://www.ncsl.org/transportation/special-fees-on-plug-in-hybrid-and-electric-vehicles
//   Registration: each state's DOL/DMV fee schedule (linked per row).
// Last verified: 2026-05.
//
// Numbers are annual dollars. `null` = state has no such fee or it varies too
// much to give a single number (we'll skip that line in output).

// Annual EV surcharge ($/yr). 0 = state has explicitly no EV fee. null = not
// modeled. Plug-in hybrids often get a smaller fee — we use the BEV number.
const EV_SURCHARGE_BY_STATE = {
    AL: 200, AK: 0,   AZ: 0,   AR: 200,
    CA: 118, CO: 51,  CT: 0,   DE: 0,
    FL: 0,   GA: 213, HI: 50,  ID: 140,
    IL: 100, IN: 221, IA: 130, KS: 100,
    KY: 120, LA: 110, ME: 0,   MD: 125,
    MA: 0,   MI: 100, MN: 75,  MS: 150,
    MO: 75,  MT: 0,   NE: 75,  NV: 0,
    NH: 100, NJ: 0,   NM: 0,   NY: 0,
    NC: 180, ND: 120, OH: 200, OK: 110,
    OR: 110, PA: 0,   RI: 0,   SC: 120,
    SD: 50,  TN: 200, TX: 200, UT: 130,
    VT: 0,   VA: 116, WA: 300, WV: 200,
    WI: 175, WY: 200,
    DC: 0
};

// Coarse annual registration estimate ($/yr). Most states' real fees are
// weight- or value-based; this is a typical-passenger-car placeholder. Not
// shown alone — bundles into the "fees" line with a clear disclaimer.
const REGISTRATION_ESTIMATE_BY_STATE = {
    AL: 23,  AK: 100, AZ: 100, AR: 27,
    CA: 300, CO: 200, CT: 120, DE: 40,
    FL: 50,  GA: 20,  HI: 45,  ID: 70,
    IL: 155, IN: 22,  IA: 100, KS: 40,
    KY: 21,  LA: 60,  ME: 35,  MD: 135,
    MA: 60,  MI: 120, MN: 60,  MS: 14,
    MO: 24,  MT: 87,  NE: 15,  NV: 33,
    NH: 32,  NJ: 60,  NM: 30,  NY: 75,
    NC: 36,  ND: 49,  OH: 31,  OK: 96,
    OR: 112, PA: 39,  RI: 30,  SC: 40,
    SD: 36,  TN: 27,  TX: 51,  UT: 44,
    VT: 76,  VA: 41,  WA: 95,  WV: 28,
    WI: 85,  WY: 30,
    DC: 72
};

function evSurchargeAnnual(state) {
    if (!state) return null;
    const v = EV_SURCHARGE_BY_STATE[state.toUpperCase()];
    return Number.isFinite(v) ? v : null;
}

function registrationEstimateAnnual(state) {
    if (!state) return null;
    const v = REGISTRATION_ESTIMATE_BY_STATE[state.toUpperCase()];
    return Number.isFinite(v) ? v : null;
}

module.exports = {
    EV_SURCHARGE_BY_STATE,
    REGISTRATION_ESTIMATE_BY_STATE,
    evSurchargeAnnual,
    registrationEstimateAnnual
};
