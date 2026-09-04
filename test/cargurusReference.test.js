'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const cargurusReference = require('../src/cargurusReference.js');

// cargurusReference has no fetch path at all — every lookup goes through a
// caller-supplied Puppeteer `page` (see the file header for why). We stub
// that page with a tiny fake exposing just .goto()/.evaluate(), so these
// tests stay offline like the rest of the suite despite the module being
// Puppeteer-only in production.
function makePage(responsesByUrl) {
    let lastUrl = null;
    return {
        calls: [],
        async goto(url) { lastUrl = url; this.calls.push(url); },
        async evaluate() {
            const match = Object.keys(responsesByUrl).find(k => lastUrl.includes(k));
            if (!match) throw new Error(`no fixture for ${lastUrl}`);
            return responsesByUrl[match];
        }
    };
}

test.beforeEach(() => cargurusReference._clearCache());

test('resolveMakeModel resolves make and model ids on a hit', async () => {
    const page = makePage({
        'listMakes.action': JSON.stringify({ makes: [{ name: 'Hyundai', id: 'm28' }, { name: 'Toyota', id: 'm7' }] }),
        'listModels.action': JSON.stringify({ makeId: 'm28', models: [{ name: 'Ioniq 5', id: 'd3120' }, { name: 'Sonata', id: 'd96' }] })
    });
    const { makeId, modelId } = await cargurusReference.resolveMakeModel(page, 'Hyundai', 'Ioniq 5');
    assert.equal(makeId, 'm28');
    assert.equal(modelId, 'd3120');
});

test('resolveMakeModel is case/spacing insensitive', async () => {
    const page = makePage({
        'listMakes.action': JSON.stringify({ makes: [{ name: 'Hyundai', id: 'm28' }] }),
        'listModels.action': JSON.stringify({ models: [{ name: 'Ioniq 5', id: 'd3120' }] })
    });
    const { makeId, modelId } = await cargurusReference.resolveMakeModel(page, 'HYUNDAI', 'ioniq5');
    assert.equal(makeId, 'm28');
    assert.equal(modelId, 'd3120');
});

test('resolveMakeModel returns null modelId without looking up models when make misses', async () => {
    const page = makePage({
        'listMakes.action': JSON.stringify({ makes: [{ name: 'Toyota', id: 'm7' }] })
    });
    const { makeId, modelId } = await cargurusReference.resolveMakeModel(page, 'Hyundai', 'Ioniq 5');
    assert.equal(makeId, null);
    assert.equal(modelId, null);
    // Only the makes lookup should have run — no wasted models.action call.
    assert.equal(page.calls.filter(u => u.includes('listModels')).length, 0);
});

test('resolveMakeModel returns null modelId on a model-name miss within a known make', async () => {
    const page = makePage({
        'listMakes.action': JSON.stringify({ makes: [{ name: 'Hyundai', id: 'm28' }] }),
        'listModels.action': JSON.stringify({ models: [{ name: 'Sonata', id: 'd96' }] })
    });
    const { makeId, modelId } = await cargurusReference.resolveMakeModel(page, 'Hyundai', 'Ioniq 9000');
    assert.equal(makeId, 'm28');
    assert.equal(modelId, null);
});

test('resolveMakeModel returns null/null and does not throw when make/model are omitted', async () => {
    const page = makePage({});
    const { makeId, modelId } = await cargurusReference.resolveMakeModel(page, null, null);
    assert.equal(makeId, null);
    assert.equal(modelId, null);
    assert.equal(page.calls.length, 0);
});

test('resolveMakeModel swallows a malformed listMakes response and returns null', async () => {
    const page = makePage({ 'listMakes.action': 'not json' });
    const { makeId, modelId } = await cargurusReference.resolveMakeModel(page, 'Hyundai', 'Ioniq 5');
    assert.equal(makeId, null);
    assert.equal(modelId, null);
});

test('makes index is cached across calls (second resolve does not re-fetch listMakes)', async () => {
    const page = makePage({
        'listMakes.action': JSON.stringify({ makes: [{ name: 'Hyundai', id: 'm28' }] }),
        'listModels.action': JSON.stringify({ models: [{ name: 'Ioniq 5', id: 'd3120' }] })
    });
    await cargurusReference.resolveMakeModel(page, 'Hyundai', 'Ioniq 5');
    await cargurusReference.resolveMakeModel(page, 'Hyundai', 'Sonata');
    assert.equal(page.calls.filter(u => u.includes('listMakes')).length, 1, 'listMakes fetched only once');
});
