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

// HAR-shaped happy response
const KIRKLAND_RESPONSE = {
    rate: {
        state: 'WA', zip: '98033', city: 'KIRKLAND', country: 'US', freight_taxable: true,
        combined_rate: '0.104', state_rate: '0.065', county: 'KING', county_rate: '0.005',
        city_rate: '0.011', combined_district_rate: '0.023', country_rate_str: '0.0'
    }
};

test('lookupSalesTax hits the calculator with the expected URL and returns parsed numbers', async () => {
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

test('lookupSalesTax caches per-ZIP for the process lifetime', async () => {
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

test('lookupSalesTax distinguishes between ZIPs in the cache', async () => {
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

test('lookupSalesTax handles Oregon zero-rate response correctly', async () => {
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

test('lookupSalesTax throws on missing zip', async () => {
    const fc = load();
    await assert.rejects(fc.lookupSalesTax(), /zip is required/);
    await assert.rejects(fc.lookupSalesTax(''), /zip is required/);
});

test('lookupSalesTax throws on non-200', async () => {
    const fc = load();
    fc._clearCache();
    await withFetchStub(async () => fetchResp({ status: 503, body: 'down' }), async () => {
        await assert.rejects(fc.lookupSalesTax('98033'), /HTTP 503/);
    });
});

test('lookupSalesTax throws on non-JSON', async () => {
    const fc = load();
    fc._clearCache();
    await withFetchStub(async () => fetchResp({ body: 'plain text' }), async () => {
        await assert.rejects(fc.lookupSalesTax('98033'), /non-JSON/);
    });
});

test('lookupSalesTax throws when response shape is wrong', async () => {
    const fc = load();
    fc._clearCache();
    await withFetchStub(async () => fetchResp({ body: { error: 'no rate' } }), async () => {
        await assert.rejects(fc.lookupSalesTax('98033'), /missing `rate`/);
    });
});

test('lookupSalesTax throws when combined_rate is not numeric', async () => {
    const fc = load();
    fc._clearCache();
    await withFetchStub(async () => fetchResp({ body: { rate: { combined_rate: 'oops', state_rate: '0' } } }), async () => {
        await assert.rejects(fc.lookupSalesTax('98033'), /combined_rate not numeric/);
    });
});
