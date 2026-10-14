# CLAUDE.md

This repository is a CommonJS, Node 22+ MCP server for searching car listings.
For detailed external API contracts, HAR-derived request shapes, parsing notes,
and anti-bot observations, see [docs/endpoint-research.md](docs/endpoint-research.md).
The source and offline tests are authoritative if older research conflicts.

## Commands

- `npm run test:unit` runs the full offline `node:test` suite. Use for CI and local iteration.
- `npm run lint` checks `src/` and `test/`.
- `node --test --test-name-pattern="<regex>" test/apiClient.test.js` runs focused tests.
- `npm start` starts the MCP server over stdio from `src/server.js`.
- `npm test` is a live Puppeteer Cars.com smoke test. It uses the network and must not run in CI.

## Result Presentation

Always show one full, plain `https://...` URL per listing row. Never hide it behind link text.

- Deduplicate only matching Autotrader/KBB listings by `listingId`, preferring Autotrader.
- Keep listings from all other sources separate, even when the same car appears on another source.
- The plain-terminal check: a reader must see the actual URL rather than only `Link`.
- Default searches include all six sources (`cars.com`, `autotrader`, `kbb`, `carmax`, `carvana`, `cargurus`) and use `maxResults >= 50`, unless the user requests otherwise.
- Hard constraints determine eligibility: explicit `searchRadius` excludes CarMax and Carvana; `driveType` excludes Cars.com and Carvana. Surface source-exclusion caveats.

## Architecture

The strategy is fetch-first with browser fallback only where the requested filters remain verifiable.

- `src/server.js` orchestrates Cars.com, Autotrader, KBB, CarMax, Carvana, and CarGurus searches.
- Cars.com, Autotrader, and KBB try their JSON clients first. A thrown transport, block, schema, or timeout error is required before Puppeteer fallback. A successful zero-result response must not trigger fallback.
- Cars.com suppresses HTML fallback for `fuelType`, `bodyStyle`, `keyword`, `personalUse`, explicit radius, `dealRating`, or `condition: 'new'`, because cards cannot verify those constraints.
- Autotrader/KBB use browser-context Cox JSON for structured filters; HTML cards are used only for other browser fallback queries. Browser JSON is not an independent recovery path for endpoint/schema failures.
- CarMax uses JSON first and its server-rendered HTML extraction only after a thrown JSON-client error. It has no Puppeteer fallback.
- Carvana is API-only.
- CarGurus is Puppeteer-only because plain Node fetch is DataDome-blocked.
- Deduplication applies only between Autotrader and KBB by `listingId`; Autotrader wins. Never deduplicate Cars.com, CarMax, Carvana, or CarGurus against other sources.
- Cox pagination treats exactly `{}` after a prior successful page as end-of-results; a first-page empty object or malformed response is a source error.

### Filter Honesty

| Filter | Cars.com | Autotrader | KBB | CarMax | Carvana | CarGurus |
|---|---|---|---|---|---|---|
| `oneOwner` | No | Yes | Yes | Yes (`singleOwner`) | No | No |
| `noAccidents` | No | Yes | Yes | No | No | No |
| `personalUse` | Yes | Yes | Yes | No | No | No |
| `driveType` | No | Yes | Yes | Yes | No | Yes |
| Explicit `searchRadius` | Yes | Yes | Yes | No | No | Yes |

- If a source cannot enforce a requested history, drivetrain, or explicit-radius constraint, skip it and report the caveat. Never return unverified rows or infer badges from caller intent, trim, or keywords.
- Cars.com `oneOwner` and `noAccidents` filters produce ghost zero-result responses. Do not send them; skip Cars.com when requested.
- Cars.com `personalUse` is server-filtered but lacks a per-listing verification field.
- Cox history is post-filtered from `vhrPreview`; server-side history parameters alone are not trustworthy.
- Cars.com radius results must be post-filtered with `src/zipDistance.js`. With explicit radius, drop listings without a verifiable seller ZIP; with implicit default radius, keep them.
- CarMax and Carvana remain eligible when no explicit radius is requested because their inventory is transferable or nationwide.

### Fuel and Costs

Mappers normalize listing `fuelType` to `electric`, `plug_in_hybrid`, `hybrid`, `gas`, `diesel`, `flex_fuel`, `hydrogen`, or `null`.

- Apply EV surcharge per listing only to electric or plug-in hybrid vehicles.
- If listing fuel type is absent, the request fuel-type hint may be used only with an explicit imprecision label.
- In parallel with search, calculate Zebra ZIP/demographic insurance, zip.tax sales tax when configured (TaxJar fallback), and static state EV/registration estimates.
- Sales tax is financed into the loan principal. Annual EV and registration estimates become monthly fees.
- Zebra and sales-tax failures degrade honestly: return listings without the unavailable estimate instead of failing search.
- Sales-tax sources report general retail tax, not guaranteed vehicle-specific tax. Registration is a coarse estimate; static fee data must be refreshed periodically.

## Tool Schema

`search_car_deals` requires only `zip`.

- Listing filters: `make`, `model`, `keyword`, `driveType`, `yearMin`, `yearMax`, `priceMax`, `mileageMax`, `searchRadius`, `condition`, `dealRating`, `oneOwner`, `noAccidents`, `personalUse`, `bodyStyle`, `fuelType`, `maxResults`, and `sources`.
- Valid `condition` values: `new`, `used`.
- Valid deal ratings: `great`, `good`, `fair`. `fair` is Cars.com-only; do not send unsupported Cox values.
- Valid body styles: `sedan`, `suv`, `truck`, `coupe`, `hatchback`, `convertible`, `wagon`, `minivan`, `van`.
- Valid fuel types: `gas`, `hybrid`, `ev`, `plugin_hybrid`, `diesel`.
- Cost inputs: `ageBucket`, `homeOwner`, `currentlyInsured`, `downPayment`, `loanTermMonths`, `apr`, and `includeEstimates`.
- Defaults: age bucket `45 to 54`, homeowner and currently insured true, 10% down, 60 months, and 7% APR.
- The tool description should ask shoppers for budget, ZIP, body style, and fuel preference when those requirements are unknown.

## Repository Map

- `src/server.js`: MCP stdio entrypoint, source orchestration, estimates, and output assembly. `main()` is guarded by `require.main === module`.
- `src/apiClient.js`: fetch clients for Cox, Cars.com, CarMax, and Carvana. Cars.com key acquisition is exposed for testing.
- `src/scraper.js`: Puppeteer and stealth scrapers, including Puppeteer-only CarGurus, and `CarListing`.
- `src/cargurusReference.js`: browser-page make/model ID lookup with in-memory caches.
- `src/insuranceClient.js`: Zebra request/median parsing.
- `src/feeClient.js`: zip.tax lookup when `ZIP_TAX_API_KEY` is set, TaxJar fallback, parsing, and ZIP cache.
- `src/feeData.js`: static state EV-surcharge and registration data. Keep its source links and verification date current.
- `src/loanCalculator.js`: pure loan, price parsing, and tax/fee calculation.
- `src/zipDistance.js`: Zippopotam.us geocoding cache and haversine distance calculation.
- `test/`: fully offline `node:test` suite. Mock all network calls.
- `mcp.json` and `server.json`: MCP marketplace metadata.
- `results/`: gitignored generated live-search output.

## Testing

- Add offline coverage for new parsing, filter, endpoint, or orchestration behavior.
- `test/apiClient.test.js` covers Cox pagination/post-filters, Cars.com filters and radius handling, and CarMax/Carvana request/response mapping.
- `test/server.test.js` covers source fallback semantics, source errors, exclusions, and orchestration.
- `test/cargurusReference.test.js` covers browser-page reference lookup and cache behavior without a live browser.
- `test/loanCalculator.test.js`, `test/insuranceClient.test.js`, `test/feeClient.test.js`, `test/feeData.test.js`, and `test/zipDistance.test.js` cover their isolated modules.
- Never make unit tests depend on live marketplace behavior. Run `npm run test:unit` after code changes.

## Conventions

- Use `require` and `module.exports`; preserve the stdio MCP protocol. Diagnostics belong on stderr, not stdout.
- Do not add unneeded fallback tiers, retries, or unused Cars.com GraphQL fields.
- Do not assume undocumented endpoint parameters or filters work. Verify live behavior, add offline coverage, then document the contract in `docs/endpoint-research.md`.
- HAR files may include sensitive material and must never be committed.
- Do not present insurance as vehicle-specific; Zebra is ZIP/demographic-only.
- Keep the Dependabot cooldown at seven days or more. CI uses `npm audit --omit=dev --audit-level=high`; address runtime high/critical findings without force-upgrading major versions unless necessary.

## Active Risks

1. Cars.com key acquisition has a cold-start listener race. Retry generally works; a response listener may harden it.
2. External endpoint and bot-protection contracts are undocumented and can drift. Preserve graceful error envelopes and estimate degradation.
3. Cars.com has no verifiable per-listing owner/accident data, and CarGurus history filtering remains unverified.
4. CarGurus location is lazily hydrated and can be null; its scraper has no pagination and only returns the first SRP page.
5. Body/fuel source mappings need live verification if they begin returning unexpected zero results.
6. State EV/registration tables can rot; general retail tax can differ from vehicle tax in some states.
