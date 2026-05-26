'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const apiClientPath = require.resolve('../src/apiClient.js');
const coxRefPath = require.resolve('../src/coxReference.js');

// Synthetic Cox reference covering the makes/models we exercise in tests.
// Codes match the real canonical values verified live against KBB's
// /cars-for-sale/bonnet-reference/searchoptions on 2026-05-15.
const TEST_REFERENCE_PAYLOAD = {
    makeCode: [
        { code: 'TOYOTA', name: 'Toyota', kbbName: 'toyota', models: [
            { code: 'CAMRY', name: 'Camry' },
            { code: 'COROLLA', name: 'Corolla' }
        ]},
        { code: 'KIA', name: 'Kia', kbbName: 'kia', models: [
            { code: 'KIAEV6', name: 'EV6' }
        ]},
        { code: 'HYUND', name: 'Hyundai', kbbName: 'hyundai', models: [
            { code: 'SONATA', name: 'Sonata' },
            { code: 'HYUIONIQ5', name: 'Ioniq 5' }
        ]},
        { code: 'CHEV', name: 'Chevrolet', kbbName: 'chevrolet', models: [
            { code: 'CHEVSUB', name: 'Suburban' }
        ]}
    ]
};

function primeCoxReference() {
    delete require.cache[coxRefPath];
    const ref = require('../src/coxReference.js');
    ref._setCache(ref.buildIndex(TEST_REFERENCE_PAYLOAD));
    return ref;
}

function loadFreshApiClient() {
    delete require.cache[apiClientPath];
    primeCoxReference();
    return require('../src/apiClient.js');
}

function makeFetchResponse({ status = 200, body = '' } = {}) {
    return {
        status,
        async text() { return typeof body === 'string' ? body : JSON.stringify(body); }
    };
}

function withFetchStub(stub, fn) {
    const prev = global.fetch;
    global.fetch = stub;
    return Promise.resolve(fn()).finally(() => { global.fetch = prev; });
}

// ---------- fetchAutotrader ----------

test('fetchAutotrader builds the expected URL/params and parses listings', async () => {
    const { fetchAutotrader } = loadFreshApiClient();
    let captured = null;
    const responseBody = {
        listings: [
            {
                id: 'L1',
                title: '2022 Toyota Camry XSE',
                pricingDetail: { salePrice: 23491 },
                specifications: { mileage: { value: '52,649' } },
                owner: { name: 'Valencia BMW', location: { address: { city: 'Valencia', state: 'CA' } } },
                priceBadge: { label: 'Good Deal' },
                vhrPreview: ['NO_SALVAGE_TITLE', 'NO_ACCIDENTS_REPORTED', 'ONE_OWNER']
            }
        ]
    };

    await withFetchStub(async (url, opts) => {
        captured = { url, opts };
        return makeFetchResponse({ body: responseBody });
    }, async () => {
        const out = await fetchAutotrader({
            zip: '98101',
            make: 'toyota',
            model: 'camry',
            yearMin: 2020,
            yearMax: 2023,
            priceMax: 25000,
            mileageMax: 60000,
            keyword: 'hybrid',
            condition: 'used',
            searchRadius: 75
        }, 5);

        assert.equal(out.length, 1);
        assert.equal(out[0].title, '2022 Toyota Camry XSE');
        assert.equal(out[0].price, '$23,491');
        assert.equal(out[0].mileage, '52,649 mi.');
        assert.equal(out[0].dealerName, 'Valencia BMW');
        assert.equal(out[0].location, 'Valencia, CA');
        assert.equal(out[0].dealRating, 'Good Deal');
        assert.equal(out[0].source, 'Autotrader');
        assert.equal(out[0].url, 'https://www.autotrader.com/cars-for-sale/vehicledetails.xhtml?listingId=L1');
        assert.equal(out[0].isOneOwner, true);
        assert.equal(out[0].noAccidents, true);
        assert.equal(out[0].personalUse, false);
    });

    assert.ok(captured.url.startsWith('https://www.autotrader.com/collections/lcServices/rest/lsc/listing?'));
    const qs = new URL(captured.url).searchParams;
    assert.equal(qs.get('zip'), '98101');
    assert.equal(qs.get('numRecords'), '5');
    assert.equal(qs.get('searchRadius'), '75');
    assert.equal(qs.get('makeCode'), 'TOYOTA');
    // Cox model codes follow no rule — looked up against searchoptions reference.
    assert.equal(qs.get('modelCode'), 'CAMRY');
    assert.equal(qs.get('startYear'), '2020');
    assert.equal(qs.get('endYear'), '2023');
    assert.equal(qs.get('maxPrice'), '25000');
    assert.equal(qs.get('maxMileage'), '60000');
    assert.equal(qs.get('keywordPhrases'), 'hybrid');
    assert.equal(qs.get('listingTypes'), 'USED');
});

test('fetchAutotrader resolves model name "EV6" via Cox reference -> KIAEV6', async () => {
    const { fetchAutotrader } = loadFreshApiClient();
    let captured = null;
    await withFetchStub(async (url) => {
        captured = url;
        return makeFetchResponse({ body: { listings: [] } });
    }, async () => {
        await fetchAutotrader({ zip: '90210', make: 'kia', model: 'EV6' }, 5);
    });
    const qs = new URL(captured).searchParams;
    assert.equal(qs.get('makeCode'), 'KIA');
    assert.equal(qs.get('modelCode'), 'KIAEV6');
});

test('fetchAutotrader resolves "Hyundai Ioniq 5" -> HYUND/HYUIONIQ5 (irregular codes)', async () => {
    const { fetchAutotrader } = loadFreshApiClient();
    let captured = null;
    await withFetchStub(async (url) => {
        captured = url;
        return makeFetchResponse({ body: { listings: [] } });
    }, async () => {
        await fetchAutotrader({ zip: '90210', make: 'Hyundai', model: 'Ioniq 5' }, 5);
    });
    const qs = new URL(captured).searchParams;
    assert.equal(qs.get('makeCode'), 'HYUND');
    assert.equal(qs.get('modelCode'), 'HYUIONIQ5');
});

test('fetchAutotrader silently drops make/model when not in Cox reference (logs and continues)', async () => {
    const { fetchAutotrader } = loadFreshApiClient();
    const prevErr = console.error;
    console.error = () => {}; // suppress lookup-miss warnings
    try {
        let captured = null;
        await withFetchStub(async (url) => {
            captured = url;
            return makeFetchResponse({ body: { listings: [] } });
        }, async () => {
            await fetchAutotrader({ zip: '90210', make: 'NonExistent', model: 'Phantom' }, 5);
        });
        const qs = new URL(captured).searchParams;
        assert.equal(qs.get('makeCode'), null);
        assert.equal(qs.get('modelCode'), null);
        // Other params still go through
        assert.equal(qs.get('zip'), '90210');
    } finally {
        console.error = prevErr;
    }
});

test('fetchAutotrader post-filters when oneOwner/noAccidents/personalUse requested', async () => {
    const { fetchAutotrader } = loadFreshApiClient();
    const body = {
        listings: [
            { id: 'A', vhrPreview: ['ONE_OWNER', 'NO_ACCIDENTS_REPORTED', 'PERSONAL_USE'] },
            { id: 'B', vhrPreview: ['NO_ONE_OWNER', 'NO_ACCIDENTS_REPORTED'] },
            { id: 'C', vhrPreview: ['ONE_OWNER'] },
            { id: 'D', vhrPreview: [] }
        ]
    };
    await withFetchStub(async () => makeFetchResponse({ body }), async () => {
        const noFilter = await fetchAutotrader({ zip: '90210' }, 10);
        assert.equal(noFilter.length, 4, 'no filter returns all 4');

        const oneOwner = await fetchAutotrader({ zip: '90210', oneOwner: true }, 10);
        assert.equal(oneOwner.length, 2);
        const oneOwnerIds = oneOwner.map(l => l.url.split('listingId=')[1]).sort();
        assert.deepEqual(oneOwnerIds, ['A', 'C']);

        const both = await fetchAutotrader({ zip: '90210', oneOwner: true, noAccidents: true }, 10);
        assert.equal(both.length, 1);
        assert.ok(both[0].url.endsWith('listingId=A'));

        const personal = await fetchAutotrader({ zip: '90210', personalUse: true }, 10);
        assert.equal(personal.length, 1);
        assert.ok(personal[0].url.endsWith('listingId=A'));
    });
});

test('fetchAutotrader honours maxResults after filtering', async () => {
    const { fetchAutotrader } = loadFreshApiClient();
    const body = { listings: Array.from({ length: 25 }, (_, i) => ({ id: `L${i}`, vhrPreview: [] })) };
    await withFetchStub(async () => makeFetchResponse({ body }), async () => {
        const out = await fetchAutotrader({ zip: '90210' }, 7);
        assert.equal(out.length, 7);
    });
});

test('fetchAutotrader throws AkamaiBlockError when response body has block sentinel', async () => {
    const { fetchAutotrader, AkamaiBlockError } = loadFreshApiClient();
    await withFetchStub(async () => makeFetchResponse({
        body: '<html><body>Autotrader - page unavailable</body></html>'
    }), async () => {
        await assert.rejects(fetchAutotrader({ zip: '90210' }, 5), (err) => {
            assert.ok(err instanceof AkamaiBlockError, 'instance of AkamaiBlockError');
            assert.match(err.message, /Autotrader/);
            return true;
        });
    });
});

test('fetchAutotrader throws on non-200 status', async () => {
    const { fetchAutotrader } = loadFreshApiClient();
    await withFetchStub(async () => makeFetchResponse({ status: 503, body: 'unavailable' }),
        async () => {
            await assert.rejects(fetchAutotrader({ zip: '90210' }, 5), /HTTP 503/);
        });
});

test('fetchAutotrader throws when response is not JSON', async () => {
    const { fetchAutotrader } = loadFreshApiClient();
    await withFetchStub(async () => makeFetchResponse({ body: 'not json at all' }),
        async () => {
            await assert.rejects(fetchAutotrader({ zip: '90210' }, 5), /non-JSON/);
        });
});

test('isAkamaiBlock detects the sentinel string only', () => {
    const { isAkamaiBlock } = loadFreshApiClient();
    assert.equal(isAkamaiBlock('foo page unavailable bar'), true);
    assert.equal(isAkamaiBlock('all good'), false);
    assert.equal(isAkamaiBlock(undefined), false);
    assert.equal(isAkamaiBlock(null), false);
    assert.equal(isAkamaiBlock(123), false);
});

// ---------- fetchAutotrader: bodyStyle / fuelType filters ----------

test('fetchAutotrader maps bodyStyle and fuelType to Cox query params', async () => {
    const { fetchAutotrader } = loadFreshApiClient();
    let captured = null;
    await withFetchStub(async (url) => {
        captured = url;
        return makeFetchResponse({ body: { listings: [] } });
    }, async () => {
        await fetchAutotrader({ zip: '90210', bodyStyle: 'suv', fuelType: 'ev' }, 5);
    });
    const qs = new URL(captured).searchParams;
    assert.equal(qs.get('bodyStyleCode'), 'SUVCROSS');
    assert.equal(qs.get('fuelTypeGroup'), 'ELE');
});

test('fetchAutotrader normalizes body/fuel inputs (case, dashes, aliases)', async () => {
    const { fetchAutotrader } = loadFreshApiClient();
    let captured = null;
    await withFetchStub(async (url) => {
        captured = url;
        return makeFetchResponse({ body: { listings: [] } });
    }, async () => {
        await fetchAutotrader({ zip: '90210', bodyStyle: 'TRUCK', fuelType: 'plug-in-hybrid' }, 5);
    });
    const qs = new URL(captured).searchParams;
    assert.equal(qs.get('bodyStyleCode'), 'TRUCKS');
    assert.equal(qs.get('fuelTypeGroup'), 'PIH');
});

test('fetchAutotrader maps dealRating=great to dealType=greatprice', async () => {
    const { fetchAutotrader } = loadFreshApiClient();
    let captured = null;
    const body = { listings: [
        { id: 'A', priceBadge: { label: 'Great Deal' }, vhrPreview: [] },
        { id: 'B', priceBadge: { label: 'Good Deal' }, vhrPreview: [] }
    ] };
    await withFetchStub(async (url) => {
        captured = url;
        return makeFetchResponse({ body });
    }, async () => {
        const out = await fetchAutotrader({ zip: '90210', dealRating: 'great' }, 10);
        // Post-filter drops the "Good Deal" entry even if Cox returned it.
        assert.equal(out.length, 1);
        assert.ok(out[0].url.endsWith('listingId=A'));
    });
    const qs = new URL(captured).searchParams;
    assert.equal(qs.get('dealType'), 'greatprice');
});

test('fetchAutotrader maps dealRating=good to dealType=goodprice', async () => {
    const { fetchAutotrader } = loadFreshApiClient();
    let captured = null;
    await withFetchStub(async (url) => {
        captured = url;
        return makeFetchResponse({ body: { listings: [] } });
    }, async () => {
        await fetchAutotrader({ zip: '90210', dealRating: 'good' }, 5);
    });
    const qs = new URL(captured).searchParams;
    assert.equal(qs.get('dealType'), 'goodprice');
});

test('fetchAutotrader does not set dealType for fair (no Cox equivalent)', async () => {
    const { fetchAutotrader } = loadFreshApiClient();
    let captured = null;
    await withFetchStub(async (url) => {
        captured = url;
        return makeFetchResponse({ body: { listings: [] } });
    }, async () => {
        await fetchAutotrader({ zip: '90210', dealRating: 'fair' }, 5);
    });
    const qs = new URL(captured).searchParams;
    assert.equal(qs.get('dealType'), null);
});

test('fetchKbb honours dealRating=great via dealType + post-filter', async () => {
    const { fetchKbb } = loadFreshApiClient();
    let captured = null;
    const body = { listings: [
        { id: 'A', pricingDetail: { dealIndicator: 'Great' }, vhrPreview: [] },
        { id: 'B', pricingDetail: { dealIndicator: 'Fair' }, vhrPreview: [] }
    ] };
    await withFetchStub(async (url) => {
        captured = url;
        return makeFetchResponse({ body });
    }, async () => {
        const out = await fetchKbb({ zip: '98101', dealRating: 'great' }, 10);
        assert.equal(out.length, 1);
        assert.ok(out[0].url.endsWith('listingId=A'));
    });
    const qs = new URL(captured).searchParams;
    assert.equal(qs.get('dealType'), 'greatprice');
});

test('fetchAutotrader silently drops unknown bodyStyle/fuelType values', async () => {
    const { fetchAutotrader } = loadFreshApiClient();
    let captured = null;
    await withFetchStub(async (url) => {
        captured = url;
        return makeFetchResponse({ body: { listings: [] } });
    }, async () => {
        await fetchAutotrader({ zip: '90210', bodyStyle: 'spaceship', fuelType: 'plasma' }, 5);
    });
    const qs = new URL(captured).searchParams;
    assert.equal(qs.get('bodyStyleCode'), null);
    assert.equal(qs.get('fuelTypeGroup'), null);
});

// ---------- fetchKbb ----------

test('fetchKbb hits www.kbb.com with channel=KBB and parses Cox-style listings', async () => {
    const { fetchKbb } = loadFreshApiClient();
    let captured = null;
    const responseBody = {
        listings: [
            {
                id: 'K1',
                title: 'Used 2025 Chevrolet Suburban High Country',
                year: 2025,
                make: { code: 'CHEV', name: 'Chevrolet' },
                model: { code: 'CHEVSUB', name: 'Suburban' },
                pricingDetail: { salePrice: 79920, dealIndicator: 'Great' },
                specifications: { mileage: { value: '12,345' } },
                owner: { name: 'Private Seller Exchange', location: { address: { city: 'Kirkland', state: 'WA' } } },
                vhrPreview: ['NO_SALVAGE_TITLE', 'NO_ACCIDENTS_REPORTED', 'ONE_OWNER']
            }
        ]
    };
    await withFetchStub(async (url) => {
        captured = url;
        return makeFetchResponse({ body: responseBody });
    }, async () => {
        const out = await fetchKbb({ zip: '98101', make: 'Chevrolet' }, 5);
        assert.equal(out.length, 1);
        assert.equal(out[0].title, 'Used 2025 Chevrolet Suburban High Country');
        assert.equal(out[0].price, '$79,920');
        assert.equal(out[0].mileage, '12,345 mi.');
        assert.equal(out[0].dealRating, 'Great');
        assert.equal(out[0].source, 'KBB');
        assert.equal(out[0].url, 'https://www.kbb.com/cars-for-sale/vehicledetails.xhtml?listingId=K1');
        assert.equal(out[0].isOneOwner, true);
        assert.equal(out[0].noAccidents, true);
    });
    const u = new URL(captured);
    assert.equal(u.host, 'www.kbb.com');
    assert.equal(u.pathname, '/rest/lsc/listing');
    assert.equal(u.searchParams.get('channel'), 'KBB');
    assert.equal(u.searchParams.get('zip'), '98101');
});

test('fetchKbb falls back to year/make.name/model.name when title is missing', async () => {
    const { fetchKbb } = loadFreshApiClient();
    const body = { listings: [{
        id: 'K2',
        year: 2023,
        make: { name: 'Toyota' },
        model: { name: 'Camry' },
        trimName: 'XSE',
        vhrPreview: []
    }] };
    await withFetchStub(async () => makeFetchResponse({ body }), async () => {
        const out = await fetchKbb({ zip: '90210' }, 5);
        assert.equal(out[0].title, '2023 Toyota Camry XSE');
    });
});

test('fetchKbb post-filters oneOwner same as Autotrader', async () => {
    const { fetchKbb } = loadFreshApiClient();
    const body = { listings: [
        { id: 'A', vhrPreview: ['ONE_OWNER'] },
        { id: 'B', vhrPreview: ['NO_ONE_OWNER'] }
    ] };
    await withFetchStub(async () => makeFetchResponse({ body }), async () => {
        const out = await fetchKbb({ zip: '90210', oneOwner: true }, 5);
        assert.equal(out.length, 1);
        assert.ok(out[0].url.endsWith('listingId=A'));
    });
});

test('fetchKbb propagates HTTP errors with KBB source label', async () => {
    const { fetchKbb } = loadFreshApiClient();
    await withFetchStub(async () => makeFetchResponse({ status: 503, body: 'down' }),
        async () => {
            await assert.rejects(fetchKbb({ zip: '90210' }, 5), /KBB HTTP 503/);
        });
});

// ---------- fetchCarscom ----------

function stubCarscomApiKey(apiClient, key = 'TEST_KEY') {
    // Replace getCarscomApiKey on the live module so fetchCarscom never touches Puppeteer.
    let calls = 0;
    apiClient.getCarscomApiKey = async () => { calls += 1; return key; };
    return () => calls;
}

// Replace zip distance lookups so fetchCarscom never hits the network. Default
// stub treats all zip pairs as in-radius. Override per-test for radius filtering.
function stubZipDistance(apiClient, distanceFn) {
    const fn = distanceFn || (async () => 0);
    apiClient._zipDistance = {
        distanceMiles: fn,
        getZipCoords: async () => ({ lat: 0, lon: 0 }),
        haversineMiles: () => 0
    };
}

test('fetchCarscom builds GraphQL filters from params and parses analytics.context', async () => {
    const apiClient = loadFreshApiClient();
    stubCarscomApiKey(apiClient);
    stubZipDistance(apiClient);
    const { fetchCarscom } = apiClient;

    let captured = null;
    const responseBody = {
        data: {
            srpSearch: {
                metadata: { totalListings: 1, totalPages: 1 },
                results: [
                    {
                        __typename: 'SrpListingGridCard',
                        listingId: 'CR1',
                        analytics: { context: JSON.stringify({
                            year: 2022, make: 'Toyota', model: 'Camry', trim: 'XSE',
                            price: 23491, mileage: 52649, vin: 'X', seller: { zip: '98101' }
                        })}
                    },
                    { __typename: 'SrpListingGridAd' } // should be ignored
                ]
            }
        }
    };

    await withFetchStub(async (url, opts) => {
        captured = { url, opts };
        return makeFetchResponse({ body: responseBody });
    }, async () => {
        const out = await fetchCarscom({
            zip: '98101', searchRadius: 75,
            make: 'Toyota', model: 'Camry',
            priceMax: 25000, mileageMax: 60000,
            yearMin: 2020, yearMax: 2023,
            keyword: 'hybrid', oneOwner: true, noAccidents: true,
            personalUse: true, dealRating: 'great', condition: 'used'
        }, 5);

        assert.equal(out.length, 1);
        assert.equal(out[0].title, '2022 Toyota Camry XSE');
        assert.equal(out[0].price, '$23,491');
        assert.equal(out[0].mileage, '52,649 mi.');
        assert.equal(out[0].source, 'Cars.com');
        assert.equal(out[0].url, 'https://www.cars.com/vehicledetail/CR1/');
        assert.equal(out[0].location, '98101');
        // CARFAX flags must NOT be set from caller intent — Cars.com's
        // response doesn't expose per-listing CARFAX data, so propagating
        // intent into the badge produces output that claims verification
        // we can't back up. The server-side filter still drops non-matching
        // rows; we just don't re-label them.
        assert.equal(out[0].isOneOwner, false, 'never set isOneOwner from intent');
        assert.equal(out[0].noAccidents, false, 'never set noAccidents from intent');
        assert.equal(out[0].personalUse, false, 'never set personalUse from intent');
    });

    assert.equal(captured.url, 'https://graph.cars.com/graphql/api');
    assert.equal(captured.opts.method, 'POST');
    const headers = captured.opts.headers;
    assert.equal(headers['x-api-key'], 'TEST_KEY');
    assert.equal(headers['x-cars-platform'], 'cars_responsive');
    assert.match(headers['x-cars-trip-id'], /^[0-9a-f-]+$/);

    const sent = JSON.parse(captured.opts.body);
    assert.equal(sent.operationName, 'SearchResultsPageSearch');
    const filters = sent.variables.selectedSearchFilters;
    const byName = Object.fromEntries(filters.map(f => [f.filter, f]));
    assert.deepEqual(byName.area, { filter: 'area', zipCode: '98101', radiusMiles: 75 });
    assert.deepEqual(byName.stock_type, { filter: 'stock_type', value: 'used' });
    assert.deepEqual(byName.makes.values, ['toyota']);
    assert.deepEqual(byName.models.values, ['toyota-camry']);
    assert.equal(byName.list_price_max.value, '25000');
    assert.equal(byName.mileage_max.value, '60000');
    assert.equal(byName.year_min.value, '2020');
    assert.equal(byName.year_max.value, '2023');
    assert.equal(byName.keyword.value, 'hybrid');
    // one_owner and no_accidents are intentionally NOT sent to Cars.com: the server-side
    // filter returns a near-empty ghost response (totalListings=0, context={}) when included.
    assert.equal(byName.one_owner, undefined);
    assert.equal(byName.no_accidents, undefined);
    assert.equal(byName.personal_use.value, 'true');
    assert.deepEqual(byName.deal_ratings.values, ['great']);
    assert.equal(sent.variables.pageSize, 5);
    assert.equal(sent.variables.sort, 'BEST_MATCH_DESC');
});

test('fetchCarscom defaults stock_type=used when condition is omitted', async () => {
    const apiClient = loadFreshApiClient();
    stubCarscomApiKey(apiClient);
    const { fetchCarscom } = apiClient;
    let sent = null;
    await withFetchStub(async (_url, opts) => {
        sent = JSON.parse(opts.body);
        return makeFetchResponse({ body: { data: { srpSearch: { results: [] } } } });
    }, async () => {
        await fetchCarscom({ zip: '90210' }, 5);
    });
    const stockType = sent.variables.selectedSearchFilters.find(f => f.filter === 'stock_type');
    assert.equal(stockType.value, 'used');
});

test('fetchCarscom retries with a refreshed key on Missing API Key', async () => {
    const apiClient = loadFreshApiClient();
    let keyVend = 0;
    apiClient.getCarscomApiKey = async ({ refresh = false } = {}) => {
        keyVend += 1;
        return refresh ? 'KEY_NEW' : 'KEY_OLD';
    };
    stubZipDistance(apiClient);
    const { fetchCarscom } = apiClient;

    let calls = 0;
    const goodBody = { data: { srpSearch: { results: [
        { __typename: 'SrpListingGridCard', listingId: 'X', analytics: { context: '{}' } }
    ] } } };
    await withFetchStub(async (_url, opts) => {
        calls += 1;
        if (calls === 1) {
            assert.equal(opts.headers['x-api-key'], 'KEY_OLD');
            return makeFetchResponse({ status: 200, body: 'Missing API Key' });
        }
        assert.equal(opts.headers['x-api-key'], 'KEY_NEW');
        return makeFetchResponse({ status: 200, body: goodBody });
    }, async () => {
        const out = await fetchCarscom({ zip: '90210' }, 3);
        assert.equal(out.length, 1);
    });
    assert.equal(calls, 2);
    assert.ok(keyVend >= 2);
});

test('fetchCarscom retries on 401/403 too', async () => {
    const apiClient = loadFreshApiClient();
    apiClient.getCarscomApiKey = async ({ refresh = false } = {}) => refresh ? 'KEY_NEW' : 'KEY_OLD';
    stubZipDistance(apiClient);
    const { fetchCarscom } = apiClient;

    let calls = 0;
    await withFetchStub(async () => {
        calls += 1;
        if (calls === 1) return makeFetchResponse({ status: 403, body: 'forbidden' });
        return makeFetchResponse({ status: 200, body: { data: { srpSearch: { results: [] } } } });
    }, async () => {
        const out = await fetchCarscom({ zip: '90210' }, 3);
        assert.deepEqual(out, []);
    });
    assert.equal(calls, 2);
});

test('fetchCarscom throws on persistent non-200', async () => {
    const apiClient = loadFreshApiClient();
    apiClient.getCarscomApiKey = async () => 'K';
    stubZipDistance(apiClient);
    const { fetchCarscom } = apiClient;
    await withFetchStub(async () => makeFetchResponse({ status: 500, body: 'oops' }),
        async () => {
            await assert.rejects(fetchCarscom({ zip: '90210' }, 5), /HTTP 500/);
        });
});

test('fetchCarscom throws on GraphQL errors', async () => {
    const apiClient = loadFreshApiClient();
    apiClient.getCarscomApiKey = async () => 'K';
    stubZipDistance(apiClient);
    const { fetchCarscom } = apiClient;
    await withFetchStub(async () => makeFetchResponse({
        body: { errors: [{ message: 'boom' }] }
    }), async () => {
        await assert.rejects(fetchCarscom({ zip: '90210' }, 5), /GraphQL errors/);
    });
});

test('fetchCarscom throws on non-JSON body', async () => {
    const apiClient = loadFreshApiClient();
    apiClient.getCarscomApiKey = async () => 'K';
    stubZipDistance(apiClient);
    const { fetchCarscom } = apiClient;
    await withFetchStub(async () => makeFetchResponse({ body: 'plain text' }),
        async () => {
            await assert.rejects(fetchCarscom({ zip: '90210' }, 5), /non-JSON/);
        });
});

test('fetchCarscom honours maxResults', async () => {
    const apiClient = loadFreshApiClient();
    apiClient.getCarscomApiKey = async () => 'K';
    stubZipDistance(apiClient);
    const { fetchCarscom } = apiClient;
    const results = Array.from({ length: 10 }, (_, i) => ({
        __typename: 'SrpListingGridCard', listingId: `L${i}`, analytics: { context: '{}' }
    }));
    await withFetchStub(async () => makeFetchResponse({ body: { data: { srpSearch: { results } } } }),
        async () => {
            const out = await fetchCarscom({ zip: '90210' }, 4);
            assert.equal(out.length, 4);
        });
});

test('fetchCarscom tolerates malformed analytics.context', async () => {
    const apiClient = loadFreshApiClient();
    apiClient.getCarscomApiKey = async () => 'K';
    stubZipDistance(apiClient);
    const { fetchCarscom } = apiClient;
    const body = { data: { srpSearch: { results: [
        { __typename: 'SrpListingGridCard', listingId: 'L1', analytics: { context: '{not json' } }
    ] } } };
    await withFetchStub(async () => makeFetchResponse({ body }), async () => {
        const out = await fetchCarscom({ zip: '90210' }, 5);
        assert.equal(out.length, 1);
        assert.equal(out[0].title, null);
        assert.equal(out[0].price, null);
        assert.equal(out[0].url, 'https://www.cars.com/vehicledetail/L1/');
    });
});

test('fetchCarscom emits body_style_slugs and fuel_type_slugs when bodyStyle/fuelType set', async () => {
    const apiClient = loadFreshApiClient();
    apiClient.getCarscomApiKey = async () => 'K';
    stubZipDistance(apiClient);
    const { fetchCarscom } = apiClient;
    let sent = null;
    await withFetchStub(async (_url, opts) => {
        sent = JSON.parse(opts.body);
        return makeFetchResponse({ body: { data: { srpSearch: { results: [] } } } });
    }, async () => {
        await fetchCarscom({ zip: '90210', bodyStyle: 'SUV', fuelType: 'EV' }, 5);
    });
    const filters = Object.fromEntries(
        sent.variables.selectedSearchFilters.map(f => [f.filter, f])
    );
    assert.deepEqual(filters.body_style_slugs.values, ['suv']);
    assert.deepEqual(filters.fuel_type_slugs.values, ['electric']);
});

test('fetchCarscom drops unknown bodyStyle/fuelType silently', async () => {
    const apiClient = loadFreshApiClient();
    apiClient.getCarscomApiKey = async () => 'K';
    stubZipDistance(apiClient);
    const { fetchCarscom } = apiClient;
    let sent = null;
    await withFetchStub(async (_url, opts) => {
        sent = JSON.parse(opts.body);
        return makeFetchResponse({ body: { data: { srpSearch: { results: [] } } } });
    }, async () => {
        await fetchCarscom({ zip: '90210', bodyStyle: 'spaceship', fuelType: 'plasma' }, 5);
    });
    const names = sent.variables.selectedSearchFilters.map(f => f.filter);
    assert.ok(!names.includes('body_style_slugs'));
    assert.ok(!names.includes('fuel_type_slugs'));
});

test('fetchCarscom drops listings outside searchRadius via post-filter', async () => {
    const apiClient = loadFreshApiClient();
    apiClient.getCarscomApiKey = async () => 'K';
    // Simulate Cars.com leaking out-of-radius listings: 98033 -> 97233 ≈ 175mi.
    stubZipDistance(apiClient, async (a, b) => {
        if (a === b) return 0;
        const table = {
            '98033|98034': 3,    // Kirkland (in)
            '98033|98133': 10,   // Shoreline (in)
            '98033|97233': 175,  // Portland OR (out at 100mi)
            '98033|94103': 810   // San Francisco (way out)
        };
        return table[`${a}|${b}`] ?? 0;
    });
    const { fetchCarscom } = apiClient;

    const mk = (id, zip) => ({
        __typename: 'SrpListingGridCard', listingId: id,
        analytics: { context: JSON.stringify({
            year: 2024, make: 'Hyundai', model: 'Ioniq 5', price: 25000, mileage: 20000,
            seller: { zip }
        })}
    });
    const body = { data: { srpSearch: { results: [
        mk('NEAR1', '98034'),
        mk('NEAR2', '98133'),
        mk('FAR1', '97233'),
        mk('FAR2', '94103')
    ]}}};

    await withFetchStub(async () => makeFetchResponse({ body }), async () => {
        const out = await fetchCarscom({ zip: '98033', searchRadius: 100 }, 10);
        const ids = out.map(l => l.url);
        assert.equal(out.length, 2, 'only in-radius listings should remain');
        assert.ok(ids.some(u => u.includes('NEAR1')));
        assert.ok(ids.some(u => u.includes('NEAR2')));
        assert.ok(!ids.some(u => u.includes('FAR1')));
        assert.ok(!ids.some(u => u.includes('FAR2')));
    });
});

test('fetchCarscom keeps listings when distance is unresolvable (fail-open)', async () => {
    const apiClient = loadFreshApiClient();
    apiClient.getCarscomApiKey = async () => 'K';
    // Simulate Zippopotam being unreachable / unknown ZIP — distanceMiles returns null.
    stubZipDistance(apiClient, async () => null);
    const { fetchCarscom } = apiClient;

    const body = { data: { srpSearch: { results: [{
        __typename: 'SrpListingGridCard', listingId: 'L1',
        analytics: { context: JSON.stringify({
            year: 2024, price: 25000, mileage: 20000, seller: { zip: '99999' }
        })}
    }]}}};

    await withFetchStub(async () => makeFetchResponse({ body }), async () => {
        const out = await fetchCarscom({ zip: '98033', searchRadius: 100 }, 10);
        assert.equal(out.length, 1, 'unresolvable distance should fail-open and keep the listing');
    });
});

// ---------- fetchCarmax ----------

test('fetchCarmax builds the expected URL/params and parses items', async () => {
    const { fetchCarmax } = loadFreshApiClient();
    let captured = null;
    const responseBody = {
        totalCount: 1,
        items: [{
            stockNumber: 28510937,
            vin: '5N1BT3BB4PC804659',
            year: 2023, make: 'Nissan', model: 'Rogue', trim: 'SV',
            basePrice: 23998.0,
            mileage: 20539,
            storeName: 'Renton', storeCity: 'Renton', stateAbbreviation: 'WA',
            highlights: ['singleOwner', 'lowMiles'],
            fuelType: null, engineType: 'Gas'
        }]
    };

    await withFetchStub(async (url, opts) => {
        captured = { url, opts };
        return makeFetchResponse({ body: responseBody });
    }, async () => {
        const out = await fetchCarmax({
            zip: '98101', make: 'Nissan', model: 'Rogue',
            priceMax: 25000, mileageMax: 30000, yearMin: 2022, yearMax: 2024,
            bodyStyle: 'suv'
        }, 5);

        assert.equal(out.length, 1);
        assert.equal(out[0].title, '2023 Nissan Rogue SV');
        assert.equal(out[0].price, '$23,998');
        assert.equal(out[0].mileage, '20,539 mi.');
        assert.equal(out[0].dealerName, 'Renton');
        assert.equal(out[0].location, 'Renton, WA');
        assert.equal(out[0].source, 'CarMax');
        assert.equal(out[0].url, 'https://www.carmax.com/car/28510937');
        assert.equal(out[0].isOneOwner, true);
        assert.equal(out[0].noAccidents, false);
    });

    assert.ok(captured.url.startsWith('https://www.carmax.com/cars/api/search/run?'));
    const qs = new URL(captured.url).searchParams;
    assert.equal(qs.get('zipCode'), '98101');
    assert.equal(qs.get('take'), '5');
    assert.equal(qs.get('sort'), 'bestmatch');
    assert.equal(qs.get('shipping'), '-1');
    // uri encodes make/model/bodyStyle as path segments + QS
    const uri = qs.get('uri');
    assert.ok(uri.includes('/nissan/'), `uri should include /nissan/, got: ${uri}`);
    assert.ok(uri.includes('/rogue/'), `uri should include /rogue/, got: ${uri}`);
    assert.ok(uri.includes('suvs'), `uri should include suvs, got: ${uri}`);
    assert.ok(uri.includes('price=25000'), `uri should include price, got: ${uri}`);
    assert.ok(uri.includes('mileage=0-30000'), `uri should include mileage, got: ${uri}`);
    assert.ok(uri.includes('year=2022-2024'), `uri should include year, got: ${uri}`);
});

test('fetchCarmax maps fuelType to engine slug in uri', async () => {
    const { fetchCarmax } = loadFreshApiClient();
    let captured = null;
    await withFetchStub(async (url) => {
        captured = url;
        return makeFetchResponse({ body: { items: [] } });
    }, async () => {
        await fetchCarmax({ zip: '90210', fuelType: 'ev' }, 5);
    });
    const uri = new URL(captured).searchParams.get('uri');
    assert.ok(uri.includes('electric'), `uri should include electric, got: ${uri}`);
});

test('fetchCarmax with no filters builds minimal uri=/cars', async () => {
    const { fetchCarmax } = loadFreshApiClient();
    let captured = null;
    await withFetchStub(async (url) => {
        captured = url;
        return makeFetchResponse({ body: { items: [] } });
    }, async () => {
        await fetchCarmax({ zip: '90210' }, 5);
    });
    const uri = new URL(captured).searchParams.get('uri');
    assert.equal(uri, '/cars');
});

test('fetchCarmax honours maxResults', async () => {
    const { fetchCarmax } = loadFreshApiClient();
    const items = Array.from({ length: 20 }, (_, i) => ({
        stockNumber: i, year: 2023, make: 'Toyota', model: 'Camry', basePrice: 20000,
        mileage: 10000, storeCity: 'Renton', stateAbbreviation: 'WA', highlights: []
    }));
    await withFetchStub(async () => makeFetchResponse({ body: { items } }), async () => {
        const out = await fetchCarmax({ zip: '90210' }, 7);
        assert.equal(out.length, 7);
    });
});

test('fetchCarmax throws on non-200', async () => {
    const { fetchCarmax } = loadFreshApiClient();
    await withFetchStub(async () => makeFetchResponse({ status: 503, body: 'down' }), async () => {
        await assert.rejects(fetchCarmax({ zip: '90210' }, 5), /CarMax HTTP 503/);
    });
});

test('fetchCarmax throws on non-JSON', async () => {
    const { fetchCarmax } = loadFreshApiClient();
    await withFetchStub(async () => makeFetchResponse({ body: 'not json' }), async () => {
        await assert.rejects(fetchCarmax({ zip: '90210' }, 5), /non-JSON/);
    });
});

// ---------- fetchCarmaxFromHtml (SRP HTML fallback) ----------

function makeCarmaxSrpHtml(cars) {
    return `<!DOCTYPE html><html><head></head><body>
<script>var enableClsLogging = false;</script>
<script>
        const cars = ${JSON.stringify(cars)};
        const stores = [];
</script>
<script type="application/ld+json">{"@type":"WebSite"}</script>
</body></html>`;
}

test('fetchCarmaxFromHtml requests SRP page and parses embedded cars[]', async () => {
    const { fetchCarmaxFromHtml } = loadFreshApiClient();
    let captured = null;
    const cars = [{
        stockNumber: 28417658, vin: '4T1K61AK0RU854159',
        year: 2024, make: 'Toyota', model: 'Camry', trim: 'XSE',
        basePrice: 34998, mileage: 5141,
        storeName: 'Renton', storeCity: 'Renton', stateAbbreviation: 'WA',
        highlights: ['singleOwner', 'lowMiles'], priorUseDescriptions: []
    }];
    await withFetchStub(async (url) => {
        captured = url;
        return makeFetchResponse({ body: makeCarmaxSrpHtml(cars) });
    }, async () => {
        const out = await fetchCarmaxFromHtml({
            zip: '98101', make: 'Toyota', model: 'Camry', searchRadius: 50
        }, 5);
        assert.equal(out.length, 1);
        assert.equal(out[0].title, '2024 Toyota Camry XSE');
        assert.equal(out[0].price, '$34,998');
        assert.equal(out[0].mileage, '5,141 mi.');
        assert.equal(out[0].location, 'Renton, WA');
        assert.equal(out[0].url, 'https://www.carmax.com/car/28417658');
        assert.equal(out[0].source, 'CarMax');
        assert.equal(out[0].isOneOwner, true);
    });
    // URL is the SRP page (not /api/), with zip + distance appended
    assert.ok(captured.startsWith('https://www.carmax.com/cars/'),
        `expected /cars/ SRP URL, got: ${captured}`);
    assert.ok(!captured.includes('/api/search/run'),
        'fallback should not hit the API endpoint');
    assert.ok(captured.includes('zipCode=98101'), `zip should be in URL: ${captured}`);
    assert.ok(captured.includes('distance=50'), `distance should be in URL: ${captured}`);
    assert.ok(captured.includes('toyota'), 'toyota slug in path');
    assert.ok(captured.includes('camry'), 'camry slug in path');
});

test('fetchCarmaxFromHtml honours maxResults (SRP returns 24, we cap)', async () => {
    const { fetchCarmaxFromHtml } = loadFreshApiClient();
    const cars = Array.from({ length: 24 }, (_, i) => ({
        stockNumber: 1000 + i, year: 2023, make: 'Toyota', model: 'Camry',
        basePrice: 20000, mileage: 10000,
        storeCity: 'Renton', stateAbbreviation: 'WA', highlights: []
    }));
    await withFetchStub(async () => makeFetchResponse({ body: makeCarmaxSrpHtml(cars) }), async () => {
        const out = await fetchCarmaxFromHtml({ zip: '98101' }, 7);
        assert.equal(out.length, 7);
    });
});

test('fetchCarmaxFromHtml falls back to /cars when no filters are set', async () => {
    const { fetchCarmaxFromHtml } = loadFreshApiClient();
    let captured = null;
    await withFetchStub(async (url) => {
        captured = url;
        return makeFetchResponse({ body: makeCarmaxSrpHtml([]) });
    }, async () => {
        await fetchCarmaxFromHtml({ zip: '90210' }, 5);
    });
    assert.ok(captured.startsWith('https://www.carmax.com/cars?'),
        `expected /cars? root SRP, got: ${captured}`);
});

test('fetchCarmaxFromHtml throws on non-200', async () => {
    const { fetchCarmaxFromHtml } = loadFreshApiClient();
    await withFetchStub(async () => makeFetchResponse({ status: 403, body: 'blocked' }), async () => {
        await assert.rejects(fetchCarmaxFromHtml({ zip: '90210' }, 5), /CarMax HTML HTTP 403/);
    });
});

test('fetchCarmaxFromHtml throws when cars[] is missing', async () => {
    const { fetchCarmaxFromHtml } = loadFreshApiClient();
    await withFetchStub(async () => makeFetchResponse({ body: '<html>no embedded data</html>' }), async () => {
        await assert.rejects(fetchCarmaxFromHtml({ zip: '90210' }, 5), /missing embedded cars\[\]/);
    });
});

test('fetchCarmaxFromHtml throws on malformed cars[] JSON', async () => {
    const { fetchCarmaxFromHtml } = loadFreshApiClient();
    const html = '<html><script>const cars = [{"broken": ];</script></html>';
    await withFetchStub(async () => makeFetchResponse({ body: html }), async () => {
        await assert.rejects(fetchCarmaxFromHtml({ zip: '90210' }, 5), /cars\[\] parse failed/);
    });
});

// ---------- fetchCarvana ----------

// When both make+model are provided, the first request is a typeahead probe
// against /v4/suggest used to learn Carvana's canonical model casing (their
// parentModel filter is case-sensitive and inconsistent: "Camry" vs "RAV4"
// vs "IONIQ 5"). Tests that exercise model filtering route the first fetch
// call to a /v4/suggest response, then forward the rest to the search.
function makeCarvanaSuggestResponse(makeName, parentModelName) {
    return makeFetchResponse({ body: { suggestions: [{
        text: `${makeName} ${parentModelName}`,
        filters: { makes: [{ name: makeName, parentModels: [{ name: parentModelName, trims: [] }] }] }
    }] } });
}

test('fetchCarvana builds the expected request body and parses vehicles', async () => {
    const { fetchCarvana } = loadFreshApiClient();
    let searchCapture = null;
    const responseBody = {
        inventory: { vehicles: [{
            stockNumber: 2004542001,
            vehicleId: 4211608,
            year: 2023, make: 'Volkswagen', model: 'ID.4', trim: 'Standard',
            bodyStyle: 'Suv', mileage: 19590, fuelType: 'Electric',
            price: { total: 21590.0, kbbValue: 20950.0 },
            vdpSlug: '2023-volkswagen-id.4-standard',
            vehicleTags: [{ tagKey: 'KeepMovingPrice', tagName: 'Great Deal' }]
        }] }
    };

    let call = 0;
    await withFetchStub(async (url, opts) => {
        call += 1;
        if (call === 1) return makeCarvanaSuggestResponse('Volkswagen', 'ID.4');
        searchCapture = { url, opts };
        return makeFetchResponse({ body: responseBody });
    }, async () => {
        const out = await fetchCarvana({
            zip: '98160', make: 'Volkswagen', model: 'ID.4',
            priceMax: 25000, mileageMax: 30000, yearMin: 2022,
            bodyStyle: 'suv', fuelType: 'ev'
        }, 5);

        assert.equal(out.length, 1);
        assert.equal(out[0].title, '2023 Volkswagen ID.4 Standard');
        assert.equal(out[0].price, '$21,590');
        assert.equal(out[0].mileage, '19,590 mi.');
        assert.equal(out[0].dealerName, 'Carvana');
        assert.equal(out[0].dealRating, 'Great Deal');
        assert.equal(out[0].source, 'Carvana');
        assert.equal(out[0].url, 'https://www.carvana.com/vehicle/4211608');
        assert.equal(out[0].isOneOwner, false);
    });

    assert.equal(searchCapture.url, 'https://apik.carvana.io/merch/search/api/v2/search');
    assert.equal(searchCapture.opts.method, 'POST');
    const headers = searchCapture.opts.headers;
    assert.equal(headers['content-type'], 'application/json');
    assert.equal(headers['origin'], 'https://www.carvana.com');
    assert.equal(headers['x-cvna-sebs-srp'], 'true');
    assert.match(headers['correlation-context'], /browserCookieId=/);

    const body = JSON.parse(searchCapture.opts.body);
    assert.equal(body.zip5, '98160');
    assert.equal(body.pagination.pageSize, 5);
    assert.equal(body.filters.price.max, 25000);
    assert.equal(body.filters.mileage.max, 30000);
    assert.equal(body.filters.year.min, 2022);
    assert.deepEqual(body.filters.bodyStyles, ['suv']);
    assert.deepEqual(body.filters.fuelTypes, ['Electric']);
    assert.deepEqual(body.filters.makes, [{ name: 'Volkswagen', parentModels: [{ name: 'ID.4' }] }]);
    assert.ok(body.requestedFeatures.includes('ExcludeFacetData'));
});

test('fetchCarvana resolves user model casing to Carvana canonical (e.g. "ioniq 5" -> "IONIQ 5")', async () => {
    const { fetchCarvana } = loadFreshApiClient();
    let body = null;
    let call = 0;
    await withFetchStub(async (_url, opts) => {
        call += 1;
        if (call === 1) return makeCarvanaSuggestResponse('Hyundai', 'IONIQ 5');
        body = JSON.parse(opts.body);
        return makeFetchResponse({ body: { inventory: { vehicles: [] } } });
    }, async () => {
        await fetchCarvana({ zip: '98033', make: 'Hyundai', model: 'ioniq 5' }, 5);
    });
    assert.deepEqual(body.filters.makes, [{ name: 'Hyundai', parentModels: [{ name: 'IONIQ 5' }] }]);
});

test('fetchCarvana resolves title-case model from suggest (e.g. "CAMRY" -> "Camry")', async () => {
    const { fetchCarvana } = loadFreshApiClient();
    let body = null;
    let call = 0;
    await withFetchStub(async (_url, opts) => {
        call += 1;
        if (call === 1) return makeCarvanaSuggestResponse('Toyota', 'Camry');
        body = JSON.parse(opts.body);
        return makeFetchResponse({ body: { inventory: { vehicles: [] } } });
    }, async () => {
        await fetchCarvana({ zip: '98033', make: 'Toyota', model: 'CAMRY' }, 5);
    });
    assert.deepEqual(body.filters.makes, [{ name: 'Toyota', parentModels: [{ name: 'Camry' }] }]);
});

test('fetchCarvana falls through with user-supplied model when suggest probe has no match', async () => {
    const { fetchCarvana } = loadFreshApiClient();
    let body = null;
    let call = 0;
    await withFetchStub(async (_url, opts) => {
        call += 1;
        // suggest returns empty -> resolver falls through to user input
        if (call === 1) return makeFetchResponse({ body: { suggestions: [] } });
        body = JSON.parse(opts.body);
        return makeFetchResponse({ body: { inventory: { vehicles: [] } } });
    }, async () => {
        await fetchCarvana({ zip: '98033', make: 'Toyota', model: 'Tundra' }, 5);
    });
    assert.deepEqual(body.filters.makes, [{ name: 'Toyota', parentModels: [{ name: 'Tundra' }] }]);
});

test('fetchCarvana skips the suggest probe when model is omitted', async () => {
    const { fetchCarvana } = loadFreshApiClient();
    let body = null;
    let call = 0;
    await withFetchStub(async (_url, opts) => {
        call += 1;
        body = JSON.parse(opts.body);
        return makeFetchResponse({ body: { inventory: { vehicles: [] } } });
    }, async () => {
        await fetchCarvana({ zip: '90210', make: 'Toyota' }, 5);
    });
    assert.equal(call, 1, 'no model -> no suggest probe, only the search call');
    assert.deepEqual(body.filters.makes, [{ name: 'Toyota' }]);
});

test('fetchCarvana omits empty filter keys', async () => {
    const { fetchCarvana } = loadFreshApiClient();
    let body = null;
    await withFetchStub(async (_url, opts) => {
        body = JSON.parse(opts.body);
        return makeFetchResponse({ body: { inventory: { vehicles: [] } } });
    }, async () => {
        await fetchCarvana({ zip: '90210' }, 5);
    });
    assert.ok(!('price' in body.filters));
    assert.ok(!('makes' in body.filters));
    assert.ok(!('bodyStyles' in body.filters));
    assert.ok(!('fuelTypes' in body.filters));
});

test('fetchCarvana maps dealRating=null when no KeepMovingPrice tag', async () => {
    const { fetchCarvana } = loadFreshApiClient();
    const responseBody = { inventory: { vehicles: [{
        year: 2022, make: 'Honda', model: 'Civic', price: { total: 18000 },
        mileage: 25000, vehicleId: 9001, vehicleTags: []
    }] } };
    await withFetchStub(async () => makeFetchResponse({ body: responseBody }), async () => {
        const out = await fetchCarvana({ zip: '90210' }, 5);
        assert.equal(out[0].dealRating, null);
    });
});

test('fetchCarvana honours maxResults', async () => {
    const { fetchCarvana } = loadFreshApiClient();
    const vehicles = Array.from({ length: 20 }, (_, i) => ({
        year: 2023, make: 'Toyota', model: 'Camry', price: { total: 20000 },
        mileage: 10000, vehicleId: 1000 + i, vehicleTags: []
    }));
    await withFetchStub(async () => makeFetchResponse({ body: { inventory: { vehicles } } }), async () => {
        const out = await fetchCarvana({ zip: '90210' }, 6);
        assert.equal(out.length, 6);
    });
});

test('fetchCarvana throws on non-200', async () => {
    const { fetchCarvana } = loadFreshApiClient();
    await withFetchStub(async () => makeFetchResponse({ status: 503, body: 'down' }), async () => {
        await assert.rejects(fetchCarvana({ zip: '90210' }, 5), /Carvana HTTP 503/);
    });
});

test('fetchCarvana throws on non-JSON', async () => {
    const { fetchCarvana } = loadFreshApiClient();
    await withFetchStub(async () => makeFetchResponse({ body: 'not json' }), async () => {
        await assert.rejects(fetchCarvana({ zip: '90210' }, 5), /non-JSON/);
    });
});

test('fetchCarscom keeps listings when seller.zip is missing (fail-open)', async () => {
    const apiClient = loadFreshApiClient();
    apiClient.getCarscomApiKey = async () => 'K';
    let distanceCalls = 0;
    stubZipDistance(apiClient, async () => { distanceCalls += 1; return 999999; });
    const { fetchCarscom } = apiClient;

    const body = { data: { srpSearch: { results: [{
        __typename: 'SrpListingGridCard', listingId: 'L1',
        analytics: { context: JSON.stringify({ year: 2024, price: 25000 }) } // no seller.zip
    }]}}};

    await withFetchStub(async () => makeFetchResponse({ body }), async () => {
        const out = await fetchCarscom({ zip: '98033', searchRadius: 100 }, 10);
        assert.equal(out.length, 1, 'no seller zip → keep listing without checking distance');
        assert.equal(distanceCalls, 0, 'should not call distanceMiles when seller zip is missing');
    });
});
