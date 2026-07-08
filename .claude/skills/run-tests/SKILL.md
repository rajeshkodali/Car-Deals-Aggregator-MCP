---
name: run-tests
description: Run this project's test suite the right way. Use when asked to run tests, verify a change, or iterate locally. Encodes the CLAUDE.md convention — npm run test:unit for CI/iteration, single-file node --test with an optional name pattern, and the hard rule that npm test (live Puppeteer against Cars.com) is NEVER run in CI and only run deliberately when checking real scraping behavior.
---

# Running tests for Car-Deals-Aggregator-MCP

## Default: the offline unit suite

```
npm run test:unit
```

Full `node:test` suite, fully offline (mocks `global.fetch`), ~230ms. This is
what CI runs and what you use for local iteration. It must stay green before any
commit. If it fails, fix the code or the test — never skip it.

## Scope to one file or one test

```
node --test test/apiClient.test.js
node --test test/apiClient.test.js --test-name-pattern="<regex>"
```

Use this while iterating on a single module (`apiClient`, `insuranceClient`,
`loanCalculator`, `feeClient`, `feeData`, `zipDistance`, or `server`
orchestration).

## Do NOT run in CI: the live smoke

```
npm test        # live Puppeteer smoke against Cars.com — hits the network, slow
```

Only run this deliberately, locally, when you specifically need to confirm real
scraping/browser behavior. It is not part of CI and must not be added to it.

## When you add code

Any new logic in `apiClient` / `insuranceClient` / `loanCalculator` / `server`
orchestration needs an offline test under `test/` (mock `global.fetch`; keep it
network-free). `server.js` tests prime `require.cache` with fakes **before**
loading `server.js` — the destructured imports capture references at load time,
so mutating fake exports after the require has no effect.
