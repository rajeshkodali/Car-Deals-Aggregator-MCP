const { CarListing } = require('./carListing.js');
const coxRef = require('./coxReference.js');
const zipDistance = require('./zipDistance.js');
const { fetchWithTimeout } = require('./httpClient.js');

// Listing endpoints get the default 15s; the Carvana suggest probe is
// tiny so we keep it shorter.
const FETCH_TIMEOUT_MS = 15_000;
const FETCH_TIMEOUT_FAST_MS = 8_000;

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';

class AkamaiBlockError extends Error {
    constructor(source) {
        super(`${source} request blocked (Akamai page unavailable)`);
        this.name = 'AkamaiBlockError';
    }
}

function isAkamaiBlock(text) {
    return typeof text === 'string' && text.includes('page unavailable');
}

// Cars.com URL slugs for body_style_slugs / fuel_type_slugs filters.
const CARS_BODY_STYLE_SLUGS = {
    sedan: 'sedan', suv: 'suv', truck: 'truck', coupe: 'coupe',
    hatchback: 'hatchback', convertible: 'convertible', wagon: 'wagon',
    minivan: 'minivan', van: 'van'
};
const CARS_FUEL_TYPE_SLUGS = {
    gas: 'gasoline', gasoline: 'gasoline',
    hybrid: 'hybrid',
    ev: 'electric', electric: 'electric',
    plugin_hybrid: 'plug_in_hybrid', plug_in_hybrid: 'plug_in_hybrid',
    diesel: 'diesel', flex_fuel: 'flex_fuel', e85: 'flex_fuel'
};
// Autotrader codes for bodyStyleCode / fuelTypeGroup query params.
const AT_BODY_STYLE_CODES = {
    sedan: 'SEDAN', suv: 'SUVCROSS', truck: 'TRUCKS', coupe: 'COUPE',
    hatchback: 'HATCH', convertible: 'CONVERT', wagon: 'WAGON',
    minivan: 'MINIVAN', van: 'VANS'
};
const AT_FUEL_GROUPS = {
    gas: 'GSL', gasoline: 'GSL',
    hybrid: 'HYB',
    ev: 'ELE', electric: 'ELE',
    plugin_hybrid: 'PIH', plug_in_hybrid: 'PIH',
    diesel: 'DSL', hydrogen: 'HYD'
};

// CarMax URI path slugs for make/model/body-style segments.
// Make/model slugs are lowercase, spaces replaced with hyphens (e.g. "land-rover").
// Body style slugs discovered from filterCategories.VehicleType in HAR responses.
const CARMAX_BODY_STYLE_SLUGS = {
    sedan: 'sedans', suv: 'suvs', truck: 'pickup-trucks', coupe: 'coupes',
    hatchback: 'hatchbacks', convertible: 'convertibles', wagon: 'wagons',
    minivan: 'minivans', van: 'vans'
};
// CarMax EngineType slugs (from filterCategories.EngineType in HAR).
const CARMAX_ENGINE_SLUGS = {
    gas: 'gas', gasoline: 'gas',
    hybrid: 'hybrid',
    ev: 'electric', electric: 'electric',
    plugin_hybrid: 'plug-in-hybrid', plug_in_hybrid: 'plug-in-hybrid',
    diesel: 'diesel'
};

// Carvana bodyStyles / fuelTypes filter values.
const CARVANA_BODY_STYLES = {
    sedan: 'sedan', suv: 'suv', truck: 'truck', coupe: 'coupe',
    hatchback: 'hatchback', convertible: 'convertible', wagon: 'wagon',
    minivan: 'minivan', van: 'van'
};
const CARVANA_FUEL_TYPES = {
    gas: 'Gas', gasoline: 'Gas',
    hybrid: 'Hybrid',
    ev: 'Electric', electric: 'Electric',
    plugin_hybrid: 'Plug-In Hybrid', plug_in_hybrid: 'Plug-In Hybrid',
    diesel: 'Diesel'
};

function normalizeKey(s) {
    return String(s).toLowerCase().replace(/[\s-]+/g, '_');
}
function mapBodyStyleCars(s) { return CARS_BODY_STYLE_SLUGS[normalizeKey(s)] || null; }
function mapFuelTypeCars(s) { return CARS_FUEL_TYPE_SLUGS[normalizeKey(s)] || null; }
function mapBodyStyleAutotrader(s) { return AT_BODY_STYLE_CODES[normalizeKey(s)] || null; }
function mapFuelTypeAutotrader(s) { return AT_FUEL_GROUPS[normalizeKey(s)] || null; }

// Normalize the per-listing fuel type returned by various sources to a
// stable internal vocabulary used for the EV-surcharge gate in server.js.
// Inputs come from: Cars.com analytics.context.fuel_type ("Electric",
// "Hybrid", "Plug-In Hybrid"), Cox `fuelType.code`/`fuelType.name`,
// CarMax `engineType` ("Electric", "Hybrid", "Plug-In Hybrid", "Gas"),
// Carvana `fuelType` ("Electric", "Plug-In Hybrid", "Gas", "Hybrid",
// "Diesel"). Returns null on miss so callers know the source didn't
// expose it (instead of misclassifying).
function normalizeFuelType(raw) {
    if (raw == null) return null;
    const k = String(raw).toLowerCase().replace(/[\s\-]+/g, '_');
    if (!k) return null;
    if (k === 'electric' || k === 'ev' || k === 'ele' || k === 'bev') return 'electric';
    if (k === 'plug_in_hybrid' || k === 'plugin_hybrid' || k === 'phev' || k === 'pih') return 'plug_in_hybrid';
    if (k === 'hybrid' || k === 'hev' || k === 'hyb') return 'hybrid';
    if (k === 'diesel' || k === 'dsl') return 'diesel';
    if (k === 'gas' || k === 'gasoline' || k === 'gsl') return 'gas';
    if (k === 'flex_fuel' || k === 'e85' || k === 'flx') return 'flex_fuel';
    if (k === 'hydrogen' || k === 'hyd' || k === 'fcev') return 'hydrogen';
    return null;
}

// Build the shared Cox /rest/lsc/listing query string used by both Autotrader
// and KBB. Caller adds host- and channel-specific bits (e.g. `channel=KBB`).
// Async because makeCode/modelCode are looked up against a runtime-fetched
// reference (see src/coxReference.js — the codes don't follow a regular rule).
// Unknown make/model values are silently dropped (with a log) so the search
// degrades to broader results rather than failing.
async function buildCoxListingQuery(params, maxResults) {
    const qs = new URLSearchParams();
    qs.set('zip', params.zip || '90210');
    qs.set('numRecords', String(Math.min(Math.max(maxResults, 1), 100)));
    qs.set('searchRadius', String(params.searchRadius || 50));
    qs.set('sortBy', params.sortBy || 'relevance');
    if (params.make) {
        const code = await coxRef.lookupMakeCode(params.make);
        if (code) qs.set('makeCode', code);
        else console.error(`[apiClient] Cox makeCode lookup miss for "${params.make}" — searching without make filter`);
    }
    if (params.make && params.model) {
        const code = await coxRef.lookupModelCode(params.make, params.model);
        if (code) qs.set('modelCode', code);
        else console.error(`[apiClient] Cox modelCode lookup miss for "${params.make} ${params.model}" — searching without model filter`);
    }
    if (params.yearMin) qs.set('startYear', String(params.yearMin));
    if (params.yearMax) qs.set('endYear', String(params.yearMax));
    if (params.priceMax) qs.set('maxPrice', String(params.priceMax));
    if (params.mileageMax) qs.set('maxMileage', String(params.mileageMax));
    if (params.keyword) qs.set('keywordPhrases', params.keyword);
    if (params.condition === 'new') qs.set('listingTypes', 'NEW');
    else if (params.condition === 'used') qs.set('listingTypes', 'USED');
    if (params.bodyStyle) {
        const code = mapBodyStyleAutotrader(params.bodyStyle);
        if (code) qs.set('bodyStyleCode', code);
    }
    if (params.fuelType) {
        const code = mapFuelTypeAutotrader(params.fuelType);
        if (code) qs.set('fuelTypeGroup', code);
    }
    // Cox /rest/lsc/listing supports dealType=greatprice|goodprice. There's no
    // server-side "fair" tier — it's a Cars.com-only rating. Silently ignore it
    // here; per-listing dealRating still surfaces in the response.
    if (params.dealRating === 'great') qs.set('dealType', 'greatprice');
    else if (params.dealRating === 'good') qs.set('dealType', 'goodprice');
    return qs;
}

// Map a Cox /rest/lsc/listing entry to a CarListing. KBB and Autotrader return
// nearly identical shapes; the small differences (priceBadge vs pricingDetail.dealIndicator,
// makeName-string vs make.name-object, VDP host) are absorbed via the `flavor` arg.
function mapCoxListing(l, flavor) {
    const vhr = Array.isArray(l.vhrPreview) ? l.vhrPreview : [];
    const makeName = typeof l.make === 'object' ? l.make?.name : l.makeName;
    const modelName = typeof l.model === 'object' ? l.model?.name : l.modelName;
    const dealRating = l.priceBadge?.label || l.pricingDetail?.dealIndicator || null;
    const title = l.title || [l.year, makeName, modelName, l.trimName].filter(Boolean).join(' ') || null;
    const url = l.id ? `${flavor.vdpBase}?listingId=${l.id}` : null;
    // fuelType is reported under `fuelType.code` (e.g. "ELE", "PIH", "HYB",
    // "GSL", "DSL") on Cox listings. Some shapes use `fuelType.name`.
    const rawFuel = l.fuelType?.code || l.fuelType?.name || l.fuelType;
    return new CarListing({
        title,
        price: l.pricingDetail?.salePrice ? `$${Number(l.pricingDetail.salePrice).toLocaleString()}` : null,
        mileage: l.specifications?.mileage?.value ? `${l.specifications.mileage.value} mi.` : null,
        dealerName: l.owner?.name || null,
        location: [l.owner?.location?.address?.city, l.owner?.location?.address?.state].filter(Boolean).join(', ') || null,
        dealRating,
        url,
        source: flavor.source,
        // Cox `vhrPreview` is source-verified per-listing data — safe to populate.
        isOneOwner: vhr.includes('ONE_OWNER'),
        noAccidents: vhr.includes('NO_ACCIDENTS_REPORTED'),
        personalUse: vhr.includes('PERSONAL_USE'),
        fuelType: normalizeFuelType(rawFuel)
    });
}

async function fetchCoxListings(url, flavor, params, maxResults) {
    const res = await fetchWithTimeout(url, {
        headers: {
            'user-agent': UA,
            'accept': '*/*',
            'accept-language': 'en-US,en;q=0.9',
            'referer': flavor.referer
        }
    }, { timeoutMs: FETCH_TIMEOUT_MS, label: flavor.source });
    const text = await res.text();
    if (res.status !== 200) throw new Error(`${flavor.source} HTTP ${res.status}`);
    if (isAkamaiBlock(text)) throw new AkamaiBlockError(flavor.source);
    let data;
    try { data = JSON.parse(text); } catch { throw new Error(`${flavor.source} returned non-JSON`); }
    const raw = Array.isArray(data.listings) ? data.listings : [];
    let mapped = raw.map(l => mapCoxListing(l, flavor));
    // Server-side flags are unreliable on this endpoint; post-filter.
    if (params.oneOwner) mapped = mapped.filter(l => l.isOneOwner);
    if (params.noAccidents) mapped = mapped.filter(l => l.noAccidents);
    if (params.personalUse) mapped = mapped.filter(l => l.personalUse);
    // Defense in depth on dealRating: if the caller asked for great/good and
    // the server returned mixed results anyway, drop the rest. Cox's per-listing
    // rating is "Great" / "Good" (capitalized) in priceBadge.label or
    // pricingDetail.dealIndicator. "fair" has no Cox equivalent — skip filtering.
    if (params.dealRating === 'great') mapped = mapped.filter(l => /great/i.test(l.dealRating || ''));
    else if (params.dealRating === 'good') mapped = mapped.filter(l => /good/i.test(l.dealRating || ''));
    return mapped.slice(0, maxResults);
}

async function fetchAutotrader(params, maxResults = 20) {
    const qs = await buildCoxListingQuery(params, maxResults);
    const url = `https://www.autotrader.com/collections/lcServices/rest/lsc/listing?${qs.toString()}`;
    return fetchCoxListings(url, {
        source: 'Autotrader',
        referer: 'https://www.autotrader.com/',
        vdpBase: 'https://www.autotrader.com/cars-for-sale/vehicledetails.xhtml'
    }, params, maxResults);
}

async function fetchKbb(params, maxResults = 20) {
    const qs = await buildCoxListingQuery(params, maxResults);
    qs.set('channel', 'KBB');
    const url = `https://www.kbb.com/rest/lsc/listing?${qs.toString()}`;
    return fetchCoxListings(url, {
        source: 'KBB',
        referer: 'https://www.kbb.com/cars-for-sale/all',
        vdpBase: 'https://www.kbb.com/cars-for-sale/vehicledetails.xhtml'
    }, params, maxResults);
}

// Acquired dynamically from cars.com homepage on first use. Module-level cache.
let cachedCarscomApiKey = null;
let inFlightKeyFetch = null;

async function acquireCarscomApiKey() {
    // Lazy-load puppeteer/stealth: this function only runs on the first
    // Cars.com request of a process, and many callers (CarMax/Carvana-only,
    // tests) never need it. Keeps `require('./apiClient.js')` puppeteer-free.
    const puppeteer = require('puppeteer-extra');
    const StealthPlugin = require('puppeteer-extra-plugin-stealth');
    puppeteer.use(StealthPlugin());

    // Same hardening as scraper.js launchBrowser() — we navigate to
    // https://www.cars.com/, an untrusted third-party page. Disabling the
    // Chromium sandbox here would be a direct path from a renderer
    // compromise to host code execution. If a specific environment
    // legitimately needs --no-sandbox, do it via env var on a
    // per-deployment basis, not in committed code.
    const browser = await puppeteer.launch({ headless: 'new' });
    try {
        const page = await browser.newPage();
        await page.setViewport({ width: 1920, height: 1080 });
        let key = null;
        page.on('request', (req) => {
            if (key) return;
            if (req.url().includes('graph.cars.com')) {
                const k = req.headers()['x-api-key'];
                if (k) key = k;
            }
        });
        await page.goto('https://www.cars.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
        const deadline = Date.now() + 30000;
        while (!key && Date.now() < deadline) {
            await new Promise(r => setTimeout(r, 250));
        }
        if (!key) throw new Error('Could not intercept x-api-key from cars.com');
        return key;
    } finally {
        await browser.close().catch(() => {});
    }
}

async function getCarscomApiKey({ refresh = false } = {}) {
    if (refresh) cachedCarscomApiKey = null;
    if (cachedCarscomApiKey) return cachedCarscomApiKey;
    if (inFlightKeyFetch) return inFlightKeyFetch;
    inFlightKeyFetch = acquireCarscomApiKey()
        .then(k => { cachedCarscomApiKey = k; return k; })
        .finally(() => { inFlightKeyFetch = null; });
    return inFlightKeyFetch;
}

const CARSCOM_SRP_QUERY = `query SearchResultsPageSearch($page: Int, $pageSize: Int, $searchInstanceId: String, $selectedSearchFilters: [SelectedSearchFilterInput!]!, $sort: ListingSearchSortField) {
  srpSearch(page: $page, pageSize: $pageSize, searchInstanceId: $searchInstanceId, selectedSearchFilters: $selectedSearchFilters, sort: $sort) {
    metadata { totalListings totalPages }
    results {
      __typename
      ... on SrpListingGridCard {
        listingId
        analytics { context }
      }
    }
  }
}`;

function buildCarscomFilters(params) {
    const filters = [];
    filters.push({
        filter: 'area',
        zipCode: params.zip || '90210',
        radiusMiles: params.searchRadius || 50
    });
    if (params.condition === 'new') filters.push({ filter: 'stock_type', value: 'new' });
    else filters.push({ filter: 'stock_type', value: 'used' });
    if (params.make) filters.push({ filter: 'makes', values: [params.make.toLowerCase()] });
    if (params.make && params.model) {
        const modelSlug = `${params.make.toLowerCase()}-${params.model.toLowerCase().replace(/\s+/g, '_')}`;
        filters.push({ filter: 'models', values: [modelSlug] });
    }
    if (params.priceMax) filters.push({ filter: 'list_price_max', value: String(params.priceMax) });
    if (params.mileageMax) filters.push({ filter: 'mileage_max', value: String(params.mileageMax) });
    if (params.yearMin) filters.push({ filter: 'year_min', value: String(params.yearMin) });
    if (params.yearMax) filters.push({ filter: 'year_max', value: String(params.yearMax) });
    if (params.keyword) filters.push({ filter: 'keyword', value: params.keyword });
    // one_owner and no_accidents server-side filters are not sent: Cars.com returns a
    // near-empty ghost result (totalListings=0, context={}) when these are included,
    // which drops all real listings. We propagate the caller's intent into listing flags
    // (isOneOwner/noAccidents on lines below) so the output still reflects the request.
    if (params.personalUse) filters.push({ filter: 'personal_use', value: 'true' });
    if (params.dealRating) filters.push({ filter: 'deal_ratings', values: [params.dealRating] });
    if (params.bodyStyle) {
        const slug = mapBodyStyleCars(params.bodyStyle);
        if (slug) filters.push({ filter: 'body_style_slugs', values: [slug] });
    }
    if (params.fuelType) {
        const slug = mapFuelTypeCars(params.fuelType);
        if (slug) filters.push({ filter: 'fuel_type_slugs', values: [slug] });
    }
    return filters;
}

async function postCarscomGraphql(body, apiKey) {
    return fetchWithTimeout('https://graph.cars.com/graphql/api', {
        method: 'POST',
        headers: {
            'accept': 'application/graphql-response+json, application/json',
            'accept-language': 'en-US,en;q=0.9',
            'content-type': 'application/json',
            'origin': 'https://www.cars.com',
            'referer': 'https://www.cars.com/',
            'user-agent': UA,
            'x-api-key': apiKey,
            'x-cars-platform': 'cars_responsive',
            'x-cars-trip-id': '00000000-0000-0000-0000-' + Date.now().toString(16).padStart(12, '0')
        },
        body
    }, { timeoutMs: FETCH_TIMEOUT_MS, label: 'Cars.com' });
}

function isCarscomAuthFailure(status, text) {
    if (status === 401 || status === 403) return true;
    if (status === 200 && /missing api key|invalid api key/i.test(text)) return true;
    return false;
}

async function fetchCarscom(params, maxResults = 20) {
    const variables = {
        page: 1,
        pageSize: Math.min(Math.max(maxResults, 1), 50),
        searchInstanceId: 'aaaaaaaa-bbbb-cccc-dddd-' + Date.now().toString(16).padStart(12, '0'),
        selectedSearchFilters: buildCarscomFilters(params),
        sort: 'BEST_MATCH_DESC'
    };
    const body = JSON.stringify({
        operationName: 'SearchResultsPageSearch',
        query: CARSCOM_SRP_QUERY,
        variables
    });

    let apiKey = await module.exports.getCarscomApiKey();
    let res = await postCarscomGraphql(body, apiKey);
    let text = await res.text();

    if (isCarscomAuthFailure(res.status, text)) {
        apiKey = await module.exports.getCarscomApiKey({ refresh: true });
        res = await postCarscomGraphql(body, apiKey);
        text = await res.text();
    }

    if (res.status !== 200) throw new Error(`Cars.com HTTP ${res.status}: ${text.slice(0, 100)}`);

    let data;
    try { data = JSON.parse(text); } catch { throw new Error('Cars.com returned non-JSON'); }
    if (data.errors) throw new Error(`Cars.com GraphQL errors: ${JSON.stringify(data.errors).slice(0, 200)}`);

    const results = data.data?.srpSearch?.results || [];
    const candidates = [];
    for (const r of results) {
        if (r.__typename !== 'SrpListingGridCard') continue;
        let ctx = {};
        try { ctx = JSON.parse(r.analytics?.context || '{}'); } catch {}
        const title = [ctx.year, ctx.make, ctx.model, ctx.trim].filter(Boolean).join(' ') || null;
        const price = ctx.price ? `$${Number(ctx.price).toLocaleString()}` : null;
        const mileage = ctx.mileage ? `${Number(ctx.mileage).toLocaleString()} mi.` : null;
        const url = r.listingId ? `https://www.cars.com/vehicledetail/${r.listingId}/` : null;
        const sellerZip = ctx.seller?.zip || null;
        candidates.push({
            sellerZip,
            listing: new CarListing({
                title,
                price,
                mileage,
                dealRating: null,
                dealerName: null,
                location: sellerZip,
                url,
                source: 'Cars.com',
                // Cars.com's response doesn't expose per-listing CARFAX flags,
                // and we deliberately do NOT propagate request-level intent
                // here — that produced output claiming verification we
                // couldn't back up. The server-side filter still drops
                // non-matching rows when the user passes oneOwner/noAccidents.
                isOneOwner: false,
                noAccidents: false,
                personalUse: false,
                fuelType: normalizeFuelType(ctx.fuel_type)
            })
        });
    }

    // Cars.com's server-side `area` filter occasionally leaks listings far outside
    // the requested radius (observed 1000+ miles away on real queries). Post-filter
    // by haversine distance from params.zip. Fail-open: if either ZIP can't be
    // resolved, keep the listing rather than drop it.
    const radius = Number(params.searchRadius) || 50;
    const searchZip = String(params.zip || '').trim();
    const withDistance = await Promise.all(candidates.map(async c => {
        if (!searchZip || !c.sellerZip) return { keep: true, c };
        const d = await module.exports._zipDistance.distanceMiles(searchZip, c.sellerZip);
        if (d == null) return { keep: true, c }; // unresolvable — keep
        return { keep: d <= radius, c, d };
    }));

    const listings = [];
    for (const { keep, c } of withDistance) {
        if (!keep) continue;
        listings.push(c.listing);
        if (listings.length >= maxResults) break;
    }
    return listings;
}

// CarMax: GET /cars/api/search/run
// Filters are encoded in a `uri` path+query string (e.g. /cars/toyota/camry/suvs?price=30000).
// No auth required. Returns { totalCount, items: [...] }.
function buildCarmaxUri(params) {
    const segments = ['/cars'];
    const nk = (s) => String(s).toLowerCase().replace(/\s+/g, '-');
    if (params.make) segments.push(nk(params.make));
    if (params.make && params.model) segments.push(nk(params.model));
    const bodySlug = params.bodyStyle ? CARMAX_BODY_STYLE_SLUGS[normalizeKey(params.bodyStyle)] : null;
    if (bodySlug) segments.push(bodySlug);
    const engineSlug = params.fuelType ? CARMAX_ENGINE_SLUGS[normalizeKey(params.fuelType)] : null;
    if (engineSlug) segments.push(engineSlug);

    const uriQs = new URLSearchParams();
    if (params.priceMax) uriQs.set('price', String(params.priceMax));
    if (params.mileageMax) uriQs.set('mileage', `0-${params.mileageMax}`);
    if (params.yearMin || params.yearMax) {
        uriQs.set('year', `${params.yearMin || ''}${params.yearMin && params.yearMax ? '-' : ''}${params.yearMax || ''}`);
    }
    const uriPath = segments.join('/');
    return uriQs.toString() ? `${uriPath}?${uriQs.toString()}` : uriPath;
}

// Shared mapper: the API's `items[]` and the SRP HTML's embedded `cars[]`
// use identical field names, so the same function maps both shapes.
function mapCarmaxItem(item) {
    const title = [item.year, item.make, item.model, item.trim].filter(Boolean).join(' ') || null;
    const price = item.basePrice != null ? `$${Number(item.basePrice).toLocaleString()}` : null;
    const mileage = item.mileage != null ? `${Number(item.mileage).toLocaleString()} mi.` : null;
    const location = [item.storeCity, item.stateAbbreviation].filter(Boolean).join(', ') || null;
    const url = item.stockNumber ? `https://www.carmax.com/car/${item.stockNumber}` : null;
    const highlights = Array.isArray(item.highlights) ? item.highlights : [];
    // CarMax exposes `engineType` (e.g. "Electric", "Hybrid", "Plug-In Hybrid",
    // "Gas") plus a separate `fuelType`; either is fine for our gate.
    const rawFuel = item.engineType || item.fuelType;
    return new CarListing({
        title, price, mileage,
        dealerName: item.storeName || null,
        location,
        dealRating: null,
        url,
        source: 'CarMax',
        // CarMax's `highlights: ['singleOwner']` IS source-verified by their
        // own inspection; safe to surface. They don't expose a no-accidents
        // or personal-use equivalent — leave those false.
        isOneOwner: highlights.includes('singleOwner'),
        noAccidents: false,
        personalUse: false,
        fuelType: normalizeFuelType(rawFuel)
    });
}

async function fetchCarmax(params, maxResults = 20) {
    const uri = buildCarmaxUri(params);
    const qs = new URLSearchParams({
        uri,
        skip: '0',
        take: String(Math.min(Math.max(maxResults, 1), 100)),
        zipCode: params.zip || '90210',
        shipping: '-1',
        sort: 'bestmatch',
        includePopular: 'false'
    });
    const url = `https://www.carmax.com/cars/api/search/run?${qs.toString()}`;
    const res = await fetchWithTimeout(url, {
        headers: {
            'user-agent': UA,
            'accept': '*/*',
            'accept-language': 'en-US,en;q=0.9',
            'content-type': 'application/json',
            'referer': 'https://www.carmax.com/'
        }
    }, { timeoutMs: FETCH_TIMEOUT_MS, label: 'CarMax' });
    const text = await res.text();
    if (res.status !== 200) throw new Error(`CarMax HTTP ${res.status}`);
    let data;
    try { data = JSON.parse(text); } catch { throw new Error('CarMax returned non-JSON'); }
    const items = Array.isArray(data.items) ? data.items : [];
    return items.slice(0, maxResults).map(mapCarmaxItem);
}

// HTML fallback: parse the SRP page's embedded `const cars = [...]` JS array.
// CarMax server-renders the listing array as a global JS variable for SEO and
// for the SPA's first paint. Same field names as the API, so we reuse
// mapCarmaxItem. Page is *not* Cloudflare-gated (verified live 2026-05-22) —
// plain Node fetch works. Caps at 24 listings (CarMax page size); pagination
// via `?skip=` is ignored on the SRP, so this is single-page only — fine for
// fallback duty.
async function fetchCarmaxFromHtml(params, maxResults = 20) {
    const uri = buildCarmaxUri(params);
    // The SRP path/QS is the same `uri` string we send to the API, just used
    // as the actual page URL. Append zip + radius hints so the page filters
    // by store distance.
    const sep = uri.includes('?') ? '&' : '?';
    const url = `https://www.carmax.com${uri}${sep}zipCode=${encodeURIComponent(params.zip || '90210')}&distance=${params.searchRadius || 50}`;
    const res = await fetchWithTimeout(url, {
        headers: {
            'accept': 'text/html,application/xhtml+xml',
            'accept-language': 'en-US,en;q=0.9',
            'user-agent': UA
        }
    }, { timeoutMs: FETCH_TIMEOUT_MS, label: 'CarMax HTML' });
    if (res.status !== 200) throw new Error(`CarMax HTML HTTP ${res.status}`);
    const html = await res.text();
    // The embedded array literal is `const cars = [...];` inside a <script>.
    // Match lazily up to the closing `];` to avoid swallowing later script
    // tags. The body is JSON-compatible (CarMax serializes via JSON.stringify),
    // so JSON.parse works directly.
    const m = html.match(/const cars\s*=\s*(\[[\s\S]*?\]);/);
    if (!m) throw new Error('CarMax HTML missing embedded cars[]');
    let arr;
    try { arr = JSON.parse(m[1]); } catch (e) { throw new Error(`CarMax HTML cars[] parse failed: ${e.message}`); }
    if (!Array.isArray(arr)) throw new Error('CarMax HTML cars[] not an array');
    return arr.slice(0, maxResults).map(mapCarmaxItem);
}

// Carvana: POST /merch/search/api/v2/search
// No auth. Nationwide inventory (no radius filter). Returns { vehicles: [...] }.

// Carvana's parentModel filter is exact-match against whatever casing they
// chose to store, and the casing is inconsistent: title-case for word-models
// (`Camry`, `Corolla`, `4Runner`) and all-caps for stylized brands
// (`RAV4`, `IONIQ 5`, `EV6`). The typeahead at /v4/suggest accepts any case
// and returns the canonical `filters.makes[].parentModels[].name` directly,
// so we use it to normalize the user's free-text model.
const carvanaModelCache = new Map(); // `${makeLower}|${modelLower}` -> canonicalName | null

async function resolveCarvanaModelName(make, model) {
    if (!make || !model) return model || null;
    const cacheKey = `${String(make).toLowerCase()}|${String(model).toLowerCase()}`;
    if (carvanaModelCache.has(cacheKey)) return carvanaModelCache.get(cacheKey) || model;
    let canonical = null;
    try {
        const url = 'https://apik.carvana.io/merch/search/api/v4/suggest?query=' +
            encodeURIComponent(`${make} ${model}`);
        const res = await fetchWithTimeout(url, {
            headers: {
                'accept': 'application/json, text/plain, */*',
                'origin': 'https://www.carvana.com',
                'referer': 'https://www.carvana.com/',
                'user-agent': UA
            }
        }, { timeoutMs: FETCH_TIMEOUT_FAST_MS, label: 'Carvana suggest' });
        if (res.status === 200) {
            const data = JSON.parse(await res.text());
            const targetMake = String(make).toLowerCase();
            for (const sug of data.suggestions || []) {
                const makeEntry = (sug.filters?.makes || [])
                    .find(m => String(m.name || '').toLowerCase() === targetMake);
                const candidate = makeEntry?.parentModels?.[0]?.name;
                if (candidate) { canonical = candidate; break; }
            }
        }
    } catch (e) {
        console.error(`[apiClient] Carvana suggest probe failed for "${make} ${model}": ${e.message}`);
    }
    carvanaModelCache.set(cacheKey, canonical);
    return canonical || model;
}

async function buildCarvanaFilters(params) {
    const filters = {};
    if (params.priceMax) filters.price = { max: params.priceMax };
    if (params.yearMin) filters.year = { min: params.yearMin };
    if (params.mileageMax) filters.mileage = { max: params.mileageMax };
    if (params.bodyStyle) {
        const s = CARVANA_BODY_STYLES[normalizeKey(params.bodyStyle)];
        if (s) filters.bodyStyles = [s];
    }
    if (params.fuelType) {
        const f = CARVANA_FUEL_TYPES[normalizeKey(params.fuelType)];
        if (f) filters.fuelTypes = [f];
    }
    if (params.make) {
        const makeEntry = { name: params.make };
        if (params.model) {
            const canonical = await resolveCarvanaModelName(params.make, params.model);
            makeEntry.parentModels = [{ name: canonical }];
        }
        filters.makes = [makeEntry];
    }
    return filters;
}

async function fetchCarvana(params, maxResults = 20) {
    const cookieId = '00000000-0000-0000-0000-' + Date.now().toString(16).padStart(12, '0');
    const body = JSON.stringify({
        analyticsData: {
            browser: 'Chrome', clientId: 'srp_ui', deviceName: '',
            isBot: false, isFirstActiveSearchSession: true, isMobileDevice: false,
            previousSearchRequestId: '', referrer: 'https://www.carvana.com/',
            searchSessionId: cookieId, utmParams: {}
        },
        browserCookieId: cookieId,
        dealershipId: null,
        filters: await buildCarvanaFilters(params),
        pagination: { page: 1, pageSize: Math.min(Math.max(maxResults, 1), 100) },
        requestedFeatures: ['ExcludeFacetData', 'HideImpossibleCombos', 'LoanTermPricing'],
        sortBy: 'MostPopular',
        zip5: params.zip || '90210',
        preferredAcquisitionName: ''
    });

    const res = await fetchWithTimeout('https://apik.carvana.io/merch/search/api/v2/search', {
        method: 'POST',
        headers: {
            'accept': 'application/json, text/plain, */*',
            'accept-language': 'en-US,en;q=0.9',
            'content-type': 'application/json',
            'correlation-context': `browserCookieId=${cookieId}`,
            'origin': 'https://www.carvana.com',
            'referer': 'https://www.carvana.com/',
            'user-agent': UA,
            'x-cvna-sebs-srp': 'true'
        },
        body
    }, { timeoutMs: FETCH_TIMEOUT_MS, label: 'Carvana' });
    const text = await res.text();
    if (res.status !== 200) throw new Error(`Carvana HTTP ${res.status}`);
    let data;
    try { data = JSON.parse(text); } catch { throw new Error('Carvana returned non-JSON'); }
    const vehicles = Array.isArray(data.inventory?.vehicles) ? data.inventory.vehicles : [];
    return vehicles.slice(0, maxResults).map(v => {
        const title = [v.year, v.make, v.model, v.trim].filter(Boolean).join(' ') || null;
        const rawPrice = v.price?.total ?? v.price;
        const price = rawPrice != null ? `$${Number(rawPrice).toLocaleString()}` : null;
        const mileage = v.mileage != null ? `${Number(v.mileage).toLocaleString()} mi.` : null;
        // vehicleId is the numeric ID used in Carvana VDP URLs; vdpSlug is shared across same trim
        const url = v.vehicleId ? `https://www.carvana.com/vehicle/${v.vehicleId}` : null;
        const tags = Array.isArray(v.vehicleTags) ? v.vehicleTags : [];
        const isGreatDeal = tags.some(t => t.tagKey === 'KeepMovingPrice');
        return new CarListing({
            title, price, mileage,
            dealerName: 'Carvana',
            location: null,
            dealRating: isGreatDeal ? 'Great Deal' : null,
            url,
            source: 'Carvana',
            // Carvana inspects + reconditions every car but doesn't surface
            // CARFAX-equivalent flags in the API payload, so all three stay
            // false rather than implying verification we can't back up.
            isOneOwner: false,
            noAccidents: false,
            personalUse: false,
            fuelType: normalizeFuelType(v.fuelType)
        });
    });
}

module.exports = {
    fetchAutotrader,
    fetchKbb,
    fetchCarscom,
    fetchCarmax,
    fetchCarmaxFromHtml,
    fetchCarvana,
    getCarscomApiKey,
    AkamaiBlockError,
    isAkamaiBlock,
    // Re-exported via module.exports so tests can stub distanceMiles without
    // launching real HTTP calls. Same pattern as getCarscomApiKey.
    _zipDistance: zipDistance
};
