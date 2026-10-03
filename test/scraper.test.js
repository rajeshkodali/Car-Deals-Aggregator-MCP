'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const puppeteer = require('puppeteer-extra');
const { scrapeAutotrader, scrapeKBB, filterCarGurusListings, buildCarGurusSearchUrl } = require('../src/scraper.js');

async function withBrowserResponse(body, run) {
    const originalLaunch = puppeteer.launch;
    const calls = { navigation: null, apiPath: null, closed: 0 };
    puppeteer.launch = async () => ({
        newPage: async () => ({
            setViewport: async () => {},
            goto: async url => { calls.navigation = url; },
            evaluate: async (_fn, url) => {
                calls.apiPath = url;
                return { status: 200, body: JSON.stringify(body) };
            }
        }),
        close: async () => { calls.closed += 1; }
    });
    try { await run(calls); } finally { puppeteer.launch = originalLaunch; }
}

const params = {
    zip: '98033', yearMin: 2023, priceMax: 27500, searchRadius: 200,
    fuelType: 'ev', driveType: 'awd', oneOwner: true, noAccidents: true,
    condition: 'used'
};
const flags = ['ONE_OWNER', 'NO_ACCIDENTS_REPORTED'];
function coxListing(id, overrides = {}) {
    return {
        id, year: 2024, pricingDetail: { salePrice: 25000 },
        fuelType: { group: 'Electric' },
        specifications: { driveType: { value: 'All Wheel Drive' } },
        vhrPreview: flags,
        ...overrides
    };
}

for (const [source, scrape, host, path] of [
    ['Autotrader', scrapeAutotrader, 'autotrader.com', '/collections/lcServices/rest/lsc/listing'],
    ['KBB', scrapeKBB, 'kbb.com', '/rest/lsc/listing']
]) {
    test(`${source} browser fallback uses structured Cox data and enforces strict EV search`, async () => {
        const listings = [
            coxListing('MATCH'),
            coxListing('RWD', { specifications: { driveType: { value: 'Rear Wheel Drive' } } }),
            coxListing('OLD', { year: 2022 }),
            coxListing('EXPENSIVE', { pricingDetail: { salePrice: 28000 } }),
            coxListing('ACCIDENT', { vhrPreview: ['ONE_OWNER'] })
        ];
        await withBrowserResponse({ listings }, async calls => {
            const out = await scrape(params, 50);
            assert.deepEqual(out.map(l => l.url),
                [`https://www.${host}/cars-for-sale/vehicledetails.xhtml?listingId=MATCH`]);
            assert.equal(out[0].fuelType, 'electric');
            assert.equal(out[0].driveType, 'awd');
            assert.equal(out[0].isOneOwner, true);
            assert.equal(out[0].noAccidents, true);
            assert.ok(calls.navigation.includes(host));
            const url = new URL(calls.apiPath, `https://www.${host}`);
            assert.equal(url.pathname, path);
            assert.equal(url.searchParams.get('zip'), '98033');
            assert.equal(url.searchParams.get('startYear'), '2023');
            assert.equal(url.searchParams.get('maxPrice'), '27500');
            assert.equal(url.searchParams.get('searchRadius'), '200');
            assert.equal(url.searchParams.get('numRecords'), '100');
            assert.equal(url.searchParams.get('fuelTypeGroup'), 'ELE');
            assert.equal(url.searchParams.get('channel'), source === 'KBB' ? 'KBB' : null);
            assert.equal(calls.closed, 1);
        });
    });

    test(`${source} browser fallback rejects an invalid Cox response`, async () => {
        await withBrowserResponse({ unexpected: [] }, async calls => {
            await assert.rejects(scrape(params, 50), /missing listings array/);
            assert.equal(calls.closed, 1);
        });
    });
}

test('KBB browser fallback paginates across a page with no matching drivetrain', async () => {
    const originalLaunch = puppeteer.launch;
    const offsets = [];
    puppeteer.launch = async () => ({
        newPage: async () => ({
            setViewport: async () => {}, goto: async () => {},
            evaluate: async (_fn, url) => {
                const offset = Number(new URL(url, 'https://www.kbb.com').searchParams.get('firstRecord') || 0);
                offsets.push(offset);
                const row = (id, drive) => coxListing(id, { specifications: { driveType: { value: drive } } });
                return { status: 200, body: JSON.stringify({
                    totalResultCount: 6,
                    listings: offset === 0
                        ? [0, 1, 2, 3].map(i => row(`RWD${i}`, 'Rear Wheel Drive'))
                        : [row('AWD1', 'All Wheel Drive'), row('AWD2', 'All Wheel Drive')]
                }) };
            }
        }), close: async () => {}
    });
    try {
        const out = await scrapeKBB(params, 2);
        assert.equal(out.length, 2);
        assert.deepEqual(offsets, [0, 4]);
    } finally { puppeteer.launch = originalLaunch; }
});

test('CarGurus keeps only locally verified electric AWD listings', () => {
    const base = {
        year: '2024', price: '$25,000', mileage: '22K mi', fuelType: 'Electric',
        driveTrain: 'All-Wheel Drive', locationCity: 'Kirkland, WA', locationDetail: '12.5 mi away'
    };
    const raw = [
        { ...base, id: 'MATCH' },
        { ...base, id: 'GAS', fuelType: 'Gasoline' },
        { ...base, id: 'RWD', driveTrain: 'Rear-Wheel Drive' },
        { ...base, id: 'OLD', year: '2022' },
        { ...base, id: 'EXPENSIVE', price: '$28,000' },
        { ...base, id: 'FAR', locationDetail: '250 mi away' },
        { ...base, id: 'SHIPPED', locationCity: 'Home delivery from Texas', locationDetail: 'Price includes $1,500 shipping' },
        { ...base, id: 'UNKNOWN', locationDetail: null }
    ];
    const out = filterCarGurusListings(raw, {
        zip: '98033', yearMin: 2023, priceMax: 27500, searchRadius: 200,
        fuelType: 'ev', driveType: 'awd', mileageMax: 30000
    });
    assert.deepEqual(out.map(l => l.id), ['MATCH']);
});

test('CarGurus applies verified EV and AWD filters before reading the first page', () => {
    const url = new URL(buildCarGurusSearchUrl({
        zip: '98033', searchRadius: 200, yearMin: 2023, fuelType: 'ev', driveType: 'awd'
    }));
    assert.equal(url.searchParams.get('fuelTypes'), 'ELECTRIC');
    assert.equal(url.searchParams.get('wheelSystems'), 'ALL_WHEEL_DRIVE');
    assert.equal(url.searchParams.get('zip'), '98033');
    assert.equal(url.searchParams.get('distance'), '200');
});
