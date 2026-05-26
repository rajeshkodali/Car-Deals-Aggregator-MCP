'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const apiClientPath = require.resolve('../src/apiClient.js');
const scraperPath = require.resolve('../src/scraper.js');
const insurancePath = require.resolve('../src/insuranceClient.js');
const loanPath = require.resolve('../src/loanCalculator.js');
const feeClientPath = require.resolve('../src/feeClient.js');
const feeDataPath = require.resolve('../src/feeData.js');
const serverPath = require.resolve('../src/server.js');

// Lightweight CarListing stand-in. server.js renders via `listing.format()`
// and reads `listing.url` / `listing.fuelType` directly, so we provide both.
// `format()` mirrors the real CarListing#format shape closely enough for the
// rendered-output assertions to grep against (title, price, source, url).
function makeListing(overrides = {}) {
    const data = {
        title: 't', price: '$1', mileage: '1 mi.', source: 's', url: 'https://example/u',
        fuelType: null, isOneOwner: false, noAccidents: false, personalUse: false,
        ...overrides
    };
    data.format = function () {
        let s = this.title || 'Unknown';
        if (this.price) s += `\n  Price: ${this.price}`;
        if (this.mileage) s += `\n  Mileage: ${this.mileage}`;
        if (this.source) s += `\n  Source: ${this.source}`;
        if (this.url) s += `\n  ${this.url}`;
        return s;
    };
    return data;
}

// Install fake apiClient + scraper modules into require.cache before loading server.js
// so the destructured imports inside server.js capture *our* fakes. Stubs must be
// supplied up front because server.js does `const { fetchCarscom } = require(...)`,
// which copies the function reference at load time — later mutation has no effect.
function loadServerWithStubs({ api = {}, scraper = {}, insurance, loan, fees } = {}) {
    delete require.cache[apiClientPath];
    delete require.cache[scraperPath];
    delete require.cache[insurancePath];
    delete require.cache[loanPath];
    delete require.cache[feeClientPath];
    delete require.cache[feeDataPath];
    delete require.cache[serverPath];

    const fakeApi = {
        fetchAutotrader: api.fetchAutotrader || (async () => { throw new Error('fetchAutotrader not stubbed'); }),
        fetchKbb: api.fetchKbb || (async () => { throw new Error('fetchKbb not stubbed'); }),
        fetchCarscom: api.fetchCarscom || (async () => { throw new Error('fetchCarscom not stubbed'); }),
        fetchCarmax: api.fetchCarmax || (async () => { throw new Error('fetchCarmax not stubbed'); }),
        fetchCarmaxFromHtml: api.fetchCarmaxFromHtml || (async () => { throw new Error('fetchCarmaxFromHtml not stubbed'); }),
        fetchCarvana: api.fetchCarvana || (async () => { throw new Error('fetchCarvana not stubbed'); })
    };
    const fakeScraper = {
        scrapeCarscom: scraper.scrapeCarscom || (async () => { throw new Error('scrapeCarscom not stubbed'); }),
        scrapeAutotrader: scraper.scrapeAutotrader || (async () => { throw new Error('scrapeAutotrader not stubbed'); }),
        scrapeKBB: scraper.scrapeKBB || (async () => { throw new Error('scrapeKBB not stubbed'); }),
        CarListing: class { constructor(o) { Object.assign(this, o); } }
    };
    // Insurance stub: by default, no estimate. Test can opt in.
    const fakeInsurance = {
        estimateInsurance: insurance || (async () => { throw new Error('insurance not stubbed'); })
    };
    // Loan stub: real implementations by default since they're pure math; tests
    // can override to assert call shape if needed.
    const realLoan = require('../src/loanCalculator.js');
    const fakeLoan = {
        monthlyPayment: (loan && loan.monthlyPayment) || realLoan.monthlyPayment,
        parsePrice: (loan && loan.parsePrice) || realLoan.parsePrice,
        totalCostBreakdown: (loan && loan.totalCostBreakdown) || realLoan.totalCostBreakdown
    };
    delete require.cache[loanPath]; // make sure server.js sees the fake

    require.cache[apiClientPath] = {
        id: apiClientPath, filename: apiClientPath,
        loaded: true, exports: fakeApi, children: [], paths: []
    };
    require.cache[scraperPath] = {
        id: scraperPath, filename: scraperPath,
        loaded: true, exports: fakeScraper, children: [], paths: []
    };
    require.cache[insurancePath] = {
        id: insurancePath, filename: insurancePath,
        loaded: true, exports: fakeInsurance, children: [], paths: []
    };
    require.cache[loanPath] = {
        id: loanPath, filename: loanPath,
        loaded: true, exports: fakeLoan, children: [], paths: []
    };
    // Fee client + data stubs. Default: lookupSalesTax throws (so server hits
    // the .catch and proceeds without tax). Real feeData by default since it's
    // pure static data.
    const fakeFeeClient = {
        lookupSalesTax: (fees && fees.lookupSalesTax) || (async () => { throw new Error('tax not stubbed'); })
    };
    const realFeeData = require('../src/feeData.js');
    delete require.cache[feeDataPath];
    const fakeFeeData = (fees && fees.feeData) || realFeeData;
    require.cache[feeClientPath] = {
        id: feeClientPath, filename: feeClientPath,
        loaded: true, exports: fakeFeeClient, children: [], paths: []
    };
    require.cache[feeDataPath] = {
        id: feeDataPath, filename: feeDataPath,
        loaded: true, exports: fakeFeeData, children: [], paths: []
    };

    const prevErr = console.error;
    console.error = () => {};
    try {
        const server = require('../src/server.js');
        return { server, restoreLogs: () => { console.error = prevErr; } };
    } catch (e) {
        console.error = prevErr;
        throw e;
    }
}

// ---------- searchCarscom ----------

test('searchCarscom returns fetch results when fetchCarscom yields listings', async () => {
    let scraperCalls = 0;
    const { server, restoreLogs } = loadServerWithStubs({
        api: { fetchCarscom: async () => [makeListing({ source: 'Cars.com' })] },
        scraper: { scrapeCarscom: async () => { scraperCalls += 1; return []; } }
    });
    try {
        const out = await server.searchCarscom({ zip: '90210' }, 5);
        assert.equal(out.source, 'Cars.com');
        assert.equal(out.listings.length, 1);
        assert.equal(out.error, undefined);
        assert.equal(scraperCalls, 0, 'scraper not called when fetch returns listings');
    } finally { restoreLogs(); }
});

test('searchCarscom does NOT fall back when API returns 0 listings (clean empty)', async () => {
    // 0 results from a clean 200 is the user's filter being narrow, not a
    // silent break — fallbacks should NOT spend a Puppeteer launch on it.
    let scraperCalls = 0;
    const { server, restoreLogs } = loadServerWithStubs({
        api: { fetchCarscom: async () => [] },
        scraper: { scrapeCarscom: async () => { scraperCalls += 1; return [makeListing()]; } }
    });
    try {
        const out = await server.searchCarscom({ zip: '90210' }, 5);
        assert.deepEqual(out.listings, []);
        assert.equal(out.error, undefined);
        assert.equal(scraperCalls, 0, 'Puppeteer scraper must not run on a 0-listing success');
    } finally { restoreLogs(); }
});

test('searchCarscom falls back to scraper when fetch throws', async () => {
    const { server, restoreLogs } = loadServerWithStubs({
        api: { fetchCarscom: async () => { throw new Error('Akamai'); } },
        scraper: { scrapeCarscom: async () => [makeListing({ title: 'fallback' })] }
    });
    try {
        const out = await server.searchCarscom({ zip: '90210' }, 5);
        assert.equal(out.listings.length, 1);
        assert.equal(out.listings[0].title, 'fallback');
    } finally { restoreLogs(); }
});

test('searchCarscom returns error envelope when both fetch and scraper fail', async () => {
    const { server, restoreLogs } = loadServerWithStubs({
        api: { fetchCarscom: async () => { throw new Error('fetch boom'); } },
        scraper: { scrapeCarscom: async () => { throw new Error('puppeteer boom'); } }
    });
    try {
        const out = await server.searchCarscom({ zip: '90210' }, 5);
        assert.equal(out.source, 'Cars.com');
        assert.deepEqual(out.listings, []);
        assert.equal(out.error, 'puppeteer boom');
    } finally { restoreLogs(); }
});

// ---------- searchAutotrader ----------

test('searchAutotrader returns fetch results when fetchAutotrader yields listings', async () => {
    let scraperCalls = 0;
    const { server, restoreLogs } = loadServerWithStubs({
        api: { fetchAutotrader: async () => [makeListing({ source: 'Autotrader' })] },
        scraper: { scrapeAutotrader: async () => { scraperCalls += 1; return []; } }
    });
    try {
        const out = await server.searchAutotrader({ zip: '90210' }, 5);
        assert.equal(out.source, 'Autotrader');
        assert.equal(out.listings.length, 1);
        assert.equal(scraperCalls, 0);
    } finally { restoreLogs(); }
});

test('searchAutotrader does NOT fall back when API returns 0 listings', async () => {
    let scraperCalls = 0;
    const { server, restoreLogs } = loadServerWithStubs({
        api: { fetchAutotrader: async () => [] },
        scraper: { scrapeAutotrader: async () => { scraperCalls += 1; return [makeListing()]; } }
    });
    try {
        const out = await server.searchAutotrader({ zip: '90210' }, 5);
        assert.deepEqual(out.listings, []);
        assert.equal(scraperCalls, 0, 'Puppeteer scraper must not run on a 0-listing success');
    } finally { restoreLogs(); }
});

test('searchAutotrader falls back to scraper when fetch throws (e.g. Akamai)', async () => {
    const { server, restoreLogs } = loadServerWithStubs({
        api: { fetchAutotrader: async () => { throw new Error('Akamai page unavailable'); } },
        scraper: { scrapeAutotrader: async () => [makeListing({ title: 'pup' })] }
    });
    try {
        const out = await server.searchAutotrader({ zip: '90210' }, 5);
        assert.equal(out.listings.length, 1);
        assert.equal(out.error, undefined);
    } finally { restoreLogs(); }
});

test('searchAutotrader returns error envelope when both paths fail', async () => {
    const { server, restoreLogs } = loadServerWithStubs({
        api: { fetchAutotrader: async () => { throw new Error('a'); } },
        scraper: { scrapeAutotrader: async () => { throw new Error('b'); } }
    });
    try {
        const out = await server.searchAutotrader({ zip: '90210' }, 5);
        assert.deepEqual(out.listings, []);
        assert.equal(out.error, 'b');
    } finally { restoreLogs(); }
});

// ---------- searchKBB (Puppeteer-only, no fetch path) ----------

test('searchKBB delegates to scrapeKBB and returns its listings', async () => {
    let captured = null;
    const { server, restoreLogs } = loadServerWithStubs({
        scraper: {
            scrapeKBB: async (params, max) => {
                captured = { params, max };
                return [makeListing({ source: 'KBB' })];
            }
        }
    });
    try {
        const out = await server.searchKBB({ zip: '90210', make: 'Toyota' }, 7);
        assert.equal(out.source, 'KBB');
        assert.equal(out.listings.length, 1);
        assert.equal(captured.max, 7);
        assert.equal(captured.params.make, 'Toyota');
    } finally { restoreLogs(); }
});

test('searchKBB swallows scraper errors and returns error envelope', async () => {
    const { server, restoreLogs } = loadServerWithStubs({
        scraper: { scrapeKBB: async () => { throw new Error('kbb down'); } }
    });
    try {
        const out = await server.searchKBB({ zip: '90210' }, 5);
        assert.deepEqual(out.listings, []);
        assert.equal(out.error, 'kbb down');
    } finally { restoreLogs(); }
});

// ---------- params propagation ----------

test('searchCarscom forwards full params and maxResults to fetchCarscom', async () => {
    let captured = null;
    const { server, restoreLogs } = loadServerWithStubs({
        api: {
            fetchCarscom: async (params, max) => {
                captured = { params, max };
                return [makeListing()];
            }
        }
    });
    try {
        const params = {
            zip: '98101', make: 'Toyota', model: 'Camry',
            yearMin: 2020, priceMax: 25000, oneOwner: true,
            keyword: 'hybrid', condition: 'used'
        };
        await server.searchCarscom(params, 13);
        assert.equal(captured.max, 13);
        assert.equal(captured.params.zip, '98101');
        assert.equal(captured.params.make, 'Toyota');
        assert.equal(captured.params.oneOwner, true);
        assert.equal(captured.params.keyword, 'hybrid');
    } finally { restoreLogs(); }
});

test('searchAutotrader forwards full params and maxResults to fetchAutotrader', async () => {
    let captured = null;
    const { server, restoreLogs } = loadServerWithStubs({
        api: {
            fetchAutotrader: async (params, max) => {
                captured = { params, max };
                return [makeListing()];
            }
        }
    });
    try {
        await server.searchAutotrader({ zip: '90210', make: 'Honda' }, 4);
        assert.equal(captured.max, 4);
        assert.equal(captured.params.make, 'Honda');
    } finally { restoreLogs(); }
});

// ---------- searchKBB: fetch-first / Puppeteer fallback ----------

test('searchKBB returns fetch results when fetchKbb yields listings (no scraper)', async () => {
    let scraperCalls = 0;
    const { server, restoreLogs } = loadServerWithStubs({
        api: { fetchKbb: async () => [makeListing({ source: 'KBB' })] },
        scraper: { scrapeKBB: async () => { scraperCalls += 1; return []; } }
    });
    try {
        const out = await server.searchKBB({ zip: '90210' }, 5);
        assert.equal(out.source, 'KBB');
        assert.equal(out.listings.length, 1);
        assert.equal(scraperCalls, 0);
    } finally { restoreLogs(); }
});

test('searchKBB does NOT fall back when fetchKbb returns 0 listings', async () => {
    let scraperCalls = 0;
    const { server, restoreLogs } = loadServerWithStubs({
        api: { fetchKbb: async () => [] },
        scraper: { scrapeKBB: async () => { scraperCalls += 1; return [makeListing()]; } }
    });
    try {
        const out = await server.searchKBB({ zip: '90210' }, 5);
        assert.deepEqual(out.listings, []);
        assert.equal(scraperCalls, 0, 'Puppeteer scraper must not run on a 0-listing success');
    } finally { restoreLogs(); }
});

test('searchKBB falls back to scraper when fetchKbb throws', async () => {
    const { server, restoreLogs } = loadServerWithStubs({
        api: { fetchKbb: async () => { throw new Error('cox down'); } },
        scraper: { scrapeKBB: async () => [makeListing({ title: 'pup' })] }
    });
    try {
        const out = await server.searchKBB({ zip: '90210' }, 5);
        assert.equal(out.listings.length, 1);
        assert.equal(out.listings[0].title, 'pup');
        assert.equal(out.error, undefined);
    } finally { restoreLogs(); }
});

test('searchKBB returns error envelope when both fetchKbb and scraper fail', async () => {
    const { server, restoreLogs } = loadServerWithStubs({
        api: { fetchKbb: async () => { throw new Error('a'); } },
        scraper: { scrapeKBB: async () => { throw new Error('b'); } }
    });
    try {
        const out = await server.searchKBB({ zip: '90210' }, 5);
        assert.deepEqual(out.listings, []);
        assert.equal(out.error, 'b');
    } finally { restoreLogs(); }
});

test('searchKBB forwards bodyStyle and fuelType to fetchKbb', async () => {
    let captured = null;
    const { server, restoreLogs } = loadServerWithStubs({
        api: {
            fetchKbb: async (params, max) => {
                captured = { params, max };
                return [makeListing({ source: 'KBB' })];
            }
        }
    });
    try {
        await server.searchKBB({ zip: '90210', bodyStyle: 'suv', fuelType: 'ev' }, 6);
        assert.equal(captured.params.bodyStyle, 'suv');
        assert.equal(captured.params.fuelType, 'ev');
        assert.equal(captured.max, 6);
    } finally { restoreLogs(); }
});

// ---------- searchCarmax (API + HTML fallback) ----------

test('searchCarmax returns API results when fetchCarmax yields listings', async () => {
    let htmlCalls = 0;
    const { server, restoreLogs } = loadServerWithStubs({
        api: {
            fetchCarmax: async () => [makeListing({ source: 'CarMax' })],
            fetchCarmaxFromHtml: async () => { htmlCalls += 1; return []; }
        }
    });
    try {
        const out = await server.searchCarmax({ zip: '90210' }, 5);
        assert.equal(out.source, 'CarMax');
        assert.equal(out.listings.length, 1);
        assert.equal(htmlCalls, 0, 'HTML fallback skipped when API succeeds');
    } finally { restoreLogs(); }
});

test('searchCarmax does NOT fall back to HTML when API returns 0 listings', async () => {
    let apiCalls = 0, htmlCalls = 0;
    const { server, restoreLogs } = loadServerWithStubs({
        api: {
            fetchCarmax: async () => { apiCalls += 1; return []; },
            fetchCarmaxFromHtml: async () => { htmlCalls += 1; return [makeListing({ source: 'CarMax' })]; }
        }
    });
    try {
        const out = await server.searchCarmax({ zip: '90210' }, 5);
        assert.equal(apiCalls, 1);
        assert.equal(htmlCalls, 0, 'HTML fallback must not run on a 0-listing success');
        assert.deepEqual(out.listings, []);
    } finally { restoreLogs(); }
});

test('searchCarmax falls back to HTML when fetchCarmax throws', async () => {
    let htmlCalls = 0;
    const { server, restoreLogs } = loadServerWithStubs({
        api: {
            fetchCarmax: async () => { throw new Error('CarMax HTTP 503'); },
            fetchCarmaxFromHtml: async () => { htmlCalls += 1; return [makeListing({ source: 'CarMax' })]; }
        }
    });
    try {
        const out = await server.searchCarmax({ zip: '90210' }, 5);
        assert.equal(htmlCalls, 1);
        assert.equal(out.listings.length, 1);
    } finally { restoreLogs(); }
});

test('searchCarmax returns empty envelope when both API and HTML fail', async () => {
    const { server, restoreLogs } = loadServerWithStubs({
        api: {
            fetchCarmax: async () => { throw new Error('api down'); },
            fetchCarmaxFromHtml: async () => { throw new Error('html down'); }
        }
    });
    try {
        const out = await server.searchCarmax({ zip: '90210' }, 5);
        assert.equal(out.source, 'CarMax');
        assert.deepEqual(out.listings, []);
    } finally { restoreLogs(); }
});

// ---------- handleSearchCarDeals (end-to-end output text) ----------

function makeAtListing(o) {
    // Autotrader URLs follow the Cox listingId pattern, so dedup tests
    // that need a Cox-shaped URL use this helper.
    return makeListing({
        source: 'Autotrader',
        url: `https://www.autotrader.com/cars-for-sale/vehicledetails.xhtml?listingId=${o.id}`,
        ...o
    });
}
function makeKbbListing(o) {
    return makeListing({
        source: 'KBB',
        url: `https://www.kbb.com/cars-for-sale/vehicledetails.xhtml?listingId=${o.id}`,
        ...o
    });
}

test('handleSearchCarDeals renders a header and listings table from real-shape stubs', async () => {
    const { server, restoreLogs } = loadServerWithStubs({
        api: {
            fetchCarscom: async () => [
                makeListing({ title: '2022 Toyota Camry', price: '$23,000', source: 'Cars.com', url: 'https://www.cars.com/vehicledetail/abc/' })
            ]
        },
        fees: {
            lookupSalesTax: async () => ({
                state: 'WA', city: 'KIRKLAND', zip: '98033',
                combinedRate: 0.104, stateRate: 0.065, countyRate: 0.005, cityRate: 0.011, districtRate: 0.023
            }),
            feeData: { evSurchargeAnnual: () => 300, registrationEstimateAnnual: () => 95 }
        }
    });
    try {
        const out = await server.handleSearchCarDeals({ zip: '98033', sources: ['cars.com'] });
        assert.equal(out.isError, undefined);
        const text = out.content[0].text;
        assert.match(text, /# Car Deals Search Results/);
        assert.match(text, /Found \*\*1\*\* listings/);
        assert.match(text, /https:\/\/www\.cars\.com\/vehicledetail\/abc\//);
        // Sales tax line + fees line should be present (we provided tax fixture)
        assert.match(text, /Sales tax \(KIRKLAND, WA\)/);
        assert.match(text, /registration ~\$95\/yr/);
        // EV surcharge should NOT show because the listing has no fuelType
        // and request didn't specify EV.
        assert.doesNotMatch(text, /EV surcharge/);
    } finally { restoreLogs(); }
});

test('handleSearchCarDeals dedupes Autotrader/KBB on shared Cox listingId', async () => {
    const { server, restoreLogs } = loadServerWithStubs({
        api: {
            fetchAutotrader: async () => [makeAtListing({ id: '999', title: 'AT-shared' })],
            fetchKbb: async () => [makeKbbListing({ id: '999', title: 'KBB-shared' })]
        }
    });
    try {
        const out = await server.handleSearchCarDeals({ zip: '98033', sources: ['autotrader', 'kbb'] });
        const text = out.content[0].text;
        assert.match(text, /Found \*\*1\*\* listings/);
        assert.match(text, /AT-shared/, 'Autotrader wins the dedup tie');
        assert.doesNotMatch(text, /KBB-shared/);
    } finally { restoreLogs(); }
});

test('handleSearchCarDeals surfaces unknown sources in the rendered output', async () => {
    const { server, restoreLogs } = loadServerWithStubs({
        api: { fetchCarscom: async () => [] }
    });
    try {
        const out = await server.handleSearchCarDeals({ zip: '90210', sources: ['cars.com', 'craigslist', 'facebook'] });
        const text = out.content[0].text;
        assert.match(text, /Unknown sources ignored:\*\* craigslist, facebook/);
        assert.match(text, /Known sources: cars\.com, autotrader, kbb, carmax, carvana/);
    } finally { restoreLogs(); }
});

test('handleSearchCarDeals skips Carvana when oneOwner is requested (capability gap)', async () => {
    let carvanaCalls = 0;
    const { server, restoreLogs } = loadServerWithStubs({
        api: {
            fetchAutotrader: async () => [],
            fetchCarvana: async () => { carvanaCalls += 1; return []; }
        }
    });
    try {
        const out = await server.handleSearchCarDeals({
            zip: '90210', sources: ['autotrader', 'carvana'], oneOwner: true
        });
        const text = out.content[0].text;
        assert.equal(carvanaCalls, 0, 'Carvana not called when oneOwner is required');
        assert.match(text, /Sources skipped due to filter requirements/);
        assert.match(text, /carvana: oneOwner=true not enforceable/);
    } finally { restoreLogs(); }
});

test('handleSearchCarDeals skips CarMax for noAccidents but keeps it for oneOwner', async () => {
    let carmaxCalls = 0;
    const { server, restoreLogs } = loadServerWithStubs({
        api: {
            fetchCarmax: async () => { carmaxCalls += 1; return [makeListing({ source: 'CarMax', isOneOwner: true })]; },
            fetchCarmaxFromHtml: async () => []
        }
    });
    try {
        // oneOwner=true alone -> CarMax stays in (singleOwner highlight is supported)
        await server.handleSearchCarDeals({ zip: '98033', sources: ['carmax'], oneOwner: true });
        assert.equal(carmaxCalls, 1);

        // noAccidents=true -> CarMax is skipped (no per-listing data)
        carmaxCalls = 0;
        const out = await server.handleSearchCarDeals({ zip: '98033', sources: ['carmax'], noAccidents: true });
        assert.equal(carmaxCalls, 0);
        assert.match(out.content[0].text, /carmax: noAccidents=true not enforceable/);
    } finally { restoreLogs(); }
});

test('handleSearchCarDeals skips Cars.com for oneOwner/noAccidents (ghost-result gotcha)', async () => {
    // Cars.com returns a ghost (totalListings=0, empty context) when
    // one_owner / no_accidents are sent in the GraphQL filters, so
    // buildCarscomFilters() does not send them and the capability table
    // marks them as unsupported. Server must skip Cars.com cleanly rather
    // than silently returning unfiltered rows.
    let carscomCalls = 0;
    const { server, restoreLogs } = loadServerWithStubs({
        api: {
            fetchCarscom: async () => { carscomCalls += 1; return [makeListing({ source: 'Cars.com' })]; },
            fetchAutotrader: async () => []
        }
    });
    try {
        // oneOwner -> Cars.com skipped
        let out = await server.handleSearchCarDeals({ zip: '90210', sources: ['cars.com', 'autotrader'], oneOwner: true });
        assert.equal(carscomCalls, 0, 'Cars.com must not run when oneOwner is required');
        assert.match(out.content[0].text, /cars\.com: oneOwner=true not enforceable/);

        // noAccidents -> Cars.com skipped
        carscomCalls = 0;
        out = await server.handleSearchCarDeals({ zip: '90210', sources: ['cars.com', 'autotrader'], noAccidents: true });
        assert.equal(carscomCalls, 0, 'Cars.com must not run when noAccidents is required');
        assert.match(out.content[0].text, /cars\.com: noAccidents=true not enforceable/);

        // personalUse -> Cars.com STAYS in (this filter IS wired through)
        carscomCalls = 0;
        await server.handleSearchCarDeals({ zip: '90210', sources: ['cars.com'], personalUse: true });
        assert.equal(carscomCalls, 1, 'Cars.com runs for personalUse — that filter works');
    } finally { restoreLogs(); }
});

test('handleSearchCarDeals applies EV surcharge only to per-listing EV/PHEV', async () => {
    const { server, restoreLogs } = loadServerWithStubs({
        api: {
            fetchCarscom: async () => [
                makeListing({ title: '2024 Tesla Model 3', price: '$30,000', fuelType: 'electric', source: 'Cars.com', url: 'https://www.cars.com/vehicledetail/ev1/' }),
                makeListing({ title: '2022 Honda Civic', price: '$20,000', fuelType: 'gas', source: 'Cars.com', url: 'https://www.cars.com/vehicledetail/gas1/' })
            ]
        },
        fees: {
            lookupSalesTax: async () => ({
                state: 'WA', city: 'KIRKLAND', zip: '98033',
                combinedRate: 0.104, stateRate: 0.065, countyRate: 0.005, cityRate: 0.011, districtRate: 0.023
            }),
            feeData: {
                evSurchargeAnnual: () => 300,    // $25/mo
                registrationEstimateAnnual: () => 0
            }
        }
    });
    try {
        // No request-level fuelType — gating is purely per-listing.
        const out = await server.handleSearchCarDeals({
            zip: '98033', sources: ['cars.com']
        });
        const text = out.content[0].text;
        // Pull each block by URL to inspect monthly fees.
        const evBlock = text.split('---').find(b => b.includes('ev1'));
        const gasBlock = text.split('---').find(b => b.includes('gas1'));
        assert.ok(evBlock, 'EV block should be rendered');
        assert.ok(gasBlock, 'gas block should be rendered');
        // EV row should mention monthly fees > 0; gas row should NOT include
        // a "fees" segment (the renderer suppresses 0-fee rows).
        assert.match(evBlock, /\$\d+ fees/, 'EV listing carries the EV surcharge');
        assert.doesNotMatch(gasBlock, /\$\d+ fees/, 'gas listing has no EV surcharge');
    } finally { restoreLogs(); }
});

test('handleSearchCarDeals returns "No listings found" header when all sources are empty', async () => {
    const { server, restoreLogs } = loadServerWithStubs({
        api: {
            fetchCarscom: async () => [],
            fetchAutotrader: async () => []
        }
    });
    try {
        const out = await server.handleSearchCarDeals({ zip: '90210' });
        assert.match(out.content[0].text, /No listings found/);
        assert.equal(out.isError, undefined);
    } finally { restoreLogs(); }
});

test('handleSearchCarDeals reports per-source errors in trailing Errors section', async () => {
    const { server, restoreLogs } = loadServerWithStubs({
        api: {
            fetchCarscom: async () => [makeListing({ url: 'https://www.cars.com/vehicledetail/x/', source: 'Cars.com' })],
            fetchAutotrader: async () => { throw new Error('Akamai page unavailable'); }
        },
        scraper: {
            scrapeAutotrader: async () => { throw new Error('puppeteer unavailable in CI'); }
        }
    });
    try {
        const out = await server.handleSearchCarDeals({ zip: '90210', sources: ['cars.com', 'autotrader'] });
        const text = out.content[0].text;
        assert.match(text, /\*\*Errors:\*\*/);
        assert.match(text, /Autotrader: puppeteer unavailable in CI/);
    } finally { restoreLogs(); }
});
