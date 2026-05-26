---
name: Feature request
about: Propose an enhancement to Car Deals Aggregator MCP
title: "[feature] "
labels: enhancement
assignees: ''
---

## Problem

<!-- What problem does this solve? Who's affected? -->

## Proposed solution

<!-- How should it work from the user's perspective? -->

## Alternatives considered

<!-- Other approaches you thought about and why you didn't pick them -->

## Scope

This project aggregates listings from public car-marketplace surfaces and
enriches them with cost estimates. Proposed features should fit within:

- ✅ New listing source (additional dealer aggregator with a public API)
- ✅ Better filtering / dedup / ranking across existing sources
- ✅ Better cost estimation (financing, taxes, fees, insurance)
- ✅ Reliability hardening (fallbacks, retries, schema-drift detection)
- ❌ Replacing the listing sources' canonical UIs
- ❌ Storing user PII or scraping logged-in account data
- ❌ Mass scraping / bulk download (the rate-limit posture is intentional)

If the request crosses those lines, propose it as a separate companion tool.
