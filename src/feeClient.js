'use strict';

// ZIP-level sales tax lookup via TaxJar's public widget calculator endpoint:
//   GET https://taxjar.netlify.app/.netlify/functions/calculator?zip={zip}&country=US
//
// This is the same endpoint TaxJar's marketing-page calculator uses. No auth,
// no API key — it's a serverless function fronting their published rate data.
// Posture is the same as cars.com / autotrader: undocumented public endpoint,
// could change shape any time, callers must handle failure gracefully.
//
// Returns combined city + county + state + district rate for the ZIP. Caveat:
// returns the *general retail* sales tax rate. A handful of states (e.g. NC,
// AL) tax vehicle purchases at a different rate than retail; we don't model
// that override — disclaim it in the rendered output instead.

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';

const { fetchWithTimeout } = require('./httpClient.js');

const cache = new Map(); // zip -> result

async function lookupSalesTax(zip) {
    if (!zip) throw new Error('zip is required');
    const key = String(zip);
    if (cache.has(key)) return cache.get(key);

    const url = `https://taxjar.netlify.app/.netlify/functions/calculator?street=&city=&zip=${encodeURIComponent(key)}&country=US`;
    const res = await fetchWithTimeout(url, {
        headers: {
            'accept': 'application/json, text/javascript, */*; q=0.01',
            'accept-language': 'en-US,en;q=0.9',
            'origin': 'https://www.taxjar.com',
            'referer': 'https://www.taxjar.com/sales-tax-calculator',
            'user-agent': UA
        }
    }, { timeoutMs: 8_000, label: 'TaxJar' });
    if (res.status !== 200) throw new Error(`TaxJar HTTP ${res.status}`);
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { throw new Error('TaxJar returned non-JSON'); }

    const r = data && data.rate;
    if (!r) throw new Error('TaxJar response missing `rate`');

    const combined = Number(r.combined_rate);
    if (!Number.isFinite(combined)) throw new Error('TaxJar combined_rate not numeric');

    const out = {
        zip: key,
        state: r.state || null,
        city: r.city || null,
        county: r.county || null,
        combinedRate: combined,
        stateRate: Number(r.state_rate) || 0,
        countyRate: Number(r.county_rate) || 0,
        cityRate: Number(r.city_rate) || 0,
        districtRate: Number(r.combined_district_rate) || 0,
        source: 'taxjar.com calculator widget'
    };
    cache.set(key, out);
    return out;
}

function _clearCache() { cache.clear(); }

module.exports = { lookupSalesTax, _clearCache };
