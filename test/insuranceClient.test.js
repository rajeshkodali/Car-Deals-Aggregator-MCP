'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const insuranceClientPath = require.resolve('../src/insuranceClient.js');
function load() {
    delete require.cache[insuranceClientPath];
    return require('../src/insuranceClient.js');
}

function fetchResp({ status = 200, body = '' } = {}) {
    return { status, async text() { return typeof body === 'string' ? body : JSON.stringify(body); } };
}

function withFetchStub(stub, fn) {
    const prev = global.fetch;
    global.fetch = stub;
    return Promise.resolve(fn()).finally(() => { global.fetch = prev; });
}

// Synthetic Zebra response based on the actual HAR shape
// (POST https://www.thezebra.com/car-calculator/results/).
function zebraResponse(rates) {
    const cards = rates.map(r => `
        <div class="card card-outlined card-elevated quote-card">
            <div class="quote-card__header">
                <img class="carrier-logo" src="..." alt="Carrier">
                <div class="rate rate--sm">
                    <span class="rate__dollar">$</span>
                    <span class="rate__amount">${r.toFixed(2)}</span>
                    <span class="rate__period">/mo</span>
                </div>
            </div>
        </div>`).join('\n');
    return { rate: Math.min(...rates), quotes_html: cards };
}

// ---------- pure helpers ----------

test('parseRatesFromHtml extracts every rate__amount', () => {
    const { parseRatesFromHtml } = load();
    const html = `
        <span class="rate__amount">362.62</span>
        <span class="rate__amount">417.02</span>
        <span class="rate__amount">501.10</span>`;
    assert.deepEqual(parseRatesFromHtml(html), [362.62, 417.02, 501.10]);
});

test('parseRatesFromHtml tolerates commas and whitespace', () => {
    const { parseRatesFromHtml } = load();
    const html = `<span class="rate__amount">  1,234.56 </span>`;
    assert.deepEqual(parseRatesFromHtml(html), [1234.56]);
});

test('parseRatesFromHtml returns [] for non-string / empty input', () => {
    const { parseRatesFromHtml } = load();
    assert.deepEqual(parseRatesFromHtml(undefined), []);
    assert.deepEqual(parseRatesFromHtml(null), []);
    assert.deepEqual(parseRatesFromHtml(123), []);
    assert.deepEqual(parseRatesFromHtml(''), []);
});

test('median computes correctly for odd and even lengths', () => {
    const { median } = load();
    assert.equal(median([5, 1, 3]), 3);
    assert.equal(median([1, 2, 3, 4]), 2.5);
    assert.equal(median([7]), 7);
    assert.equal(median([]), null);
});

// ---------- estimateInsurance happy path ----------

test('estimateInsurance posts the expected body and parses median across carriers', async () => {
    const { estimateInsurance } = load();
    let captured = null;
    await withFetchStub(async (url, opts) => {
        captured = { url, opts };
        return fetchResp({ body: zebraResponse([362.62, 417.02, 501.10]) });
    }, async () => {
        const out = await estimateInsurance({ zip: '98033', ageBucket: '45 to 54', homeOwner: true, currentlyInsured: true });
        assert.equal(out.medianMonthly, 417.02);
        assert.equal(out.lowMonthly, 362.62);
        assert.equal(out.highMonthly, 501.10);
        assert.equal(out.carrierCount, 3);
        assert.equal(out.zip, '98033');
        assert.equal(out.ageBucket, '45 to 54');
        assert.equal(out.source, 'thezebra.com car-calculator');
    });

    assert.equal(captured.url, 'https://www.thezebra.com/car-calculator/results/');
    assert.equal(captured.opts.method, 'POST');
    const body = JSON.parse(captured.opts.body);
    assert.deepEqual(body, {
        AgeBucket: '45 to 54',
        HomeOwnership: true,
        CurrentlyInsuredStatus: true,
        Zipcode: '98033'
    });
    assert.equal(captured.opts.headers['x-zebra-client-identifier'], 'zfront');
    assert.equal(captured.opts.headers['content-type'], 'application/json');
});

test('estimateInsurance applies sensible defaults', async () => {
    const { estimateInsurance } = load();
    let body = null;
    await withFetchStub(async (_url, opts) => {
        body = JSON.parse(opts.body);
        return fetchResp({ body: zebraResponse([300]) });
    }, async () => {
        await estimateInsurance({ zip: '90210' });
    });
    assert.equal(body.AgeBucket, '45 to 54');
    assert.equal(body.HomeOwnership, true);
    assert.equal(body.CurrentlyInsuredStatus, true);
});

test('estimateInsurance computes median for even number of carriers', async () => {
    const { estimateInsurance } = load();
    await withFetchStub(async () => fetchResp({ body: zebraResponse([100, 200, 300, 400]) }), async () => {
        const out = await estimateInsurance({ zip: '90210' });
        assert.equal(out.medianMonthly, 250); // (200 + 300) / 2
    });
});

test('estimateInsurance falls back to top-level rate when quotes_html has no carriers', async () => {
    const { estimateInsurance } = load();
    await withFetchStub(async () => fetchResp({
        body: { rate: 188.42, quotes_html: '<div>no carrier cards rendered</div>' }
    }), async () => {
        const out = await estimateInsurance({ zip: '90210' });
        assert.equal(out.medianMonthly, 188.42);
        assert.equal(out.carrierCount, 1);
    });
});

// ---------- error paths ----------

test('estimateInsurance rejects unknown ageBucket without making a request', async () => {
    const { estimateInsurance } = load();
    let calls = 0;
    await withFetchStub(async () => { calls += 1; return fetchResp({}); }, async () => {
        await assert.rejects(estimateInsurance({ zip: '90210', ageBucket: 'middle aged' }), /Unknown ageBucket/);
    });
    assert.equal(calls, 0);
});

test('estimateInsurance throws when zip is missing', async () => {
    const { estimateInsurance } = load();
    await assert.rejects(estimateInsurance({}), /zip is required/);
});

test('estimateInsurance throws on non-200', async () => {
    const { estimateInsurance } = load();
    await withFetchStub(async () => fetchResp({ status: 503, body: 'down' }), async () => {
        await assert.rejects(estimateInsurance({ zip: '90210' }), /HTTP 503/);
    });
});

test('estimateInsurance throws on non-JSON body', async () => {
    const { estimateInsurance } = load();
    await withFetchStub(async () => fetchResp({ body: 'plain text not json' }), async () => {
        await assert.rejects(estimateInsurance({ zip: '90210' }), /non-JSON/);
    });
});

test('estimateInsurance throws when response has no parseable rates', async () => {
    const { estimateInsurance } = load();
    await withFetchStub(async () => fetchResp({ body: { rate: null, quotes_html: '<div></div>' } }), async () => {
        await assert.rejects(estimateInsurance({ zip: '90210' }), /no parseable rates/);
    });
});
