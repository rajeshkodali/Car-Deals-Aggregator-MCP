'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const feeClientPath = require.resolve('../src/feeClient.js');
function load() {
    delete require.cache[feeClientPath];
    return require('../src/feeClient.js');
}

function fetchResp({ status = 200, body = '' } = {}) {
    return { status, async text() { return typeof body === 'string' ? body : JSON.stringify(body); } };
}
function withFetchStub(stub, fn) {
    const prev = global.fetch;
    global.fetch = stub;
    return Promise.resolve(fn()).finally(() => { global.fetch = prev; });
}
// Exact hostname match, not a bare substring check — a `.includes('zip-tax.com')`
// check would also match e.g. `https://evil.com/zip-tax.com` (CodeQL flags this
// pattern as "Incomplete URL substring sanitization" even in test fixtures).
function isZipTaxUrl(url) {
    return new URL(String(url)).hostname === 'api.zip-tax.com';
}
// Tests exercise both the zip.tax path and the TaxJar fallback, gated on
// ZIP_TAX_API_KEY. Save/restore around every test so a real key present in
// the runner's own shell env (or lack thereof) can't make results
// environment-dependent.
function withZipTaxKey(value, fn) {
    const prev = process.env.ZIP_TAX_API_KEY;
    if (value == null) delete process.env.ZIP_TAX_API_KEY;
    else process.env.ZIP_TAX_API_KEY = value;
    return Promise.resolve(fn()).finally(() => {
        if (prev == null) delete process.env.ZIP_TAX_API_KEY;
        else process.env.ZIP_TAX_API_KEY = prev;
    });
}

// HAR-shaped happy response (TaxJar)
const KIRKLAND_RESPONSE = {
    rate: {
        state: 'WA', zip: '98033', city: 'KIRKLAND', country: 'US', freight_taxable: true,
        combined_rate: '0.104', state_rate: '0.065', county: 'KING', county_rate: '0.005',
        city_rate: '0.011', combined_district_rate: '0.023', country_rate_str: '0.0'
    }
};

// ---------- TaxJar path (no ZIP_TAX_API_KEY) ----------

test('lookupSalesTax hits the calculator with the expected URL and returns parsed numbers', async () => {
    await withZipTaxKey(null, async () => {
        const fc = load();
        let captured = null;
        await withFetchStub(async (url) => {
            captured = url;
            return fetchResp({ body: KIRKLAND_RESPONSE });
        }, async () => {
            const out = await fc.lookupSalesTax('98033');
            assert.equal(out.state, 'WA');
            assert.equal(out.city, 'KIRKLAND');
            assert.equal(out.county, 'KING');
            assert.equal(out.combinedRate, 0.104);
            assert.equal(out.stateRate, 0.065);
            assert.equal(out.countyRate, 0.005);
            assert.equal(out.cityRate, 0.011);
            assert.equal(out.districtRate, 0.023);
            assert.equal(out.source, 'taxjar.com calculator widget');
        });
        assert.ok(captured.startsWith('https://taxjar.netlify.app/.netlify/functions/calculator'));
        assert.ok(captured.includes('zip=98033'));
        assert.ok(captured.includes('country=US'));
    });
});

test('lookupSalesTax caches per-ZIP for the process lifetime', async () => {
    await withZipTaxKey(null, async () => {
        const fc = load();
        fc._clearCache();
        let calls = 0;
        await withFetchStub(async () => {
            calls += 1;
            return fetchResp({ body: KIRKLAND_RESPONSE });
        }, async () => {
            await fc.lookupSalesTax('98033');
            await fc.lookupSalesTax('98033');
            await fc.lookupSalesTax('98033');
        });
        assert.equal(calls, 1, 'second/third lookups served from cache');
    });
});

test('lookupSalesTax distinguishes between ZIPs in the cache', async () => {
    await withZipTaxKey(null, async () => {
        const fc = load();
        fc._clearCache();
        let calls = 0;
        await withFetchStub(async (url) => {
            calls += 1;
            const zip = new URL(url).searchParams.get('zip');
            return fetchResp({ body: { rate: { state: zip === '98033' ? 'WA' : 'CA', zip,
                combined_rate: zip === '98033' ? '0.104' : '0.105',
                state_rate: '0', county_rate: '0', city_rate: '0', combined_district_rate: '0' } } });
        }, async () => {
            const a = await fc.lookupSalesTax('98033');
            const b = await fc.lookupSalesTax('90210');
            assert.equal(a.state, 'WA');
            assert.equal(b.state, 'CA');
        });
        assert.equal(calls, 2);
    });
});

test('lookupSalesTax handles Oregon zero-rate response correctly', async () => {
    await withZipTaxKey(null, async () => {
        const fc = load();
        fc._clearCache();
        await withFetchStub(async () => fetchResp({ body: { rate: {
            state: 'OR', zip: '97201', city: null, county: null, country: 'US',
            combined_rate: '0.0', state_rate: '0.0', county_rate: '0.0',
            city_rate: '0.0', combined_district_rate: '0.0'
        } } }), async () => {
            const out = await fc.lookupSalesTax('97201');
            assert.equal(out.state, 'OR');
            assert.equal(out.combinedRate, 0);
        });
    });
});

test('lookupSalesTax throws on missing zip', async () => {
    const fc = load();
    await assert.rejects(fc.lookupSalesTax(), /zip is required/);
    await assert.rejects(fc.lookupSalesTax(''), /zip is required/);
});

test('lookupSalesTax throws on non-200', async () => {
    await withZipTaxKey(null, async () => {
        const fc = load();
        fc._clearCache();
        await withFetchStub(async () => fetchResp({ status: 503, body: 'down' }), async () => {
            await assert.rejects(fc.lookupSalesTax('98033'), /HTTP 503/);
        });
    });
});

test('lookupSalesTax throws on non-JSON', async () => {
    await withZipTaxKey(null, async () => {
        const fc = load();
        fc._clearCache();
        await withFetchStub(async () => fetchResp({ body: 'plain text' }), async () => {
            await assert.rejects(fc.lookupSalesTax('98033'), /non-JSON/);
        });
    });
});

test('lookupSalesTax throws when response shape is wrong', async () => {
    await withZipTaxKey(null, async () => {
        const fc = load();
        fc._clearCache();
        await withFetchStub(async () => fetchResp({ body: { error: 'no rate' } }), async () => {
            await assert.rejects(fc.lookupSalesTax('98033'), /missing `rate`/);
        });
    });
});

test('lookupSalesTax throws when combined_rate is not numeric', async () => {
    await withZipTaxKey(null, async () => {
        const fc = load();
        fc._clearCache();
        await withFetchStub(async () => fetchResp({ body: { rate: { combined_rate: 'oops', state_rate: '0' } } }), async () => {
            await assert.rejects(fc.lookupSalesTax('98033'), /combined_rate not numeric/);
        });
    });
});

// ---------- zip.tax path (ZIP_TAX_API_KEY present) ----------

// HAR/live-verified shape (see docs.zip.tax/guides/rest-api/by-postal-code).
// zip.tax can return multiple results per ZIP (different cities sharing one
// ZIP); we take the first.
const ZIPTAX_KIRKLAND_RESPONSE = {
    version: 'v60',
    rCode: 100,
    results: [
        {
            geoPostalCode: '98033', geoCity: 'KIRKLAND', geoCounty: 'KING', geoState: 'WA',
            taxSales: 0.103, taxUse: 0.103, rateState: 0.065, rateCity: 0,
            rateCounty: 0.038, rateAdditional: 0
        },
        {
            geoPostalCode: '98033', geoCity: 'REDMOND', geoCounty: 'KING', geoState: 'WA',
            taxSales: 0.103, taxUse: 0.103, rateState: 0.065, rateCity: 0,
            rateCounty: 0.038, rateAdditional: 0
        }
    ]
};

test('lookupSalesTax prefers zip.tax when ZIP_TAX_API_KEY is set, sends X-API-KEY, takes first result', async () => {
    await withZipTaxKey('test-zip-tax-key', async () => {
        const fc = load();
        fc._clearCache();
        let captured = null;
        await withFetchStub(async (url, opts) => {
            captured = { url, opts };
            return fetchResp({ body: ZIPTAX_KIRKLAND_RESPONSE });
        }, async () => {
            const out = await fc.lookupSalesTax('98033');
            assert.equal(out.state, 'WA');
            assert.equal(out.city, 'KIRKLAND'); // first result, not REDMOND
            assert.equal(out.county, 'KING');
            assert.equal(out.combinedRate, 0.103);
            assert.equal(out.stateRate, 0.065);
            assert.equal(out.countyRate, 0.038);
            assert.equal(out.cityRate, 0);
            assert.equal(out.districtRate, 0);
            assert.equal(out.source, 'zip-tax.com');
        });
        assert.ok(captured.url.startsWith('https://api.zip-tax.com/request/v60?'));
        assert.ok(captured.url.includes('postalcode=98033'));
        assert.equal(captured.opts.headers['X-API-KEY'], 'test-zip-tax-key');
        assert.equal(captured.opts.redirect, 'error', 'must refuse to replay X-API-KEY across a redirect');
    });
});

for (const badTaxSales of [null, false, '', '   ', {}, []]) {
    test(`lookupSalesTax falls back to TaxJar when zip.tax taxSales is ${JSON.stringify(badTaxSales)}`, async () => {
        await withZipTaxKey('test-zip-tax-key', async () => {
            const fc = load();
            fc._clearCache();
            let calls = 0;
            await withFetchStub(async (url) => {
                calls += 1;
                if (isZipTaxUrl(url)) {
                    return fetchResp({
                        body: {
                            rCode: 100,
                            results: [{ geoState: 'WA', geoCity: 'KIRKLAND', geoCounty: 'KING', taxSales: badTaxSales }]
                        }
                    });
                }
                return fetchResp({ body: KIRKLAND_RESPONSE });
            }, async () => {
                const out = await fc.lookupSalesTax('98033');
                assert.equal(out.source, 'taxjar.com calculator widget');
                assert.equal(out.combinedRate, 0.104, 'must not silently cache a zero rate from the malformed response');
            });
            assert.equal(calls, 2, 'tried zip.tax then fell back to TaxJar');
        });
    });
}

test('lookupSalesTax accepts a numeric-string taxSales from zip.tax', async () => {
    await withZipTaxKey('test-zip-tax-key', async () => {
        const fc = load();
        fc._clearCache();
        await withFetchStub(async (url) => {
            if (isZipTaxUrl(url)) {
                return fetchResp({
                    body: {
                        rCode: 100,
                        results: [{ geoState: 'WA', geoCity: 'KIRKLAND', geoCounty: 'KING', taxSales: '0.103' }]
                    }
                });
            }
            return fetchResp({ body: KIRKLAND_RESPONSE });
        }, async () => {
            const out = await fc.lookupSalesTax('98033');
            assert.equal(out.source, 'zip-tax.com');
            assert.equal(out.combinedRate, 0.103);
        });
    });
});

test('lookupSalesTax falls back to TaxJar when zip.tax fetch refuses a redirect', async () => {
    await withZipTaxKey('test-zip-tax-key', async () => {
        const fc = load();
        fc._clearCache();
        let calls = 0;
        await withFetchStub(async (url) => {
            calls += 1;
            if (isZipTaxUrl(url)) throw new TypeError('fetch failed: unexpected redirect');
            return fetchResp({ body: KIRKLAND_RESPONSE });
        }, async () => {
            const out = await fc.lookupSalesTax('98033');
            assert.equal(out.source, 'taxjar.com calculator widget');
        });
        assert.equal(calls, 2, 'tried zip.tax then fell back to TaxJar');
    });
});

test('lookupSalesTax falls back to TaxJar when zip.tax rCode is not 100', async () => {
    await withZipTaxKey('test-zip-tax-key', async () => {
        const fc = load();
        fc._clearCache();
        let calls = 0;
        await withFetchStub(async (url) => {
            calls += 1;
            if (isZipTaxUrl(url)) return fetchResp({ body: { rCode: 400, message: 'bad key' } });
            return fetchResp({ body: KIRKLAND_RESPONSE });
        }, async () => {
            const out = await fc.lookupSalesTax('98033');
            assert.equal(out.source, 'taxjar.com calculator widget');
            assert.equal(out.combinedRate, 0.104);
        });
        assert.equal(calls, 2, 'tried zip.tax then fell back to TaxJar');
    });
});

test('lookupSalesTax falls back to TaxJar when zip.tax HTTP fails', async () => {
    await withZipTaxKey('test-zip-tax-key', async () => {
        const fc = load();
        fc._clearCache();
        await withFetchStub(async (url) => {
            if (isZipTaxUrl(url)) return fetchResp({ status: 500, body: 'down' });
            return fetchResp({ body: KIRKLAND_RESPONSE });
        }, async () => {
            const out = await fc.lookupSalesTax('98033');
            assert.equal(out.source, 'taxjar.com calculator widget');
        });
    });
});

test('lookupSalesTax does not call zip.tax when ZIP_TAX_API_KEY is unset', async () => {
    await withZipTaxKey(null, async () => {
        const fc = load();
        fc._clearCache();
        let calls = 0;
        await withFetchStub(async (url) => {
            calls += 1;
            assert.ok(!isZipTaxUrl(url), 'should not call zip.tax without a key');
            return fetchResp({ body: KIRKLAND_RESPONSE });
        }, async () => {
            const out = await fc.lookupSalesTax('98033');
            assert.equal(out.source, 'taxjar.com calculator widget');
        });
        assert.equal(calls, 1);
    });
});
