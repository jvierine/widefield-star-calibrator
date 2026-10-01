const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
const payload = JSON.parse(fs.readFileSync(path.join(root, 'data/td1_uv.json')));

test('TD-1 browser asset has unique physical identifiers and sorted finite UV magnitudes', () => {
    assert.ok(payload.rows.length > 17000);
    const ids = new Set();
    let previous = -Infinity;
    for (const [ra, dec, mag, name, id] of payload.rows) {
        assert.ok(ra >= 0 && ra < 24 && dec >= -90 && dec <= 90);
        assert.ok(Number.isFinite(mag) && mag >= previous);
        assert.ok(name && /^TD1-\d+$/.test(id) && !ids.has(id));
        ids.add(id); previous = mag;
    }
    assert.match(payload.metadata.frame, /J2000/);
    assert.match(payload.metadata.magnitude, /AB/);
    // Vega: a known independent positional sanity check (HD 172167).
    const vega = payload.rows.find(row => row[3] === 'HD 172167');
    assert.ok(vega && Math.abs(vega[0] - 18.6156) < 0.01 && Math.abs(vega[1] - 38.7837) < 0.05);
});

test('TD-1 loads on demand without silently substituting optical stars on failure', async () => {
    const source = fs.readFileSync(path.join(root, 'js/app.js'), 'utf8');
    const body = source.slice(source.indexOf('    async function loadTd1Catalog()'), source.indexOf('    async function loadTycho2Catalog()'));
    const context = {state: {catalogs: {td1: null}}, render() {}, recomputeAndRender() {},
        selectedCatalogName: () => 'td1', fetch: async () => ({ok: true, json: async () => payload})};
    vm.createContext(context); vm.runInContext(body, context);
    await context.loadTd1Catalog();
    assert.equal(context.state.catalogs.td1.length, payload.rows.length);
    context.state.catalogs.td1 = null;
    context.fetch = async () => ({ok: false, status: 404});
    await context.loadTd1Catalog();
    assert.equal(context.state.catalogs.td1, null);
    assert.match(context.state.catalogStatus, /unavailable/);
});
