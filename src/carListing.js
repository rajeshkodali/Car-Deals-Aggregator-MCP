'use strict';

// Plain data + format helper for a single car listing. Lives in its own
// module so callers (apiClient.js, server.js, tests) don't transitively
// pull in puppeteer/stealth just to construct a listing object.
// scraper.js re-exports this for backward compatibility with any code
// that still imports CarListing from there.
class CarListing {
    constructor(data) {
        this.title = data.title || null;
        this.price = data.price || null;
        this.mileage = data.mileage || null;
        this.dealerName = data.dealerName || null;
        this.location = data.location || null;
        this.dealRating = data.dealRating || null;
        this.url = data.url || null;
        this.source = data.source || null;
        // CARFAX badges. Mappers MUST set these only from source-verified
        // per-listing data (e.g. Cox `vhrPreview`, CarMax `highlights`).
        // Do NOT propagate request-level intent into per-listing flags —
        // it produces output that claims verification we can't back up.
        // Sources that don't expose per-listing CARFAX leave these false.
        this.isOneOwner = data.isOneOwner || false;
        this.noAccidents = data.noAccidents || false;
        this.personalUse = data.personalUse || false;
        // Normalized fuel type for per-listing EV-surcharge gating in
        // server.js. Values: 'electric' | 'plug_in_hybrid' | 'hybrid' |
        // 'gas' | 'diesel' | null. Mappers populate from source data;
        // null means the source didn't expose it (server falls back to
        // request-level intent with a per-listing caveat).
        this.fuelType = data.fuelType || null;
    }

    format() {
        let result = `${this.title || 'Unknown Vehicle'}`;
        if (this.price) result += `\n  Price: ${this.price}`;
        if (this.mileage) result += `\n  Mileage: ${this.mileage}`;
        if (this.dealRating) result += `\n  Deal Rating: ${this.dealRating}`;

        const badges = [];
        if (this.isOneOwner) badges.push('1-Owner');
        if (this.noAccidents) badges.push('No Accidents');
        if (this.personalUse) badges.push('Personal Use');
        if (badges.length > 0) result += `\n  CarFax: ${badges.join(' | ')}`;

        if (this.dealerName) result += `\n  Dealer: ${this.dealerName}`;
        if (this.location) result += `\n  Location: ${this.location}`;
        if (this.source) result += `\n  Source: ${this.source}`;
        if (this.url) result += `\n  ${this.url}`;
        return result;
    }
}

module.exports = { CarListing };
