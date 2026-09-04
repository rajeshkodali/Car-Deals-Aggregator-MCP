'use strict';

// ZIP-level sales tax lookup. Two-tier strategy, same shape as the fetch-then-
// Puppeteer fallback used elsewhere in this project:
//
// 1. zip-tax.com (`fetchZipTax`) — keyed, documented, licensed-for-commercial-
//    -use REST API (https://docs.zip.tax/guides/rest-api/by-postal-code).
//    Requires ZIP_TAX_API_KEY in the environment. Tried first when the key is
//    present.
// 2. TaxJar's public widget calculator (`fetchTaxJar`) — no auth, no API key,
//    undocumented serverless function fronting TaxJar's published rate data.
//    Used when ZIP_TAX_API_KEY is unset, or when the zip.tax call throws.
//
// Both return the same normalized shape. Caveat that applies to both sources:
// this is the *general retail* sales tax rate. A handful of states (e.g. NC,
// AL) tax vehicle purchases at a different rate than retail; we don't model
// that override — disclaim it in the rendered output instead.

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';

const { fetchWithTimeout } = require('./httpClient.js');

const cache = new Map(); // zip -> result

// zip-tax.com can return multiple results for a single ZIP (ZIPs that span
// more than one city/tax jurisdiction, e.g. 98033 -> Kirkland + Redmond).
// We take the first result, matching the single-jurisdiction assumption the
// rest of this module (and TaxJar) already makes.
async function fetchZipTax(zip, apiKey) {
    const url = `https://api.zip-tax.com/request/v60?${new URLSearchParams({ postalcode: zip })}`;
    const res = await fetchWithTimeout(url, {
        headers: { 'X-API-KEY': apiKey },
        // zip.tax is called with a credential header; refuse to follow a redirect
        // rather than replay X-API-KEY to whatever host it points to (Undici only
        // strips Authorization on cross-origin redirects, not custom headers).
        redirect: 'error'
    }, { timeoutMs: 8_000, label: 'zip.tax' });
    if (res.status !== 200) throw new Error(`zip.tax HTTP ${res.status}`);
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { throw new Error('zip.tax returned non-JSON'); }
    if (data.rCode !== 100) throw new Error(`zip.tax rCode ${data.rCode}: ${JSON.stringify(data).slice(0, 150)}`);

    const r = Array.isArray(data.results) ? data.results[0] : null;
    if (!r) throw new Error('zip.tax response missing results');

    // Number(null|false|'') is 0, which is finite — that would silently coerce a
    // malformed response into a real (zero) rate instead of falling back to
    // TaxJar. Only accept an actual number or a non-blank string before coercing.
    const rawTaxSales = r.taxSales;
    const looksNumeric = typeof rawTaxSales === 'number'
        || (typeof rawTaxSales === 'string' && rawTaxSales.trim() !== '');
    if (!looksNumeric) throw new Error('zip.tax taxSales not numeric');
    const combined = Number(rawTaxSales);
    if (!Number.isFinite(combined)) throw new Error('zip.tax taxSales not numeric');

    return {
        zip: String(zip),
        state: r.geoState || null,
        city: r.geoCity || null,
        county: r.geoCounty || null,
        combinedRate: combined,
        stateRate: Number(r.stateSalesTax) || 0,
        countyRate: Number(r.countySalesTax) || 0,
        cityRate: Number(r.citySalesTax) || 0,
        districtRate: Number(r.districtSalesTax) || 0,
        source: 'zip-tax.com'
    };
}

async function fetchTaxJar(zip) {
    const url = `https://taxjar.netlify.app/.netlify/functions/calculator?street=&city=&zip=${encodeURIComponent(zip)}&country=US`;
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

    return {
        zip: String(zip),
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
}

async function lookupSalesTax(zip) {
    if (!zip) throw new Error('zip is required');
    const key = String(zip);
    if (cache.has(key)) return cache.get(key);

    const apiKey = process.env.ZIP_TAX_API_KEY;
    let out = null;
    if (apiKey) {
        try {
            out = await fetchZipTax(key, apiKey);
        } catch (err) {
            // Logged server-side only (stdio MCP process, no HTTP response path) —
            // never returned to a caller. Passed as a separate arg, not templated
            // into the message string, per njsscan's generic_error_disclosure rule.
            console.error('[feeClient] zip.tax lookup failed, falling back to TaxJar:', err.message);
        }
    }
    if (!out) out = await fetchTaxJar(key);

    cache.set(key, out);
    return out;
}

function _clearCache() { cache.clear(); }

module.exports = { lookupSalesTax, _clearCache };
