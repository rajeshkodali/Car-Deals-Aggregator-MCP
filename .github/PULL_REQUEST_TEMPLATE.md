<!-- One-line summary of what this PR does -->

## Summary

<!-- 1-3 bullet points covering motivation + change shape -->

-

## Type

- [ ] Bug fix (non-breaking change which fixes an issue)
- [ ] New feature (non-breaking change which adds functionality)
- [ ] Breaking change (fix or feature that would cause existing usage to change)
- [ ] Docs / chore / refactor (no behavior change)

## Test plan

<!-- How did you verify this? Include the commands you ran. -->

- [ ] `npm run test:unit` passes locally
- [ ] `node --check` passes for any new/changed `*.js` files
- [ ] Live end-to-end run if listing/extraction logic changed (paste a snippet of output)

## Reviewer checklist

- [ ] No HARs, `.env` files, or other captures committed (`*.har` is gitignored)
- [ ] No real seller/dealer PII, VINs, or ZIP codes in committed test fixtures
- [ ] CLAUDE.md updated when an external API endpoint, schema, or anti-bot
      behavior changes (this is the canonical reference for future Claude runs)
- [ ] New `fetch` calls don't include cookies, auth tokens, or session IDs
      from a personal browser
