const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

// CarListing now lives in its own module so apiClient.js doesn't have to
// transitively import puppeteer/stealth just to construct a listing object.
// Re-exported below for any callers that still `require('./scraper.js').CarListing`.
const { CarListing } = require('./carListing.js');
const cargurusReference = require('./cargurusReference.js');
// Pulled from apiClient.js so CarGurus shares the same fuel/drivetrain
// vocabulary as every other source instead of duplicating the mapping.
// apiClient.js itself has no puppeteer dependency, so this doesn't pull
// puppeteer in anywhere it wasn't already.
const { normalizeFuelType, normalizeDriveType } = require('./apiClient.js');
const { parsePrice } = require('./loanCalculator.js');

function parseMileageStr(s) {
    if (!s) return null;
    const digits = String(s).replace(/[^\d]/g, '');
    return digits ? Number(digits) : null;
}

/**
 * Launch browser with stealth settings.
 *
 * Hardening notes:
 *   - We deliberately do NOT pass --no-sandbox / --disable-setuid-sandbox.
 *     The scraper loads untrusted third-party SRP pages (Cars.com,
 *     Autotrader, KBB) and disabling Chromium's process sandbox is a
 *     direct path from a renderer compromise to host code execution.
 *   - We do NOT pass --disable-web-security or
 *     --disable-features=IsolateOrigins,site-per-process — those weaken
 *     same-origin isolation and were only ever there to paper over CI
 *     environments where the sandbox couldn't initialize. CI here is
 *     offline (`npm run test:unit`) and never launches Puppeteer.
 *   - If a specific environment legitimately needs a relaxed launch,
 *     do it via env var on a per-deployment basis, not in committed code.
 */
async function launchBrowser() {
    return puppeteer.launch({ headless: 'new' });
}

/**
 * Scrape Cars.com for car listings
 */
async function scrapeCarscom(params, maxResults = 20) {
    const listings = [];
    let browser;

    try {
        browser = await launchBrowser();
        const page = await browser.newPage();
        await page.setViewport({ width: 1920, height: 1080 });

        // Build URL
        let url = 'https://www.cars.com/shopping/results/?';
        const urlParams = new URLSearchParams();
        urlParams.append('stock_type', 'used');
        if (params.make) urlParams.append('makes[]', params.make.toLowerCase());
        // Cars.com's models[] slug requires both the make AND model — passing
        // model alone produces a 400, and earlier code crashed on
        // `params.make.toLowerCase()` when make was undefined.
        if (params.make && params.model) urlParams.append('models[]', `${params.make.toLowerCase()}-${params.model.toLowerCase()}`);
        if (params.zip) urlParams.append('zip', params.zip);
        if (params.yearMin) urlParams.append('year_min', params.yearMin);
        if (params.yearMax) urlParams.append('year_max', params.yearMax);
        if (params.priceMax) urlParams.append('list_price_max', params.priceMax);
        if (params.mileageMax) urlParams.append('mileage_max', params.mileageMax);

        // CarFax history filters
        if (params.oneOwner) urlParams.append('one_owner', 'true');
        if (params.noAccidents) urlParams.append('no_accidents', 'true');
        if (params.personalUse) urlParams.append('personal_use', 'true');

        url += urlParams.toString();

        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await new Promise(r => setTimeout(r, 5000));

        // Extract listings from .vehicle-card elements
        const rawListings = await page.evaluate(() => {
            const results = [];
            const cards = document.querySelectorAll('.vehicle-card');

            cards.forEach(card => {
                const text = card.innerText;
                const lines = text.split('\n').filter(l => l.trim());

                let title = null;
                let price = null;
                let mileage = null;
                let dealRating = null;
                let dealerName = null;
                let location = null;

                for (const line of lines) {
                    const trimmed = line.trim();

                    // Title: Year Make Model (e.g., "2020 Toyota Camry XSE")
                    if (/^(19|20)\d{2}\s+\w+/.test(trimmed) && !title) {
                        title = trimmed;
                        continue;
                    }

                    // Price: "$XX,XXX" (may have "price drop" suffix)
                    const priceMatch = trimmed.match(/^\$[\d,]+/);
                    if (priceMatch && !price) {
                        price = priceMatch[0];
                        continue;
                    }

                    // Mileage: "XX,XXX mi."
                    if (/^[\d,]+\s*mi\.?$/i.test(trimmed) && !mileage) {
                        mileage = trimmed;
                        continue;
                    }

                    // Deal rating: "Good Deal", "Great Deal", etc.
                    if (/^(great|good|fair|high|no price)/i.test(trimmed) && !dealRating) {
                        dealRating = trimmed.split('|')[0].trim();
                        continue;
                    }

                    // Location: "City, ST (XX mi.)"
                    if (/^[A-Z][a-z]+.*,\s*[A-Z]{2}\s*\(/i.test(trimmed) && !location) {
                        location = trimmed;
                        continue;
                    }
                }

                // Get dealer name - usually after reviews count
                const dealerMatch = card.querySelector('.dealer-name');
                if (dealerMatch) {
                    dealerName = dealerMatch.innerText.trim();
                } else {
                    // Fallback: look for line before reviews
                    for (let i = 0; i < lines.length; i++) {
                        if (lines[i].includes('reviews') && i > 0) {
                            dealerName = lines[i - 1].trim();
                            break;
                        }
                    }
                }

                // Get URL from the card link
                const linkEl = card.querySelector('a.vehicle-card-link');
                const href = linkEl ? linkEl.getAttribute('href') : null;

                // Check for CarFax badges
                const fullText = text.toLowerCase();
                const isOneOwner = fullText.includes('1-owner') || fullText.includes('one owner');
                const noAccidents = fullText.includes('no accident') || fullText.includes('clean');
                const personalUse = fullText.includes('personal use');

                if (title) {
                    results.push({ title, price, mileage, dealRating, dealerName, location, href, isOneOwner, noAccidents, personalUse });
                }
            });

            return results;
        });

        for (const item of rawListings.slice(0, maxResults)) {
            listings.push(new CarListing({
                title: item.title,
                price: item.price,
                mileage: item.mileage,
                dealerName: item.dealerName,
                dealRating: item.dealRating,
                url: item.href ? `https://www.cars.com${item.href}` : null,
                source: 'Cars.com',
                isOneOwner: item.isOneOwner,
                noAccidents: item.noAccidents,
                personalUse: item.personalUse
            }));
        }

        await browser.close();
    } catch (err) {
        if (browser) await browser.close();
        throw new Error(`Cars.com scraping failed: ${err.message}`);
    }

    return listings;
}

/**
 * Scrape Autotrader for car listings
 */
async function scrapeAutotrader(params, maxResults = 20) {
    const listings = [];
    let browser;

    try {
        browser = await launchBrowser();
        const page = await browser.newPage();
        await page.setViewport({ width: 1920, height: 1080 });

        // Build URL
        const make = params.make ? params.make.toLowerCase() : '';
        const model = params.model ? params.model.toLowerCase() : '';
        const zip = params.zip || '90210';

        let url = `https://www.autotrader.com/cars-for-sale/all-cars`;
        if (make) url += `/${make}`;
        if (model) url += `/${model}`;
        url += `/beverly-hills-ca-${zip}`;

        // Add query params
        const urlParams = new URLSearchParams();
        if (params.yearMin) urlParams.append('startYear', params.yearMin);
        if (params.yearMax) urlParams.append('endYear', params.yearMax);
        if (params.priceMax) urlParams.append('maxPrice', params.priceMax);
        if (params.mileageMax) urlParams.append('maxMileage', params.mileageMax);

        if (urlParams.toString()) {
            url += '?' + urlParams.toString();
        }

        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await new Promise(r => setTimeout(r, 5000));

        // Extract listings
        const rawListings = await page.evaluate(() => {
            const results = [];

            // Autotrader uses various selectors for listings
            const cards = document.querySelectorAll('[data-cmp="inventoryListing"], .inventory-listing');

            cards.forEach(card => {
                const titleEl = card.querySelector('h2, .text-bold');
                const priceEl = card.querySelector('[data-cmp="firstPrice"], .first-price');
                const mileageEl = card.querySelector('.text-subdued-lighter');
                const dealerEl = card.querySelector('.dealer-name, .text-subdued');
                const linkEl = card.querySelector('a[href*="/cars-for-sale/"]');

                const title = titleEl ? titleEl.innerText.trim() : null;
                const price = priceEl ? priceEl.innerText.trim() : null;

                // Get mileage from text
                let mileage = null;
                if (mileageEl) {
                    const text = mileageEl.innerText;
                    const match = text.match(/([\d,]+)\s*miles?/i);
                    if (match) mileage = match[0];
                }

                if (title) {
                    results.push({
                        title,
                        price,
                        mileage,
                        dealerName: dealerEl ? dealerEl.innerText.trim() : null,
                        href: linkEl ? linkEl.getAttribute('href') : null
                    });
                }
            });

            return results;
        });

        for (const item of rawListings.slice(0, maxResults)) {
            listings.push(new CarListing({
                title: item.title,
                price: item.price,
                mileage: item.mileage,
                dealerName: item.dealerName,
                url: item.href ? `https://www.autotrader.com${item.href}` : null,
                source: 'Autotrader'
            }));
        }

        await browser.close();
    } catch (err) {
        if (browser) await browser.close();
        throw new Error(`Autotrader scraping failed: ${err.message}`);
    }

    return listings;
}

/**
 * Scrape KBB for car listings
 */
async function scrapeKBB(params, maxResults = 20) {
    const listings = [];
    let browser;

    try {
        browser = await launchBrowser();
        const page = await browser.newPage();
        await page.setViewport({ width: 1920, height: 1080 });

        // Build URL
        const make = params.make ? params.make.toLowerCase() : '';
        const model = params.model ? params.model.toLowerCase() : '';
        const zip = params.zip || '90210';

        let url = `https://www.kbb.com/cars-for-sale/all`;
        if (make) url += `/${make}`;
        if (model) url += `/${model}`;
        url += `/?zip=${zip}`;

        // Add filters
        if (params.yearMin) url += `&startYear=${params.yearMin}`;
        if (params.yearMax) url += `&endYear=${params.yearMax}`;
        if (params.priceMax) url += `&maxPrice=${params.priceMax}`;
        if (params.mileageMax) url += `&maxMileage=${params.mileageMax}`;

        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await new Promise(r => setTimeout(r, 5000));

        // Extract listings - KBB uses inventoryListing data-cmp
        const rawListings = await page.evaluate(() => {
            const results = [];

            const cards = document.querySelectorAll('[data-cmp="inventoryListing"]');

            cards.forEach(card => {
                const text = card.innerText;
                if (!text || text.length < 20) return;

                const lines = text.split('\n').filter(l => l.trim());

                let title = null;
                let trim = null;
                let price = null;
                let mileage = null;
                let dealRating = null;

                for (const line of lines) {
                    const trimmed = line.trim();

                    // Title: Year Make Model
                    if (/^(19|20)\d{2}\s+\w+/.test(trimmed) && !title) {
                        title = trimmed;
                        continue;
                    }

                    // Trim (usually follows title, like "XSE" or "LE")
                    if (title && !trim && /^[A-Z]{1,4}$/.test(trimmed)) {
                        trim = trimmed;
                        continue;
                    }

                    // Price: "$XX,XXX" or just "XX,XXX" (KBB sometimes omits $)
                    const priceMatch = trimmed.match(/^\$?([\d,]+)$/);
                    if (priceMatch && !price && parseInt(priceMatch[1].replace(/,/g, '')) > 1000) {
                        price = trimmed.startsWith('$') ? trimmed : `$${trimmed}`;
                        continue;
                    }

                    // Mileage: "XXK mi" or "XX,XXX mi"
                    if (/^\d+K?\s*mi$/i.test(trimmed) && !mileage) {
                        mileage = trimmed;
                        continue;
                    }

                    // Deal rating: "Good Price", "Great Price", "Fair Price"
                    if (/^(good|great|fair|high)\s*(price|deal)/i.test(trimmed) && !dealRating) {
                        dealRating = trimmed;
                        continue;
                    }
                }

                if (title) {
                    if (trim) title = `${title} ${trim}`;
                    results.push({ title, price, mileage, dealRating });
                }
            });

            return results;
        });

        for (const item of rawListings.slice(0, maxResults)) {
            listings.push(new CarListing({
                title: item.title,
                price: item.price,
                mileage: item.mileage,
                dealRating: item.dealRating,
                source: 'KBB'
            }));
        }

        await browser.close();
    } catch (err) {
        if (browser) await browser.close();
        throw new Error(`KBB scraping failed: ${err.message}`);
    }

    return listings;
}

/**
 * Scrape CarGurus for car listings.
 *
 * Puppeteer-only — there is no fetch tier for this source, unlike
 * Cars.com/Autotrader/KBB above (fetch-first, Puppeteer-on-error). CarGurus
 * runs DataDome bot protection: plain Node `fetch` gets HTTP 406 on every
 * endpoint tested, even with headers copied verbatim from a real captured
 * browser session (verified 2026-09-04 against a live HAR). Puppeteer +
 * stealth gets through cleanly. Architecturally this is single-tier like
 * Carvana (API-only) — just Puppeteer instead of fetch.
 *
 * The upside of needing Puppeteer: CarGurus's search-results page is a
 * cookie-less, auth-free Remix-SSR page that embeds real listing data
 * directly as structured markup — each card
 * (`[data-testid="srp-listing-tile"]`) contains a `<dl>` of dt/dd pairs
 * (Year, Make, Model, Drivetrain, Fuel type, Mileage, VIN, ...). That's
 * real per-listing data, not free text we have to regex apart like the
 * Cars.com/Autotrader/KBB scrapers above.
 *
 * Known limitations (documented rather than silently wrong):
 *   - No per-listing CARFAX-equivalent field on the SRP tile (no
 *     owner-history/accident data), so isOneOwner/noAccidents/personalUse
 *     stay false — same posture as Carvana. See SOURCE_CAPABILITIES in
 *     server.js.
 *   - Single SRP page only (~20-24 tiles); no pagination. Fine for a
 *     comparison source, same posture as CarMax's HTML fallback.
 *   - Dealer name is only present on sponsored tiles (a dealer logo image
 *     with the dealer's name as `alt`); non-sponsored tiles don't expose
 *     dealer name on the SRP at all.
 *   - When a listing is nationwide-shippable, CarGurus's location line
 *     shows "Price includes $X shipping" instead of a distance. We surface
 *     that as-is in `location` — it's the real per-listing figure.
 *   - make/model, priceMax, and mileageMax are enforced (make/model via
 *     resolveMakeModel + a post-filter on the tile's own Make/Model fields;
 *     price/mileage via a post-filter on the tile's price/mileage text,
 *     since the CarGurus search URL's real query-param names for those
 *     aren't verified). `condition`, `bodyStyle`, `fuelType`, `dealRating`,
 *     and `keyword` are NOT wired through at all for this source yet — same
 *     "documented gap" posture as e.g. dealRating=fair on Autotrader/KBB.
 */
async function scrapeCarGurus(params, maxResults = 20) {
    const listings = [];
    let browser;

    try {
        browser = await launchBrowser();
        const page = await browser.newPage();
        await page.setViewport({ width: 1920, height: 1080 });

        const { makeId, modelId } = await cargurusReference.resolveMakeModel(page, params.make, params.model);

        const qs = new URLSearchParams();
        if (makeId && modelId) qs.set('makeModelTrimPaths', `${makeId}/${modelId}`);
        else if (makeId) qs.set('makeModelTrimPaths', makeId);
        qs.set('zip', params.zip || '90210');
        qs.set('distance', String(params.searchRadius || 50));
        qs.set('sortType', 'PRICE');
        qs.set('sortDirection', 'ASC');
        if (params.yearMin) qs.set('startYear', String(params.yearMin));
        if (params.yearMax) qs.set('endYear', String(params.yearMax));

        const url = `https://www.cargurus.com/search?${qs.toString()}`;
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        // The location section (city/distance or shipping-fee text) hydrates
        // asynchronously after the tiles themselves paint — a flat sleep here
        // races it and intermittently ships `location: null` on every tile
        // (verified live 2026-09-04: ~50% of runs). Wait for the first tile's
        // location section to actually populate; on timeout proceed anyway
        // rather than fail the whole scrape (fail-open, same posture as the
        // ZIP-distance lookups elsewhere in this codebase).
        try {
            await page.waitForFunction(() => {
                const tiles = document.querySelectorAll('[data-testid="srp-listing-tile"]');
                return tiles.length > 0 && !!tiles[0].querySelector('[data-testid="LocationSection-firstLine"]');
            }, { timeout: 8000 });
        } catch {
            // Hydration didn't finish in time — some tiles may still render
            // with a null location. Non-fatal.
        }

        const rawListings = await page.evaluate(() => {
            const results = [];
            const tiles = document.querySelectorAll('[data-testid="srp-listing-tile"]');

            tiles.forEach(tile => {
                const link = tile.querySelector('a[data-testid="tile-link"]');
                if (!link) return;

                const props = {};
                link.querySelectorAll('dl > dt').forEach(dt => {
                    const key = dt.textContent.replace(':', '').trim();
                    const dd = dt.nextElementSibling;
                    if (dd) props[key] = dd.textContent.trim();
                });

                const trimEl = tile.querySelector('[data-cg-ft="vehicle"]');
                const priceEl = tile.querySelector('[data-testid="srp-tile-price"]');
                const dealRatingEl = tile.querySelector('[data-testid="srp-tile-deal-rating"]');
                const locFirst = tile.querySelector('[data-testid="LocationSection-firstLine"]');
                const locSecond = tile.querySelector('[data-testid="LocationSection-secondLine"]');
                const dealerLogo = tile.querySelector('img[class*="_dealerLogoSized"]');

                results.push({
                    year: props['Year'] || null,
                    make: props['Make'] || null,
                    model: props['Model'] || null,
                    trim: trimEl ? (trimEl.getAttribute('title') || trimEl.textContent.trim()) : null,
                    driveTrain: props['Drivetrain'] || null,
                    fuelType: props['Fuel type'] || null,
                    mileage: props['Mileage'] || null,
                    price: priceEl ? priceEl.textContent.trim() : null,
                    dealRating: dealRatingEl ? dealRatingEl.textContent.trim() : null,
                    locationCity: locFirst ? locFirst.textContent.trim() : null,
                    locationDetail: locSecond ? locSecond.textContent.trim() : null,
                    dealerName: dealerLogo ? dealerLogo.getAttribute('alt') : null,
                    href: link.getAttribute('href')
                });
            });

            return results;
        });

        // resolveMakeModel silently broadens the query on a lookup miss —
        // e.g. an unresolved model falls back to a make-only search, and an
        // unresolved make falls back to no makeModelTrimPaths at all (see
        // its own header comment). Post-filter on the tile's own Make/Model
        // fields (real per-listing data, not inferred) so a caller-specified
        // make/model that CarGurus's ID index doesn't recognize can't return
        // unrelated vehicles. Same normalize() used to build that index, so
        // spacing/hyphen/case variants (e.g. "Ioniq 5" vs "Ioniq5") still match.
        const wantMake = params.make ? cargurusReference.normalize(params.make) : null;
        const wantModel = params.model ? cargurusReference.normalize(params.model) : null;
        const filtered = rawListings.filter(item => {
            if (wantMake && cargurusReference.normalize(item.make) !== wantMake) return false;
            if (wantModel && cargurusReference.normalize(item.model) !== wantModel) return false;
            // priceMax/mileageMax aren't wired into the CarGurus search URL
            // (unverified param names) — post-filter on the tile's own
            // price/mileage text instead of returning them unfiltered.
            if (params.priceMax) {
                const price = parsePrice(item.price);
                if (price != null && price > params.priceMax) return false;
            }
            if (params.mileageMax) {
                const mileage = parseMileageStr(item.mileage);
                if (mileage != null && mileage > params.mileageMax) return false;
            }
            return true;
        });

        for (const item of filtered.slice(0, maxResults)) {
            const title = [item.year, item.make, item.model, item.trim].filter(Boolean).join(' ') || null;
            const location = [item.locationCity, item.locationDetail].filter(Boolean).join(' — ') || null;
            listings.push(new CarListing({
                title,
                price: item.price,
                mileage: item.mileage,
                dealerName: item.dealerName,
                location,
                dealRating: item.dealRating,
                // Drop the tracking query string (resultSetId/searchUuid/srpc/...)
                // — the bare /details/{id} path is the canonical VDP URL, same
                // convention as Autotrader's reconstructed listingId URL.
                url: item.href ? `https://www.cargurus.com${item.href.split('?')[0]}` : null,
                source: 'CarGurus',
                isOneOwner: false,
                noAccidents: false,
                personalUse: false,
                fuelType: normalizeFuelType(item.fuelType),
                driveType: normalizeDriveType(item.driveTrain)
            }));
        }

        await browser.close();
    } catch (err) {
        if (browser) await browser.close();
        throw new Error(`CarGurus scraping failed: ${err.message}`);
    }

    return listings;
}

/**
 * Search all sources and combine results
 */
async function searchAllSources(params, maxResultsPerSource = 10) {
    const results = {
        listings: [],
        errors: []
    };

    // Run scrapers in parallel
    const scrapers = [
        { name: 'Cars.com', fn: () => scrapeCarscom(params, maxResultsPerSource) },
        { name: 'Autotrader', fn: () => scrapeAutotrader(params, maxResultsPerSource) },
        { name: 'KBB', fn: () => scrapeKBB(params, maxResultsPerSource) }
    ];

    const promises = scrapers.map(async scraper => {
        try {
            const listings = await scraper.fn();
            return { name: scraper.name, listings, error: null };
        } catch (err) {
            return { name: scraper.name, listings: [], error: err.message };
        }
    });

    const outcomes = await Promise.all(promises);

    for (const outcome of outcomes) {
        results.listings.push(...outcome.listings);
        if (outcome.error) {
            results.errors.push({ source: outcome.name, error: outcome.error });
        }
    }

    return results;
}

module.exports = {
    CarListing,
    scrapeCarscom,
    scrapeAutotrader,
    scrapeKBB,
    scrapeCarGurus,
    searchAllSources
};
