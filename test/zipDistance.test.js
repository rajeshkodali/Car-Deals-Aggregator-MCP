'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const zipDistancePath = require.resolve('../src/zipDistance.js');

function loadFresh() {
    delete require.cache[zipDistancePath];
    return require('../src/zipDistance.js');
}

function withFetchStub(stub, fn) {
    const prev = global.fetch;
    global.fetch = stub;
    return Promise.resolve(fn()).finally(() => { global.fetch = prev; });
}

function jsonResponse({ status = 200, body }) {
    return {
        status,
        async json() { return body; }
    };
}

test('haversineMiles is roughly correct for known city pairs', () => {
    const { haversineMiles } = loadFresh();
    // Kirkland WA (98033) ↔ Bellevue WA (98005): ~3 miles
    const d1 = haversineMiles({ lat: 47.6815, lon: -122.2087 }, { lat: 47.6101, lon: -122.2015 });
    assert.ok(d1 > 4 && d1 < 7, `Kirkland-Bellevue should be 4-7mi, got ${d1.toFixed(1)}`);

    // Kirkland WA ↔ Portland OR (97233): ~150-180mi
    const d2 = haversineMiles({ lat: 47.6815, lon: -122.2087 }, { lat: 45.5152, lon: -122.4760 });
    assert.ok(d2 > 140 && d2 < 200, `Kirkland-Portland should be 140-200mi, got ${d2.toFixed(0)}`);

    // Same point → 0
    const d3 = haversineMiles({ lat: 40, lon: -120 }, { lat: 40, lon: -120 });
    assert.equal(d3, 0);
});

test('getZipCoords parses the Zippopotam payload', async () => {
    const mod = loadFresh();
    let called = 0;
    await withFetchStub(async (url) => {
        called += 1;
        assert.match(url, /\/us\/98033$/);
        return jsonResponse({ body: {
            'post code': '98033', country: 'United States',
            places: [{ 'place name': 'Kirkland', latitude: '47.6815', longitude: '-122.2087', state: 'Washington' }]
        }});
    }, async () => {
        const c = await mod.getZipCoords('98033');
        assert.deepEqual(c, { lat: 47.6815, lon: -122.2087 });
    });
    assert.equal(called, 1);
});

test('getZipCoords caches results and skips repeat fetches', async () => {
    const mod = loadFresh();
    let called = 0;
    await withFetchStub(async () => {
        called += 1;
        return jsonResponse({ body: { places: [{ latitude: '40', longitude: '-100' }] } });
    }, async () => {
        await mod.getZipCoords('12345');
        await mod.getZipCoords('12345');
        await mod.getZipCoords('12345');
    });
    assert.equal(called, 1, 'second/third lookups should hit the cache');
});

test('getZipCoords returns null on 404 (unknown ZIP)', async () => {
    const mod = loadFresh();
    await withFetchStub(async () => jsonResponse({ status: 404, body: {} }), async () => {
        const c = await mod.getZipCoords('00000');
        assert.equal(c, null);
    });
});

test('getZipCoords rejects non-5-digit input without making a request', async () => {
    const mod = loadFresh();
    let called = 0;
    await withFetchStub(async () => { called += 1; return jsonResponse({ body: {} }); }, async () => {
        assert.equal(await mod.getZipCoords('abc'), null);
        assert.equal(await mod.getZipCoords('1234'), null);
        assert.equal(await mod.getZipCoords(null), null);
    });
    assert.equal(called, 0);
});

test('distanceMiles short-circuits when both ZIPs are equal', async () => {
    const mod = loadFresh();
    let called = 0;
    await withFetchStub(async () => { called += 1; return jsonResponse({ body: {} }); }, async () => {
        const d = await mod.distanceMiles('98033', '98033');
        assert.equal(d, 0);
    });
    assert.equal(called, 0, 'identical zips should not trigger lookups');
});

test('distanceMiles returns null when either ZIP is unresolvable', async () => {
    const mod = loadFresh();
    await withFetchStub(async (url) => {
        if (url.endsWith('/98033')) {
            return jsonResponse({ body: { places: [{ latitude: '47.6815', longitude: '-122.2087' }] } });
        }
        return jsonResponse({ status: 404, body: {} });
    }, async () => {
        const d = await mod.distanceMiles('98033', '00000');
        assert.equal(d, null);
    });
});

test('distanceMiles computes a real distance between two known ZIPs', async () => {
    const mod = loadFresh();
    await withFetchStub(async (url) => {
        if (url.endsWith('/98033')) {
            return jsonResponse({ body: { places: [{ latitude: '47.6815', longitude: '-122.2087' }] } });
        }
        if (url.endsWith('/98005')) {
            return jsonResponse({ body: { places: [{ latitude: '47.6101', longitude: '-122.1604' }] } });
        }
        return jsonResponse({ status: 404, body: {} });
    }, async () => {
        const d = await mod.distanceMiles('98033', '98005');
        assert.ok(d != null && d > 4 && d < 8, `Kirkland-Bellevue expected ~5mi, got ${d}`);
    });
});
