#!/usr/bin/env node

/**
 * Car Deals MCP Server
 *
 * Searches Cars.com, Autotrader, and KBB. Tries direct JSON/GraphQL APIs first
 * (fast, structured) and falls back to Puppeteer scraping when blocked.
 */

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const {
    CallToolRequestSchema,
    ListToolsRequestSchema,
} = require('@modelcontextprotocol/sdk/types.js');

const { scrapeCarscom, scrapeAutotrader, scrapeKBB } = require('./scraper.js');
const { fetchAutotrader, fetchCarscom, fetchKbb, fetchCarmax, fetchCarmaxFromHtml, fetchCarvana } = require('./apiClient.js');
const { estimateInsurance } = require('./insuranceClient.js');
const { monthlyPayment, parsePrice, totalCostBreakdown } = require('./loanCalculator.js');
const { lookupSalesTax } = require('./feeClient.js');
const { evSurchargeAnnual, registrationEstimateAnnual } = require('./feeData.js');

const server = new Server(
    {
        name: 'car-deals-mcp',
        version: '2.0.0',
    },
    {
        capabilities: {
            tools: {},
        },
    }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
        tools: [
            {
                name: 'search_car_deals',
                description: 'Search car listings across Cars.com, Autotrader, and KBB. Only zip is required; all other filters optional. When the user is shopping for a car, ask them for: budget (priceMax), zip, body style (sedan/SUV/truck/etc), and fuel preference (gas/hybrid/EV). For monthly cost estimates, also collect age bracket and (optionally) loan terms. Returns listings with optional monthly payment + ZIP-area insurance estimate.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        zip: {
                            type: 'string',
                            description: 'ZIP code for location-based search',
                        },
                        make: {
                            type: 'string',
                            description: 'Optional. Car manufacturer (e.g., Toyota, Honda, Ford).',
                        },
                        model: {
                            type: 'string',
                            description: 'Optional. Car model (e.g., Camry, Civic, F-150).',
                        },
                        keyword: {
                            type: 'string',
                            description: 'Optional. Free-text keyword such as "hybrid", "AWD", "leather".',
                        },
                        yearMin: { type: 'integer', description: 'Optional. Minimum model year.' },
                        yearMax: { type: 'integer', description: 'Optional. Maximum model year.' },
                        priceMax: { type: 'integer', description: 'Optional. Maximum price in dollars.' },
                        mileageMax: { type: 'integer', description: 'Optional. Maximum mileage.' },
                        searchRadius: { type: 'integer', description: 'Optional. Search radius in miles (default 50).' },
                        condition: { type: 'string', enum: ['new', 'used'], description: 'Optional. New or used. Default: used.' },
                        dealRating: { type: 'string', enum: ['great', 'good', 'fair'], description: 'Optional. Filter by deal rating.' },
                        oneOwner: { type: 'boolean', description: 'Optional. CARFAX 1-Owner only.' },
                        noAccidents: { type: 'boolean', description: 'Optional. No reported accidents.' },
                        personalUse: { type: 'boolean', description: 'Optional. Personal use only (no rental/fleet).' },
                        maxResults: { type: 'integer', description: 'Optional. Max results per source (default 10).' },
                        sources: {
                            type: 'array',
                            items: { type: 'string' },
                            description: 'Optional. Sources to query: "cars.com", "autotrader", "kbb", "carmax", "carvana". Default: cars.com + autotrader.',
                        },
                        bodyStyle: {
                            type: 'string',
                            enum: ['sedan', 'suv', 'truck', 'coupe', 'hatchback', 'convertible', 'wagon', 'minivan', 'van'],
                            description: 'Optional. Vehicle body style. Ask the user up front if shopping by category.',
                        },
                        fuelType: {
                            type: 'string',
                            enum: ['gas', 'hybrid', 'ev', 'plugin_hybrid', 'diesel'],
                            description: 'Optional. Fuel/powertrain type. Ask the user (gas / hybrid / EV).',
                        },
                        ageBucket: {
                            type: 'string',
                            enum: ['Below 18', '18 to 24', '25 to 34', '35 to 44', '45 to 54', '55 to 64', 'above 65'],
                            description: 'Optional. Driver age bracket — used for the insurance estimate. If omitted, estimate falls back to a default bracket.',
                        },
                        homeOwner: { type: 'boolean', description: 'Optional. Whether the driver owns their home (affects insurance estimate). Default true.' },
                        currentlyInsured: { type: 'boolean', description: 'Optional. Whether the driver is currently insured (affects insurance estimate). Default true.' },
                        downPayment: { type: 'integer', description: 'Optional. Down payment in dollars for the monthly loan estimate. Default 10% of price.' },
                        loanTermMonths: { type: 'integer', description: 'Optional. Loan term in months. Default 60.' },
                        apr: { type: 'number', description: 'Optional. Annual percentage rate (e.g., 7 for 7%). Default 7.' },
                        includeEstimates: { type: 'boolean', description: 'Optional. If true, include monthly loan + insurance estimates in results. Default true.' },
                    },
                    required: ['zip'],
                },
            },
        ],
    };
});

// Fallback policy (post-2026-05-25 review):
// A clean 200 with zero listings is most often the user's filter, not a
// silent break. We do NOT trigger fallbacks on 0-result success — that
// just spends a Puppeteer launch (or extra HTTP round-trip) on a query
// the user phrased narrowly. Fallbacks fire only when the primary path
// THROWS, which is the contract every fetcher already follows for:
//   - HTTP non-200 (`X HTTP <status>`)
//   - Akamai/Cloudflare blocks (AkamaiBlockError)
//   - Schema mismatch (non-JSON, missing expected top-level field)
//   - Network / timeout (TimeoutError, native fetch errors)

async function searchCarscom(params, maxResults) {
    try {
        const listings = await fetchCarscom(params, maxResults);
        console.error(`[MCP] Cars.com fetch: ${listings.length} listings`);
        return { source: 'Cars.com', listings };
    } catch (err) {
        console.error(`[MCP] Cars.com fetch failed (${err.message}), falling back to Puppeteer`);
    }
    try {
        const listings = await scrapeCarscom(params, maxResults);
        return { source: 'Cars.com', listings };
    } catch (err) {
        return { source: 'Cars.com', listings: [], error: err.message };
    }
}

async function searchAutotrader(params, maxResults) {
    try {
        const listings = await fetchAutotrader(params, maxResults);
        console.error(`[MCP] Autotrader fetch: ${listings.length} listings`);
        return { source: 'Autotrader', listings };
    } catch (err) {
        console.error(`[MCP] Autotrader fetch failed (${err.message}), falling back to Puppeteer`);
    }
    try {
        const listings = await scrapeAutotrader(params, maxResults);
        return { source: 'Autotrader', listings };
    } catch (err) {
        return { source: 'Autotrader', listings: [], error: err.message };
    }
}

async function searchKBB(params, maxResults) {
    try {
        const listings = await fetchKbb(params, maxResults);
        console.error(`[MCP] KBB fetch: ${listings.length} listings`);
        return { source: 'KBB', listings };
    } catch (err) {
        console.error(`[MCP] KBB fetch failed (${err.message}), falling back to Puppeteer`);
    }
    try {
        const listings = await scrapeKBB(params, maxResults);
        return { source: 'KBB', listings };
    } catch (err) {
        return { source: 'KBB', listings: [], error: err.message };
    }
}

async function searchCarmax(params, maxResults) {
    try {
        const listings = await fetchCarmax(params, maxResults);
        console.error(`[MCP] CarMax fetch: ${listings.length} listings`);
        return { source: 'CarMax', listings };
    } catch (err) {
        console.error(`[MCP] CarMax fetch failed (${err.message}), trying HTML fallback`);
    }
    try {
        const listings = await fetchCarmaxFromHtml(params, maxResults);
        console.error(`[MCP] CarMax HTML fallback: ${listings.length} listings`);
        return { source: 'CarMax', listings };
    } catch (err) {
        console.error(`[MCP] CarMax HTML fallback failed (${err.message})`);
    }
    return { source: 'CarMax', listings: [] };
}

async function searchCarvana(params, maxResults) {
    try {
        const listings = await fetchCarvana(params, maxResults);
        if (listings.length > 0) {
            console.error(`[MCP] Carvana fetch: ${listings.length} listings`);
            return { source: 'Carvana', listings };
        }
        console.error('[MCP] Carvana fetch returned 0 listings');
    } catch (err) {
        console.error(`[MCP] Carvana fetch failed (${err.message})`);
    }
    return { source: 'Carvana', listings: [] };
}

// Exported for direct test invocation — wraps the same logic the MCP
// CallTool handler does, minus the `name`/`arguments` envelope. Returns
// the same { content: [...] } / { content, isError } shape.
async function handleSearchCarDeals(args = {}) {
    try {
        const params = {
            zip: args.zip,
            make: args.make,
            model: args.model,
            keyword: args.keyword,
            yearMin: args.yearMin,
            yearMax: args.yearMax,
            priceMax: args.priceMax,
            mileageMax: args.mileageMax,
            searchRadius: args.searchRadius,
            condition: args.condition || 'used',
            dealRating: args.dealRating,
            oneOwner: args.oneOwner,
            noAccidents: args.noAccidents,
            personalUse: args.personalUse,
            bodyStyle: args.bodyStyle,
            fuelType: args.fuelType,
        };
        const maxResults = args.maxResults || 10;
        const rawSources = (args.sources && args.sources.length) ? args.sources : ['cars.com', 'autotrader'];
        // Validate sources up front; surface unknowns rather than silently
        // dropping them. Comparison is case-insensitive on the canonical key.
        const KNOWN_SOURCES = new Set(['cars.com', 'autotrader', 'kbb', 'carmax', 'carvana']);
        const normalizedSources = [];
        const unknownSources = [];
        for (const s of rawSources) {
            const key = String(s || '').toLowerCase();
            if (KNOWN_SOURCES.has(key)) normalizedSources.push(key);
            else unknownSources.push(String(s));
        }
        const sources = normalizedSources;

        // Per-source CARFAX-filter capability table. true = the source can
        // honour the filter end-to-end (the fetcher actually wires it
        // through, server-side or via post-filter, with verifiable effect
        // on results). false = the source either has no per-listing data
        // we can trust, or the filter literally can't be sent without
        // breaking the response.
        //
        // Cars.com gotcha: sending `one_owner=true` or `no_accidents=true`
        // in the SearchResultsPageSearch GraphQL filters returns a ghost
        // result (totalListings=0, empty `analytics.context`), which drops
        // every real listing — see buildCarscomFilters() in apiClient.js.
        // So those two are NOT actually wired through for Cars.com, even
        // though the marketing-page UI exposes them. We mark them false
        // here so the server skips Cars.com when the user requires those
        // filters, rather than silently returning unfiltered rows.
        // `personalUse` IS sent and works.
        const SOURCE_CAPABILITIES = {
            'cars.com':   { oneOwner: false, noAccidents: false, personalUse: true  },
            'autotrader': { oneOwner: true,  noAccidents: true,  personalUse: true  },
            'kbb':        { oneOwner: true,  noAccidents: true,  personalUse: true  },
            'carmax':     { oneOwner: true,  noAccidents: false, personalUse: false },
            'carvana':    { oneOwner: false, noAccidents: false, personalUse: false }
        };
        // For each requested CARFAX filter, find sources that can't honour
        // it and record a skip reason. We exclude those sources from the
        // tasks list rather than returning unfiltered listings that look
        // filtered.
        const skippedBy = new Map(); // sourceKey -> [reasons]
        function recordSkip(sourceKey, reason) {
            if (!skippedBy.has(sourceKey)) skippedBy.set(sourceKey, []);
            skippedBy.get(sourceKey).push(reason);
        }
        const requestedFlags = ['oneOwner', 'noAccidents', 'personalUse'].filter(f => params[f]);
        const eligibleSources = sources.filter(s => {
            const caps = SOURCE_CAPABILITIES[s];
            for (const f of requestedFlags) {
                if (!caps[f]) {
                    recordSkip(s, `${f}=true not enforceable`);
                    return false;
                }
            }
            return true;
        });

        const includeEstimates = args.includeEstimates !== false;
        const loanOpts = {
            downPayment: args.downPayment,
            apr: args.apr ?? 7,
            termMonths: args.loanTermMonths ?? 60
        };
        const insuranceOpts = {
            zip: params.zip,
            ageBucket: args.ageBucket || '45 to 54',
            homeOwner: args.homeOwner !== false,
            currentlyInsured: args.currentlyInsured !== false
        };

        console.error(`[MCP] Searching zip=${params.zip} make=${params.make || '*'} model=${params.model || '*'} keyword=${params.keyword || '*'}`);
        console.error(`[MCP] Sources: ${eligibleSources.join(', ') || '(none eligible)'}, max per source: ${maxResults}`);
        if (skippedBy.size) {
            for (const [s, reasons] of skippedBy) {
                console.error(`[MCP] Skipping ${s}: ${reasons.join(', ')}`);
            }
        }
        if (unknownSources.length) {
            console.error(`[MCP] Unknown sources ignored: ${unknownSources.join(', ')}`);
        }

        const tasks = [];
        if (eligibleSources.includes('cars.com')) tasks.push(searchCarscom(params, maxResults));
        if (eligibleSources.includes('autotrader')) tasks.push(searchAutotrader(params, maxResults));
        if (eligibleSources.includes('kbb')) tasks.push(searchKBB(params, maxResults));
        if (eligibleSources.includes('carmax')) tasks.push(searchCarmax(params, maxResults));
        if (eligibleSources.includes('carvana')) tasks.push(searchCarvana(params, maxResults));

        const insurancePromise = includeEstimates
            ? estimateInsurance(insuranceOpts).catch(err => {
                console.error(`[MCP] Insurance estimate failed: ${err.message}`);
                return null;
            })
            : Promise.resolve(null);

        const taxPromise = includeEstimates
            ? lookupSalesTax(params.zip).catch(err => {
                console.error(`[MCP] Sales tax lookup failed: ${err.message}`);
                return null;
            })
            : Promise.resolve(null);

        const [results, insurance, tax] = await Promise.all([
            Promise.all(tasks), insurancePromise, taxPromise
        ]);

        // Request-level fuel hint is the fallback when a listing's source
        // didn't expose a per-listing fuel type. Per-listing fuel data is
        // preferred — see the listing-loop EV gate below.
        const requestIsElectric = params.fuelType === 'ev' || params.fuelType === 'electric'
            || params.fuelType === 'plugin_hybrid' || params.fuelType === 'plug_in_hybrid';
        function listingIsElectric(listing) {
            // Listings whose source surfaced a normalized fuelType drive
            // their own gate: only 'electric' / 'plug_in_hybrid' incur the
            // EV surcharge. Others don't, regardless of request-level intent.
            if (listing && listing.fuelType) {
                return listing.fuelType === 'electric' || listing.fuelType === 'plug_in_hybrid';
            }
            // Source missed fuelType → fall back to request-level intent.
            // This preserves the previous behavior for sources that don't
            // populate fuelType yet, and is documented in the listing
            // disclaimer so users understand the imprecision.
            return requestIsElectric;
        }
        const evAnnual = (tax && evSurchargeAnnual(tax.state)) || 0;
        const regAnnual = (tax && registrationEstimateAnnual(tax.state)) || 0;

        // Autotrader and KBB share the same Cox backend — identical listingIds appear
        // in both. Dedup only between those two: Autotrader wins, KBB dupe is dropped.
        // CarMax and Carvana have independent inventory and are never deduped.
        function coxListingId(url) {
            if (!url) return null;
            const m = url.match(/listingId=([^&]+)/);
            return m ? m[1] : null;
        }
        const coxSeen = new Set();
        const allListings = [];
        const errors = [];
        // Collect Autotrader first so its IDs are in the seen set before KBB runs.
        const COX_PRIORITY = ['Autotrader', 'KBB'];
        const resultsBySource = Object.fromEntries(results.map(r => [r.source, r]));
        const orderedResults = [
            ...COX_PRIORITY.map(s => resultsBySource[s]).filter(Boolean),
            ...results.filter(r => !COX_PRIORITY.includes(r.source))
        ];
        for (const r of orderedResults) {
            if (r.error) errors.push(`${r.source}: ${r.error}`);
            for (const listing of r.listings) {
                const id = coxListingId(listing.url);
                if (id) {
                    if (coxSeen.has(id)) continue; // KBB duplicate of an Autotrader listing
                    coxSeen.add(id);
                }
                allListings.push(listing);
            }
        }

        let output = `# Car Deals Search Results\n\n`;
        const searchBits = [];
        if (params.make) searchBits.push(params.make);
        if (params.model) searchBits.push(params.model);
        if (params.keyword) searchBits.push(`"${params.keyword}"`);
        output += `**Search:** ${searchBits.length ? searchBits.join(' ') : 'all listings'}`;
        if (params.yearMin || params.yearMax) {
            output += ` (${params.yearMin || 'any'}-${params.yearMax || 'any'})`;
        }
        if (params.priceMax) output += ` | Max Price: $${params.priceMax.toLocaleString()}`;
        if (params.mileageMax) output += ` | Max Mileage: ${params.mileageMax.toLocaleString()}`;
        if (params.dealRating) output += ` | Deal Rating: ${params.dealRating}`;
        if (params.bodyStyle) output += ` | Body: ${params.bodyStyle}`;
        if (params.fuelType) output += ` | Fuel: ${params.fuelType}`;

        const carfaxFilters = [];
        if (params.oneOwner) carfaxFilters.push('1-Owner');
        if (params.noAccidents) carfaxFilters.push('No Accidents');
        if (params.personalUse) carfaxFilters.push('Personal Use');
        if (carfaxFilters.length) output += `\n**CarFax Filters:** ${carfaxFilters.join(', ')}`;
        output += `\n**Location:** ${params.zip} (radius ${params.searchRadius || 50} mi)\n\n`;

        // Surface skipped sources and unknown sources up front so users
        // understand why a source they asked for isn't in the results.
        if (skippedBy.size) {
            output += `**Sources skipped due to filter requirements:**\n`;
            for (const [s, reasons] of skippedBy) {
                output += `- ${s}: ${reasons.join('; ')}\n`;
            }
            output += `\n`;
        }
        if (unknownSources.length) {
            output += `**Unknown sources ignored:** ${unknownSources.join(', ')}. `;
            output += `_Known sources: cars.com, autotrader, kbb, carmax, carvana._\n\n`;
        }

        if (insurance) {
            output += `**Estimated insurance (${insurance.zip}, ${insurance.ageBucket}):** ~$${insurance.medianMonthly.toFixed(0)}/mo `;
            output += `(median of ${insurance.carrierCount} carriers; range $${insurance.lowMonthly.toFixed(0)}–$${insurance.highMonthly.toFixed(0)}). `;
            output += `_ZIP- and demographic-based only — not vehicle-specific. Source: thezebra.com._\n\n`;
        }
        if (tax) {
            const pct = (tax.combinedRate * 100).toFixed(2);
            output += `**Sales tax (${tax.city || tax.zip}, ${tax.state}):** ${pct}% combined `;
            output += `(state ${(tax.stateRate*100).toFixed(2)}% + county ${(tax.countyRate*100).toFixed(2)}% + city ${(tax.cityRate*100).toFixed(2)}% + district ${(tax.districtRate*100).toFixed(2)}%). `;
            output += `_General retail rate; some states tax vehicles differently. Source: taxjar.com._\n`;
            const feeBits = [];
            // Header shows the EV surcharge once if the user filtered by EV/PHEV
            // *and* the state has one. Per-listing gating happens in the
            // listing loop below — this is just the human-readable hint.
            if (requestIsElectric && evAnnual) feeBits.push(`EV surcharge $${evAnnual}/yr`);
            if (regAnnual) feeBits.push(`registration ~$${regAnnual}/yr`);
            if (feeBits.length) {
                output += `**Annual fees (${tax.state}):** ${feeBits.join(', ')}. _Coarse state-level estimates._\n`;
            }
            output += `\n`;
        }

        if (allListings.length === 0) {
            output += `No listings found.\n`;
        } else {
            output += `Found **${allListings.length}** listings:\n\n`;
            for (const listing of allListings) {
                let block = listing.format();
                if (includeEstimates) {
                    const price = parsePrice(listing.price);
                    const isElectricListing = listingIsElectric(listing);
                    const breakdown = price != null ? totalCostBreakdown({
                        price,
                        downPayment: loanOpts.downPayment,
                        apr: loanOpts.apr,
                        termMonths: loanOpts.termMonths,
                        salesTaxRate: tax ? tax.combinedRate : 0,
                        evSurchargeAnnual: evAnnual,
                        registrationAnnual: regAnnual,
                        isElectric: isElectricListing
                    }) : null;
                    if (breakdown) {
                        const ins = insurance ? insurance.medianMonthly : null;
                        const parts = [`~$${Math.round(breakdown.loanMonthly)} loan`];
                        if (ins != null) parts.push(`~$${Math.round(ins)} insurance`);
                        if (breakdown.monthlyFees > 0) parts.push(`~$${Math.round(breakdown.monthlyFees)} fees`);
                        const total = breakdown.loanMonthly + (ins || 0) + breakdown.monthlyFees;
                        block += `\n  Est. monthly: ${parts.join(' + ')} = ~$${Math.round(total)}/mo`;
                        const dpDesc = loanOpts.downPayment != null
                            ? '$' + loanOpts.downPayment.toLocaleString()
                            : '10%';
                        block += ` _(${loanOpts.termMonths}mo @ ${loanOpts.apr}% APR, ${dpDesc} down`;
                        if (tax) block += `, ${(tax.combinedRate*100).toFixed(2)}% tax financed`;
                        block += `)_`;
                    }
                }
                output += block + '\n\n---\n\n';
            }
        }

        if (errors.length) {
            output += `\n**Errors:**\n`;
            for (const err of errors) output += `- ${err}\n`;
        }

        return { content: [{ type: 'text', text: output }] };
    } catch (error) {
        return {
            content: [{ type: 'text', text: `Error searching for car deals: ${error.message}` }],
            isError: true,
        };
    }
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    if (name !== 'search_car_deals') throw new Error(`Unknown tool: ${name}`);
    return handleSearchCarDeals(args);
});

async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error('Car Deals MCP Server running on stdio');
}

if (require.main === module) {
    main().catch(console.error);
}

module.exports = {
    searchCarscom, searchAutotrader, searchKBB, searchCarmax, searchCarvana,
    handleSearchCarDeals
};
