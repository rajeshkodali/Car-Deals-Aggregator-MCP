'use strict';

const { fetchWithTimeout } = require('./httpClient.js');

// Estimates monthly auto-insurance cost via The Zebra's public calculator endpoint:
//   POST https://www.thezebra.com/car-calculator/results/
//   body: { AgeBucket, HomeOwnership, CurrentlyInsuredStatus, Zipcode }
//   response: { rate: <cheapest carrier monthly>, quotes_html: "<...>" }
//
// We don't trust the cheapest-carrier `rate` field — it's not representative.
// Instead we parse every $X.XX in `quotes_html` and report the median, plus
// low/high for context. Output is ZIP- and demographic-aware only; vehicle
// make/model/year is NOT an input. The tool surface labels this clearly.

const VALID_AGE_BUCKETS = new Set([
    'Below 18', '18 to 24', '25 to 34', '35 to 44',
    '45 to 54', '55 to 64', 'above 65'
]);

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';

function parseRatesFromHtml(html) {
    if (typeof html !== 'string') return [];
    const rates = [];
    const re = /<span class="rate__amount">\s*([\d.,]+)\s*<\/span>/g;
    let match;
    while ((match = re.exec(html)) !== null) {
        const v = Number(match[1].replace(/,/g, ''));
        if (Number.isFinite(v) && v > 0) rates.push(v);
    }
    return rates;
}

function median(nums) {
    if (!nums.length) return null;
    const sorted = [...nums].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
        ? (sorted[mid - 1] + sorted[mid]) / 2
        : sorted[mid];
}

async function estimateInsurance({
    zip,
    ageBucket = '45 to 54',
    homeOwner = true,
    currentlyInsured = true
} = {}) {
    if (!zip) throw new Error('zip is required');
    if (!VALID_AGE_BUCKETS.has(ageBucket)) {
        throw new Error(`Unknown ageBucket: ${ageBucket}. Expected one of: ${[...VALID_AGE_BUCKETS].join(', ')}`);
    }

    const body = JSON.stringify({
        AgeBucket: ageBucket,
        HomeOwnership: !!homeOwner,
        CurrentlyInsuredStatus: !!currentlyInsured,
        Zipcode: String(zip)
    });

    const res = await fetchWithTimeout('https://www.thezebra.com/car-calculator/results/', {
        method: 'POST',
        headers: {
            'accept': '*/*',
            'accept-language': 'en-US,en;q=0.9',
            'content-type': 'application/json',
            'origin': 'https://www.thezebra.com',
            'referer': 'https://www.thezebra.com/auto-insurance/how-to-shop/car-insurance-rates-city/',
            'user-agent': UA,
            'x-zebra-client-identifier': 'zfront'
        },
        body
    }, { timeoutMs: 8_000, label: 'Zebra' });

    if (res.status !== 200) throw new Error(`Zebra HTTP ${res.status}`);
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { throw new Error('Zebra returned non-JSON'); }

    const carrierRates = parseRatesFromHtml(data.quotes_html || '');
    // Fall back to the `rate` field if HTML parsing yielded nothing — it's at
    // least one real number from the same response.
    const rates = carrierRates.length ? carrierRates : (Number.isFinite(data.rate) ? [data.rate] : []);

    if (!rates.length) {
        throw new Error('Zebra response had no parseable rates');
    }

    const med = median(rates);
    const low = Math.min(...rates);
    const high = Math.max(...rates);

    return {
        medianMonthly: Math.round(med * 100) / 100,
        lowMonthly: Math.round(low * 100) / 100,
        highMonthly: Math.round(high * 100) / 100,
        carrierCount: rates.length,
        zip: String(zip),
        ageBucket,
        homeOwner: !!homeOwner,
        currentlyInsured: !!currentlyInsured,
        source: 'thezebra.com car-calculator'
    };
}

module.exports = {
    estimateInsurance,
    parseRatesFromHtml,
    median,
    VALID_AGE_BUCKETS: [...VALID_AGE_BUCKETS]
};
