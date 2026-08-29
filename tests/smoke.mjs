// Headless smoke test. There is no jsdom available in this sandbox and no
// network to install one, so this provides just enough of a DOM, Leaflet, gapi
// and IndexedDB for the real modules to load and run. It will not catch layout
// or paint problems - but it does catch the failure mode that matters most for
// a module split: a module that throws on load, a function that reaches for
// something that no longer exists, or wiring that silently never runs.

// ---------------- minimal DOM ----------------
class ClassList {
    constructor() { this.s = new Set(); }
    add(...c) { c.forEach(x => this.s.add(x)); }
    remove(...c) { c.forEach(x => this.s.delete(x)); }
    contains(c) { return this.s.has(c); }
    toggle(c, on) { if (on === undefined) { this.s.has(c) ? this.s.delete(c) : this.s.add(c); } else if (on) this.s.add(c); else this.s.delete(c); }
}

class El {
    constructor(tag) {
        this.tagName = (tag || 'div').toUpperCase();
        this.children = [];
        this.parentNode = null;
        this.style = new Proxy({ setProperty(){}, removeProperty(){}, cssText: '' }, {
            get: (t, k) => (k in t ? t[k] : ''),
            set: (t, k, v) => { t[k] = v; return true; }
        });
        this.dataset = {};
        this.classList = new ClassList();
        this._attrs = {};
        this._text = '';
        this._html = '';
        this._listeners = {};
    }
    get className() { return [...this.classList.s].join(' '); }
    set className(v) { this.classList = new ClassList(); String(v).split(/\s+/).filter(Boolean).forEach(c => this.classList.add(c)); }
    get textContent() { return this._text; }
    set textContent(v) { this._text = String(v); this.children = []; }
    get innerHTML() { return this._html; }
    set innerHTML(v) { this._html = String(v); this.children = []; }
    setAttribute(k, v) { this._attrs[k] = String(v); if (k === 'id') this.id = v; }
    getAttribute(k) { return this._attrs[k] ?? null; }
    removeAttribute(k) { delete this._attrs[k]; }
    appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
    append(...cs) { cs.forEach(c => this.appendChild(c)); }
    remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(x => x !== this); }
    addEventListener(t, fn) { (this._listeners[t] ||= []).push(fn); }
    removeEventListener() {}
    dispatch(t, ev) { (this._listeners[t] || []).forEach(fn => fn(ev || {})); if (this['on' + t]) this['on' + t](ev || {}); }
    querySelectorAll() { return []; }
    focus() {}
    select() {}
    getContext() { return { drawImage() {} }; }
    toBlob(cb) { cb(new Blob(['x'])); }
}

const byId = new Map();
function mkEl(id, tag) { const e = new El(tag); e.id = id; byId.set(id, e); return e; }

// Every id index.html defines that app code looks up.
[
    'status', 'content', 'signin-btn', 'login-box', 'login-version', 'app-version',
    'collection-view', 'cv-sidebar', 'cv-title', 'cv-controls-row', 'icon-row',
    'back-btn', 'view-toggle-btn', 'color-mode-btn', 'color-mode-dot', 'color-mode-label',
    'reset-btn', 'export-btn', 'search-box', 'search-ghost', 'cv-main', 'map', 'list-view',
    'modal-backdrop', 'modal', 'modal-header', 'modal-title', 'modal-images',
    'organize-icon-btn', 'organize-confirm-icon-btn', 'organize-cancel-icon-btn',
    'share-icon-btn', 'share-confirm-icon-btn', 'share-cancel-icon-btn',
    'enlarge-overlay', 'enlarge-img',
    'cache-modal-backdrop', 'cache-modal', 'cache-modal-stats', 'cache-modal-actions',
    'cache-clear-btn', 'cache-close-btn',
].forEach(id => mkEl(id));
byId.get('search-box').value = '';
byId.get('search-ghost').value = '';

const documentElement = new El('html');
const body = new El('body');

global.document = {
    documentElement,
    body,
    getElementById: id => {
        const el = byId.get(id);
        if (!el) { throw new Error(`getElementById('${id}') returned null - that id is not in index.html`); }
        return el;
    },
    createElement: tag => new El(tag),
    createDocumentFragment: () => new El('fragment'),
    querySelectorAll: () => [],
    addEventListener: () => {},
    removeEventListener: () => {},
};
global.getComputedStyle = () => ({ getPropertyValue: name => ({
    '--accent-owned': '#4b6b3a', '--accent-none': '#a13d2b', '--muted': '#a89a78',
    '--map-border': 'rgba(59,42,26,0.45)', '--frame': '#5a3d22', '--frame-light': '#e8dcbb',
}[name] || '') });

const listeners = {};
global.window = {
    addEventListener: (t, fn) => { (listeners[t] ||= []).push(fn); },
    removeEventListener: () => {},
};
global.history = { pushState() {}, back() {} };
Object.defineProperty(global, 'navigator', {
    value: { storage: null, share: null, serviceWorker: null }, configurable: true, writable: true
});
global.requestAnimationFrame = fn => setTimeout(fn, 0);
global.URL.createObjectURL = () => 'blob:stub';
global.URL.revokeObjectURL = () => {};
global.DOMParser = class { parseFromString() { return { documentElement: new El('svg') }; } };
global.indexedDB = { open() { const r = {}; setTimeout(() => { r.result = null; r.onerror && r.onerror(); }, 0); return r; } };
global.fetch = async (url) => {
    if (String(url).includes('countries.geojson')) {
        return { ok: true, json: async () => GEOJSON };
    }
    return { ok: true, json: async () => ({}), text: async () => '', blob: async () => new Blob([]) };
};

// ---------------- stub Leaflet ----------------
function layerStub(kind) {
    const l = {
        kind, _tooltip: null, _style: null, _handlers: {},
        setStyle(s) { this._style = s; return this; },
        bindTooltip(t, o) { this._tooltip = { t, o }; return this; },
        unbindTooltip() { this._tooltip = null; return this; },
        getTooltip() { return this._tooltip; },
        on(ev, fn) { (this._handlers[ev] ||= []).push(fn); return this; },
        fire(ev) { (this._handlers[ev] || []).forEach(fn => fn.call(this, {})); },
        addTo() { return this; },
        getBounds() { return {}; },
        redraw() { return this; },
    };
    return l;
}
const added = { polylines: 0, rectangles: 0, markers: 0, overlays: 0 };
global.L = {
    map: () => ({
        setView() { return this; },
        remove() {},
        invalidateSize() {},
        getBoundsZoom() { return 2; },
        setMinZoom() {},
        fitBounds() {},
    }),
    geoJSON: (data, opts) => ({
        addTo() {
            (data.features || []).forEach(f => opts.onEachFeature(f, layerStub('poly')));
            return this;
        }
    }),
    circleMarker: () => { added.markers++; return layerStub('marker'); },
    polyline: () => { added.polylines++; return layerStub('polyline'); },
    rectangle: () => { added.rectangles++; return layerStub('rect'); },
    layerGroup: () => ({ _l: [], addTo() { return this; }, eachLayer(fn) { this._l.forEach(fn); } }),
    svg: () => ({}),
    svgOverlay: () => { added.overlays++; return { addTo() { return this; } }; },
    point: (a, b) => ({ a, b }),
    featureGroup: () => ({ getBounds: () => ({}) }),
};
// layerGroup children register via .addTo(group)
const realLayerGroup = global.L.layerGroup;
global.L.layerGroup = () => {
    const g = realLayerGroup();
    return g;
};

// ---------------- stub gapi / google ----------------
const driveFiles = [];
global.gapi = {
    load: (_what, cb) => cb(),
    client: {
        init: async () => {},
        load: async () => {},
        setToken: () => {},
        drive: { files: {
            list: async ({ q }) => {
                if (q && q.includes('collections.json')) return { result: { files: [] } };
                if (q && q.includes('layouts.json')) return { result: { files: [] } };
                if (q && q.includes('_thumb.jpg')) return { result: { files: [] } };
                return { result: { files: driveFiles } };
            },
            get: async () => ({ body: '{}' }),
            export: async () => ({ body: '' }),
            delete: async () => ({}),
        } },
    },
};
global.google = {
    accounts: { oauth2: { initTokenClient: () => ({ requestAccessToken() {} }) } },
    picker: { PickerBuilder: class {}, DocsView: class {}, ViewId: {}, Action: {} },
};

// ---------------- a tiny world ----------------
const GEOJSON = { type: 'FeatureCollection', features: [
    { properties: { name: 'France', 'ISO3166-1-Alpha-3': 'FRA' },
      geometry: { type: 'Polygon', coordinates: [[[0,42],[8,42],[8,51],[0,51],[0,42]]] } },
    { properties: { name: 'Germany', 'ISO3166-1-Alpha-3': 'DEU' },
      geometry: { type: 'Polygon', coordinates: [[[6,47],[15,47],[15,55],[6,55],[6,47]]] } },
    { properties: { name: 'Russia', 'ISO3166-1-Alpha-3': 'RUS' },
      geometry: { type: 'Polygon', coordinates: [[[30,45],[180,45],[180,75],[30,75],[30,45]]] } },
    { properties: { name: 'Costa Rica', 'ISO3166-1-Alpha-3': 'CRI' },
      geometry: { type: 'Polygon', coordinates: [[[-86,8],[-82,8],[-82,11],[-86,11],[-86,8]]] } },
    // A micro-state: previously dropped from the map entirely unless owned.
    { properties: { name: 'Malta', 'ISO3166-1-Alpha-3': 'MLT' },
      geometry: { type: 'Polygon', coordinates: [[[14.18,35.79],[14.57,35.79],[14.57,36.08],[14.18,36.08],[14.18,35.79]]] } },
    { properties: { name: 'Antarctica', 'ISO3166-1-Alpha-3': 'ATA' },
      geometry: { type: 'Polygon', coordinates: [[[-180,-90],[180,-90],[180,-60],[-180,-60],[-180,-90]]] } },
]};

// ---------------- run ----------------
let pass = 0, fail = 0;
const check = (label, cond, detail) => {
    if (cond === true) { pass++; console.log('  PASS  ' + label); }
    else { fail++; console.log('  FAIL  ' + label + (detail ? '  -> ' + detail : '')); }
};

console.log('\nModule load');
let state, countries, geo, map, list, cfg, drive, util;
try {
    cfg = await import('./js/config.js');
    util = await import('./js/util.js');
    state = await import('./js/state.js');
    countries = await import('./js/countries.js');
    geo = await import('./js/geo.js');
    drive = await import('./js/drive.js');
    list = await import('./js/list.js');
    map = await import('./js/map.js');
    await import('./js/dialog.js');
    await import('./js/export.js');
    await import('./js/modal.js');
    await import('./js/app.js');   // this one wires everything up
    check('every module loads and app.js wires up without throwing', true);
} catch (e) {
    check('every module loads and app.js wires up without throwing', false, e.stack.split('\n').slice(0,4).join(' | '));
    console.log(`\n${pass} passed, ${fail} failed\n`);
    process.exit(1);
}

console.log('\nPalette + version');
check('colours came from the CSS variables', cfg.OWNED_COLOR === '#4b6b3a', cfg.OWNED_COLOR);
check('version written into both elements',
    byId.get('login-version').textContent === cfg.APP_VERSION &&
    byId.get('app-version').textContent === cfg.APP_VERSION);

console.log('\nCosta Rica code fix');
check('CRI has a name', countries.COUNTRY_NAMES['CRI'] === 'Costa Rica');
check('an old CRC folder still resolves', countries.canonicalCode('CRC') === 'CRI');

console.log('\nBuilding a collection view');
const fakeCountries = [
    { code: 'FRA', images: [{ id: 'eur1', name: 'a.jpg' }, { id: 'f1', name: 'b.jpg' }] },
    { code: 'DEU', images: [{ id: 'eur1', name: 'a.jpg' }, { id: 'd1', name: 'c.jpg' }] },
    { code: 'CRC', images: [{ id: 'cr1', name: 'd.jpg' }] },   // old folder name
];
state.state.currentCollectionId = 'col1';
state.state.cvCountries = fakeCountries;
state.state.cvCountryMap = countries.buildCountryMap(fakeCountries);
state.state.collectionData = {};
Object.entries(state.state.cvCountryMap).forEach(([code, entry]) => {
    const total = countries.countryTotalCount(entry);
    if (total > 0) state.state.collectionData[code] = { count: total, name: code };
});
check('CRC folder was filed under CRI', !!state.state.collectionData['CRI']);
check('shared note counted once overall', countries.uniqueImageCount(state.state.cvCountryMap) === 4,
    String(countries.uniqueImageCount(state.state.cvCountryMap)));

await map.initMap();
check('Antarctica excluded', !state.state.countryLayers['ATA']);
check('normal countries drawn', !!state.state.countryLayers['FRA'] && !!state.state.countryLayers['RUS']);
check('D-06: Malta now on the map even though it is not owned',
    !!state.state.countryLayers['MLT'], 'micro-states used to be dropped entirely');
check('D-06: Malta drawn as a marker, not a polygon',
    state.state.countryLayers['MLT'][0].kind === 'marker');
check('frame drew parallels and meridians', added.polylines > 10, String(added.polylines));

console.log('\nGrid geometry (regression)');
const ys = geo.parallelYs();
const gaps = ys.slice(1).map((y, i) => y - ys[i]);
check('parallels evenly spaced in projected space',
    gaps.length > 3 && gaps.every(g => Math.abs(g - geo.GRID_STEP) < 1e-9), JSON.stringify(gaps));
check('equator is ruled', ys.includes(0));
check('compass sits on a real intersection',
    ys.includes(-geo.GRID_STEP) && geo.meridianLons().includes(geo.COMPASS_CENTER_LON));

console.log('\nList view');
list.renderList();
check('a row exists for every country on the map',
    list.countryRowEls.size === Object.keys(state.state.countryNameLookup).length,
    `${list.countryRowEls.size} rows vs ${Object.keys(state.state.countryNameLookup).length} countries`);
check('owned country row shows its count',
    list.countryRowEls.get('FRA').children.some(c => c.textContent === '2'));

console.log('\nFiltering');
state.state.colorMode = 'none';
let matched = map.applyFilters();
check('"None yet" excludes owned countries', !matched.includes('FRA') && matched.includes('RUS'));
check('"None yet" includes the micro-state', matched.includes('MLT'));
state.state.colorMode = 'owned';
matched = map.applyFilters();
check('"Have items" includes only owned', matched.includes('FRA') && !matched.includes('RUS'));
state.state.colorMode = 'both';
state.state.searchQuery = 'ger';
matched = map.applyFilters();
check('search matches by name', matched.length === 1 && matched[0] === 'DEU', JSON.stringify(matched));
check('search pins the matching label', state.state.labelShownCodes.has('DEU'));
state.state.searchQuery = '';
map.applyFilters();
check('clearing the search unpins it', !state.state.labelShownCodes.has('DEU'));

console.log('\nP-02: labels only rebind on change');
state.state.searchQuery = 'fra';
map.applyFilters();
const before = state.state.countryLayers['RUS'][0]._tooltip;
state.state.searchQuery = 'fran';
map.applyFilters();
check('an unaffected country keeps its original tooltip object',
    state.state.countryLayers['RUS'][0]._tooltip === before);

console.log('\nCurrency merge (regression)');
const groups = drive.parseCurrencyGroups('# comment\nEUR: FRA, DEU\n\nbad line\n');
check('config parses', JSON.stringify(groups) === '{"EUR":["FRA","DEU"]}', JSON.stringify(groups));
const merged = drive.mergeCurrencyGroups(
    [{ code: 'FRA', images: [{ id: 'f1' }] }, { code: 'DEU', images: [] }],
    groups, { EUR: [{ id: 'e1' }] }, ['FRA', 'DEU', 'EUR']);
check('shared note folded into both countries',
    merged.find(c => c.code === 'FRA').images.length === 2 &&
    merged.find(c => c.code === 'DEU').images.length === 1);

console.log('\nutil');
check('escapeHtml', util.escapeHtml('<b>&</b>') === '&lt;b&gt;&amp;&lt;/b&gt;');
check('applyOrder appends unlisted',
    util.applyOrder(['b'], [{ id: 'a' }, { id: 'b' }]).map(i => i.id).join() === 'b,a');

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
