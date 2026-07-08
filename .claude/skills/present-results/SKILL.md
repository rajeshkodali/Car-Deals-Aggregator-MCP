---
name: present-results
description: Format car-listing search results for the user. Use whenever you render listings from search_car_deals into a table or summary. Enforces the CLAUDE.md "Presenting Results" rules — full plain https URLs visible in every row (never hidden behind link text), one URL per car with source precedence, and the plain-terminal sanity check.
---

# Presenting car-listing results

**Always show full, plain URLs in the table — never hidden behind link text.**

## Rules

1. **Raw URL in every row.** Each listing row must show the full `https://...`
   URL visible in the table cell. NOT `[Link](url)`, NOT a footnote, NOT a
   numbered list of links below the table. The literal URL text goes in the cell.

2. **One URL per car.** If the same listing appears on multiple sources, pick
   exactly one using this precedence: **Cars.com > Autotrader > KBB**. Never
   emit two rows for the same car and never show two links for one car.
   (Cars.com, CarMax, and Carvana have independent inventory and aren't deduped
   against each other — only Autotrader ↔ KBB collapse.)

3. **Sanity check before you send.** Imagine the output in a plain monospace
   terminal with no hyperlink rendering. If the user would see only the word
   "Link" instead of a real `https://...`, you've done it wrong — fix it.

## Also surface

- The per-listing total cost (loan + insurance + monthly fees) and the EV
  surcharge line only on `electric` / `plug_in_hybrid` rows.
- Any per-source caveat lines emitted by the server (e.g.
  `> carvana: oneOwner=true not enforceable`) — keep them; they explain why a
  source was skipped.
- The insurance disclaimer stays: it's ZIP + demographic only, not
  vehicle-specific.

## Default search behavior (when the user hasn't narrowed it)

Include all 5 sources (`cars.com`, `autotrader`, `kbb`, `carmax`, `carvana`) and
`maxResults >= 50` unless the user says otherwise.
