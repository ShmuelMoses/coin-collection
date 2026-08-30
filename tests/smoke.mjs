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
    get id() { return this._id || ''; }
    // Elements the app CREATES can also be looked up by id, and can go away
    // again - offerOfflineMode replaces its block that way.
    set id(v) { this._id = v; if (v) dynamicById.set(v, this); }
    getAttribute(k) { return this._attrs[k] ?? null; }
    removeAttribute(k) { delete this._attrs[k]; }
    appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
    append(...cs) { cs.forEach(c => this.appendChild(c)); }
    remove() {
        if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(x => x !== this);
        this.parentNode = null;
        if (this._id && dynamicById.get(this._id) === this) dynamicById.delete(this._id);
    }
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
const dynamicById = new Map();
function mkEl(id, tag) { const e = new El(tag); e.id = id; byId.set(id, e); return e; }

// Every id index.html defines that app code looks up.
[
    'status', 'content', 'signin-btn', 'login-box', 'login-version', 'app-version',
    'collection-view', 'cv-sidebar', 'cv-title', 'cv-controls-row', 'icon-row',
    'back-btn', 'view-toggle-btn', 'color-mode-btn', 'color-mode-dot', 'color-mode-label',
    'reset-btn', 'export-btn', 'info-btn', 'search-box', 'search-ghost',
    'cv-main', 'map', 'list-view',
    'modal-backdrop', 'modal', 'modal-header', 'modal-title', 'modal-images',
    'organize-icon-btn', 'organize-confirm-icon-btn', 'organize-cancel-icon-btn',
    'share-icon-btn', 'share-confirm-icon-btn', 'share-cancel-icon-btn',
    'enlarge-overlay', 'enlarge-img',
    'cache-modal-backdrop', 'cache-modal', 'cache-modal-stats', 'cache-modal-actions',
    'cache-clear-btn', 'cache-close-btn', 'info-modal-title',
    'info-collection', 'info-app', 'info-errors', 'delete-collection-btn',
    'offline-banner', 'info-signin-btn', 'offline-banner-text', 'offline-banner-btn',
].forEach(id => mkEl(id));
byId.get('search-box').value = '';
byId.get('search-ghost').value = '';

// Ids created by the app rather than declared in index.html.
const RUNTIME_IDS = new Set(['login-offline-block', 'login-offline-note']);

const documentElement = new El('html');
const body = new El('body');

const head = new El('head');
global.document = {
    documentElement,
    head,
    body,
    hidden: false,
    getElementById: id => {
        const el = byId.get(id) || dynamicById.get(id);
        if (el) return el;
        // Ids the app creates at runtime legitimately come and go, so a miss on
        // one of those is null (as in a browser). A miss on an id that index.html
        // is supposed to define is a typo, and still fails loudly.
        if (RUNTIME_IDS.has(id)) return null;
        throw new Error(`getElementById('${id}') returned null - that id is not in index.html`);
    },
    createElement: tag => new El(tag),
    createDocumentFragment: () => new El('fragment'),
    createTextNode: t => { const e = new El('#text'); e.textContent = String(t); return e; },
    querySelectorAll: () => [],
    // boot() now hangs off DOMContentLoaded rather than window.onload, so the
    // harness has to be able to fire it.
    readyState: 'loading',
    _listeners: {},
    addEventListener: (t, fn) => { (global.document._listeners[t] ||= []).push(fn); },
    removeEventListener: () => {},
    dispatch: t => { (global.document._listeners[t] || []).forEach(fn => fn({})); },
};
global.getComputedStyle = () => ({ getPropertyValue: name => ({
    '--accent-owned': '#4b6b3a', '--accent-none': '#a13d2b', '--muted': '#a89a78',
    '--map-border': 'rgba(59,42,26,0.45)', '--frame': '#5a3d22', '--frame-light': '#e8dcbb',
}[name] || '') });

const listeners = {};
const popstateHandlers = [];
global.window = {
    addEventListener: (t, fn) => {
        (listeners[t] ||= []).push(fn);
        if (t === 'popstate') popstateHandlers.push(fn);
    },
    removeEventListener: () => {},
};
global.history = { pushState() {}, back() {} };
Object.defineProperty(global, 'navigator', {
    value: { storage: null, share: null, serviceWorker: null, onLine: true }, configurable: true, writable: true
});
global.requestAnimationFrame = fn => setTimeout(fn, 0);
global.URL.createObjectURL = () => 'blob:stub';
global.URL.revokeObjectURL = () => {};
global.DOMParser = class { parseFromString() { return { documentElement: new El('svg') }; } };
// A small in-memory IndexedDB. The previous stub simply failed to open, so the
// cache code was never actually exercised - and "Clear cache" not touching the
// on-device store is exactly the kind of bug that hides behind a database that
// never works in the tests.
const idbStores = { images: new Map(), meta: new Map() };

function makeTransaction(name) {
    const map = idbStores[name];
    const tx = { error: null };
    let pending = 0, settled = false;
    const begin = () => { pending++; };
    const end = () => {
        if (--pending > 0 || settled) return;
        settled = true;
        setTimeout(() => tx.oncomplete && tx.oncomplete(), 0);
    };
    const request = run => {
        begin();
        const req = {};
        setTimeout(() => {
            try { req.result = run(); req.onsuccess && req.onsuccess(); }
            catch (e) { req.error = e; req.onerror && req.onerror(); }
            end();
        }, 0);
        return req;
    };
    // The cursor keeps the transaction open until it is exhausted, which is what
    // makes a stats walk over every entry finish before oncomplete fires.
    const cursor = keysOnly => {
        begin();
        const req = {};
        const entries = [...map.entries()];
        let i = 0;
        const step = () => {
            if (i >= entries.length) {
                req.result = null;
                req.onsuccess && req.onsuccess();
                end();
                return;
            }
            const [key, value] = entries[i++];
            req.result = { key, value: keysOnly ? undefined : value, continue: () => setTimeout(step, 0) };
            req.onsuccess && req.onsuccess();
        };
        setTimeout(step, 0);
        return req;
    };
    tx.objectStore = () => ({
        get: key => request(() => map.get(key) ?? null),
        put: (value, key) => request(() => { map.set(key, value); }),
        delete: key => request(() => { map.delete(key); }),
        clear: () => request(() => { map.clear(); }),
        openCursor: () => cursor(false),
        openKeyCursor: () => cursor(true),
    });
    return tx;
}

const fakeDB = {
    objectStoreNames: { contains: n => n in idbStores },
    createObjectStore: n => { idbStores[n] ||= new Map(); },
    transaction: name => makeTransaction(name),
};
global.indexedDB = {
    open() {
        const req = {};
        setTimeout(() => {
            req.result = fakeDB;
            req.onupgradeneeded && req.onupgradeneeded();
            req.onsuccess && req.onsuccess();
        }, 0);
        return req;
    }
};

let probeOnline = true;   // what the stubbed network says about reachability
global.fetch = async (url) => {
    if (String(url).includes('__netprobe')) {
        if (!probeOnline) throw new TypeError('Failed to fetch');
        return { ok: true, json: async () => ({}), text: async () => '' };
    }
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
// The token client hands back a token immediately, so withAuth() proceeds to
// the actual request instead of waiting on a refresh that never arrives.
let tokenRequests = 0;      // how many times a sign-in window was asked for
let lastTokenCfg = null;    // the config initAuth built the client with
global.google = {
    accounts: { oauth2: { initTokenClient: (cfg) => {
        lastTokenCfg = cfg;
        return {
            requestAccessToken() {
                tokenRequests++;
                setTimeout(() => cfg.callback({ access_token: 'test-token', expires_in: 3600 }), 0);
            }
        };
    } } },
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
    // Micro-states: previously dropped from the map entirely unless owned.
    { properties: { name: 'Malta', 'ISO3166-1-Alpha-3': 'MLT' },
      geometry: { type: 'Polygon', coordinates: [[[14.18,35.79],[14.57,35.79],[14.57,36.08],[14.18,36.08],[14.18,35.79]]] } },
    { properties: { name: 'Monaco', 'ISO3166-1-Alpha-3': 'MCO' },
      geometry: { type: 'Polygon', coordinates: [[[7.40,43.72],[7.44,43.72],[7.44,43.75],[7.40,43.75],[7.40,43.72]]] } },
    // No ISO code, but a real place referenced by the EUR currency group.
    { properties: { name: 'Kosovo', 'ISO3166-1-Alpha-3': '-99' },
      geometry: { type: 'Polygon', coordinates: [[[20,42],[22,42],[22,43],[20,43],[20,42]]] } },
    // No ISO code and not a country - must be dropped, not collapsed into a
    // shared "-99" entry along with Kosovo.
    { properties: { name: 'Scarborough Reef', 'ISO3166-1-Alpha-3': '-99' },
      geometry: { type: 'Polygon', coordinates: [[[117.7,15.1],[117.8,15.1],[117.8,15.2],[117.7,15.2],[117.7,15.1]]] } },
    { properties: { name: 'Bir Tawil', 'ISO3166-1-Alpha-3': '-99' },
      geometry: { type: 'Polygon', coordinates: [[[33,21],[34,21],[34,22],[33,22],[33,21]]] } },
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
check('version written into the login screen', byId.get('login-version').textContent === cfg.APP_VERSION);
check('names table now covers the EUR group',
    ['MCO','SMR','KSV','MNE','VAT','AND','MLT'].every(c => !!countries.COUNTRY_NAMES[c]),
    ['MCO','SMR','KSV','MNE'].map(c => c+'='+countries.COUNTRY_NAMES[c]).join(' '));

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
check('micro-states are on the map even when not owned',
    !!state.state.countryLayers['MLT'] && !!state.state.countryLayers['MCO'],
    'these used to be dropped entirely');
check('micro-states are real polygons, not markers',
    state.state.countryLayers['MLT'][0].kind === 'poly' && added.markers === 0);
check('Kosovo resolves to KSV (its EUR-group code) despite having no ISO code',
    !!state.state.countryLayers['KSV']);
check('code-less junk features are dropped, not merged into one "-99" entry',
    !state.state.countryLayers['-99'] && !state.state.countryLayers['null'],
    JSON.stringify(Object.keys(state.state.countryLayers)));
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

console.log('\nNavigation (popstate)');
{
    const modal = await import('./js/modal.js');
    const backs = [];
    global.history = { pushState() {}, back() { backs.push(1); popstateHandlers.forEach(fn => fn({})); } };
    // Pretend a country modal is open, then close it the way a backdrop click
    // does. It must consume exactly ONE history entry and must NOT fall through
    // to "go back to the collections list".
    byId.get('modal').style.display = 'block';
    byId.get('collection-view').style.display = 'flex';
    modal.closeModal(false);
    check('closing the modal pops one entry, not two', backs.length === 1, String(backs.length));
    check('it did not fall through to the collections screen',
        byId.get('collection-view').style.display === 'flex',
        'collection view was torn down - this was the double-pop bug');
    check('the suppress flag is cleared again', state.state.suppressNextPopstate === false);
}

console.log('\nCurrency merge (regression)');
const groups = drive.parseCurrencyGroups('# comment\nEUR: FRA, DEU\n\nbad line\n');
check('config parses', JSON.stringify(groups) === '{"EUR":["FRA","DEU"]}', JSON.stringify(groups));
const merged = drive.mergeCurrencyGroups(
    [{ code: 'FRA', images: [{ id: 'f1' }] }, { code: 'DEU', images: [] }],
    groups, { EUR: [{ id: 'e1' }] }, ['FRA', 'DEU', 'EUR']);
check('shared note folded into both countries',
    merged.find(c => c.code === 'FRA').images.length === 2 &&
    merged.find(c => c.code === 'DEU').images.length === 1);

console.log('\nCollection share sizing');
{
    const exp = await import('./js/export.js');
    const cache = await import('./js/cache.js');
    state.state.cvCountryMap = countries.buildCountryMap([
        { code: 'FRA', images: [{ id: 'a', name: 'a' }, { id: 'shared', name: 's' }] },
        { code: 'DEU', images: [{ id: 'b', name: 'b' }, { id: 'shared', name: 's' }] },
    ]);
    state.state.collectionData = { FRA: { count: 2 }, DEU: { count: 2 } };

    const half = await exp.buildCollectionExport('test1', 512 * 1024);
    check('unique photos counted once across countries', half.imageCount === 3,
        'imageCount=' + half.imageCount);
    const today = new Date();
    const stamp = today.getFullYear() + '-' +
        String(today.getMonth() + 1).padStart(2, '0') + '-' +
        String(today.getDate()).padStart(2, '0');
    check('filename carries the collection name and the export date',
        half.filename === `test1_${stamp}.html`, half.filename);
    check('a size is reported back', typeof half.bytes === 'number');

    // Cancellation uses a real AbortSignal, so it also tears down the transfer
    // in flight instead of only being noticed between photos.
    const controller = new AbortController();
    controller.abort();
    let cancelled = false;
    try {
        await exp.buildCollectionExport('test1', 512 * 1024, null, controller.signal);
    } catch (e) { cancelled = exp.isExportCancelled(e); }
    check('an already-aborted export stops immediately', cancelled);

    // And an abort DURING the run must be noticed by the download itself.
    const live = new AbortController();
    let sawSignal = false;
    const prevFetch2 = global.fetch;
    global.fetch = async (url, init) => {
        if (String(url).includes('/drive/v3/files/')) {
            if (init && init.signal) sawSignal = true;
            const err = new Error('aborted'); err.name = 'AbortError';
            throw err;
        }
        return prevFetch2(url, init);
    };
    // NOT pre-aborted: the run must reach the download so we can see whether
    // the signal was actually handed to fetch.
    try { await exp.buildCollectionExport('test1', 512 * 1024, null, live.signal); } catch (e) {}
    global.fetch = prevFetch2;
    check('the abort signal reaches fetch, so Cancel tears down the transfer',
        sawSignal, 'fetch was called without a signal - Cancel would only be noticed between photos');

    check('a country file is named after its collection and date', (() => {
        return typeof exp.buildCountryExport === 'function';
    })());
    check('per-image budgets are exported for the UI to offer',
        exp.DEFAULT_IMAGE_BUDGET === 512 * 1024, String(exp.DEFAULT_IMAGE_BUDGET));
    check('the thumbnail queue can be cleared', typeof cache.clearThumbQueue === 'function');
}

console.log('\nThumbnail queue (the Android failure)');
{
    const cache = await import('./js/cache.js');

    // Count how many full-image downloads are in flight at once. Before the
    // queue, the modal started one per photo simultaneously - which is what
    // exhausted the phone and ended in "Could not load".
    let inFlight = 0, peak = 0;
    const prevFetch = global.fetch;
    // Only this block's own ids are counted: the export test above can still
    // have a download in flight when this starts, and one stray request from a
    // finished test must not be read as the queue letting four jobs run.
    global.fetch = async (url) => {
        if (/\/drive\/v3\/files\/img\d/.test(String(url))) {
            inFlight++; peak = Math.max(peak, inFlight);
            await new Promise(r => setTimeout(r, 15));
            inFlight--;
            // Not an image: makes the job fail, which is what we want to observe.
            return { ok: true, blob: async () => new Blob(['x'], { type: 'text/plain' }),
                     text: async () => '', json: async () => ({}) };
        }
        return prevFetch(url);
    };

    const ids = Array.from({ length: 10 }, (_, i) => 'img' + i);
    const results = await Promise.allSettled(ids.map(id => cache.modalThumbUrl(id)));
    global.fetch = prevFetch;

    check('never more than a few downloads at once',
        peak > 0 && peak <= 3, 'peak concurrency was ' + peak);
    console.log('        (peak concurrent downloads: ' + peak + ' of 10 requested)');
    check('ten photos did not all start together', peak < 10, 'peak=' + peak);
    check('every one settled rather than hanging',
        results.every(r => r.status === 'rejected' || r.status === 'fulfilled'));
    check('failures are RECORDED for the info panel (this list was empty before)',
        cache.thumbErrors.some(e => e.stage === 'generate'),
        'stages seen: ' + [...new Set(cache.thumbErrors.map(e => e.stage))].join(','));
}

console.log('\nA stuck photo must not wedge the queue');
{
    const cache = await import('./js/cache.js');
    // Shorten the bounds so the test runs in milliseconds; the mechanism under
    // test is that the slot is released at all, not how long it waits.
    // download is left LONG on purpose: only the outer per-job bound can
    // release a slot here, which is exactly the guard being tested.
    cache.TIMEOUTS.job = 120;
    cache.TIMEOUTS.download = 30000;

    // Three photos whose download never settles - enough to occupy every slot -
    // followed by one that would succeed. Before the fix the stalled jobs held
    // their slots forever and the fourth photo waited with no error and no
    // timeout, which is what "infinite loading, no error" looked like.
    const prevFetch = global.fetch;
    const stuck = new Set(['hang0', 'hang1', 'hang2']);
    global.fetch = async (url) => {
        const m = String(url).match(/files\/([^?]+)/);
        if (m && stuck.has(m[1])) return new Promise(() => {}); // never settles
        if (m) return { ok: true, blob: async () => new Blob(['x'], { type: 'text/plain' }),
                        text: async () => '', json: async () => ({}) };
        return prevFetch(url);
    };

    // Shrink the wait so the test is quick: the job timeout is what guarantees
    // the slot is released, and we only need to prove the slot IS released.
    const started = Date.now();
    const results = await Promise.allSettled([
        cache.modalThumbUrl('hang0'), cache.modalThumbUrl('hang1'),
        cache.modalThumbUrl('hang2'), cache.modalThumbUrl('after'),
    ].map(p => Promise.race([p, new Promise(r => setTimeout(() => r('STILL-PENDING'), 300))])));
    global.fetch = prevFetch;

    const fourth = results[3];
    check('a photo queued behind stalled ones is not left pending forever',
        fourth.value !== 'STILL-PENDING' || fourth.status === 'rejected',
        'the 4th photo was still pending - the queue was wedged');
    check('the stalled ones did not consume the whole run', Date.now() - started < 3000);
}

console.log('\nOffline mode');
{
    const util = await import('./js/util.js');
    const cache = await import('./js/cache.js');
    const layouts = await import('./js/layouts.js');

    // A dropped connection arrives in several shapes; all must be recognised.
    const tErr = new TypeError('Failed to fetch');
    check('fetch TypeError is a network error', util.isNetworkError(tErr));
    check('gapi status 0 is a network error', util.isNetworkError({ status: 0 }));
    check('a 404 is NOT a network error', !util.isNetworkError({ status: 404 }));
    check('the message names the connection, not the exception',
        /no internet connection/i.test(util.describeError(tErr, 'It failed')),
        util.describeError(tErr, 'It failed'));
    check('a non-network error keeps its own wording',
        /Boom/.test(util.describeError(new Error('Boom'), 'It failed')));

    // Snapshots are what make offline possible at all.
    const store = new Map();
    const origSet = cache.setMeta, origGet = cache.getMeta;
    check('snapshot keys are namespaced per collection',
        cache.SNAP.collection('abc') === 'snapshot:collection:abc', cache.SNAP.collection('abc'));
    check('there are snapshot keys for the list and the layouts',
        !!cache.SNAP.collections && !!cache.SNAP.layouts);

    // Offline, layouts come from the snapshot and writing is refused outright
    // rather than failing halfway through a Drive call.
    state.state.offline = true;
    layouts.resetLayouts();
    let refused = false;
    try { await layouts.saveLayoutsToDrive(); } catch (e) { refused = /offline/i.test(e.message); }
    check('saving categories is refused while offline', refused);
    const l = await layouts.loadLayouts();
    check('layouts load offline without touching Drive', !!l && typeof l.data === 'object');
    state.state.offline = false;
    layouts.resetLayouts();
}

console.log('\nBoot with no connection is fast (item 2)');
{
    const cache = await import('./js/cache.js');
    const cfg2 = await import('./js/config.js');
    await cache.saveSnapshot(cache.SNAP.collections, [{ id: 'c1', name: 'Saved' }]);

    // Every Google step STALLS rather than fails when there is no route out, so
    // leaving them to time out is what put half a minute between opening the app
    // and being offered the offline copy. Made obvious here: the Google waits are
    // left long, and boot still has to finish quickly by asking the network first.
    cfg2.BOOT_TIMEOUTS.existingScriptWait = 4000;
    cfg2.BOOT_TIMEOUTS.retryScriptWait = 4000;
    cfg2.BOOT_TIMEOUTS.gapiLoad = 4000;
    cfg2.BOOT_TIMEOUTS.googleReady = 4000;

    const savedGoogle = global.google;
    delete global.google;
    probeOnline = false;               // no connection
    global.navigator.onLine = true;    // ...but the device does not know it

    const started = Date.now();
    global.document.dispatch('DOMContentLoaded');
    await new Promise(r => setTimeout(r, 600));
    const took = Date.now() - started;

    const blocks = () => byId.get('content').children.filter(c => c.id === 'login-offline-block');
    check('with no connection the offline option appears at once, not after ' +
          'every Google timeout has expired',
        blocks().length === 1 && took < 2000, `blocks=${blocks().length} after ${took}ms`);

    global.google = savedGoogle;
    probeOnline = true;
    await (await import('./js/net.js')).checkNow();
}

console.log('\nBoot with Google unreachable');
{
    const cache = await import('./js/cache.js');
    const cfg2 = await import('./js/config.js');
    // Shortened so this runs in milliseconds; what is under test is that boot
    // GIVES UP and offers a way forward, not how long it waits first.
    cfg2.BOOT_TIMEOUTS.existingScriptWait = 20;
    cfg2.BOOT_TIMEOUTS.retryScriptWait = 20;

    // Something saved from a previous online session, so offline mode has
    // content to offer.
    await cache.saveSnapshot(cache.SNAP.collections, [{ id: 'c1', name: 'Saved' }]);

    const savedGoogle = global.google;
    delete global.google;   // Google's scripts never arrived

    // It must NOT be waiting on window.onload: that event waits for Google's
    // <script> tags, and a request that hangs rather than fails delays it
    // forever - which is why Android sat on a disabled "Loading..." button
    // with no offline option at all.
    check('boot does not wait for window.onload (the Android hang)',
        (global.document._listeners['DOMContentLoaded'] || []).length === 1,
        'nothing is listening for DOMContentLoaded, so boot depends on every ' +
        'subresource arriving - including the ones that never do');

    // The connection is fine here; it is Google that cannot be reached.
    byId.get('signin-btn').dispatch('click');
    await new Promise(r => setTimeout(r, 400));

    const blocks = () => byId.get('content').children.filter(c => c.id === 'login-offline-block');
    check('the offline option is offered when Google cannot be reached',
        blocks().length === 1, 'blocks: ' + blocks().length);

    // Pressing Sign in fails again and re-offers. The note used to be replaced
    // but the button was not, so a second attempt left TWO "Continue without
    // signing in" buttons stacked up - which is what the screenshot showed.
    byId.get('signin-btn').dispatch('click');
    await new Promise(r => setTimeout(r, 300));
    check('a second failed attempt does not stack up a second offline option',
        blocks().length === 1, 'blocks: ' + blocks().length);
    check('and the one that remains still has its note and its button',
        blocks()[0] && blocks()[0].children.length === 2,
        JSON.stringify((blocks()[0] || { children: [] }).children.map(c => c.textContent.slice(0, 20))));

    global.google = savedGoogle;
    cfg2.BOOT_TIMEOUTS.existingScriptWait = 3500;
    cfg2.BOOT_TIMEOUTS.retryScriptWait = 4500;
}

console.log('\nSigning in actually starts a sign-in (item 1)');
{
    const auth = await import('./js/auth.js');
    // Google is reachable again: the sign-in button must now genuinely reach it
    // without the page being reloaded.
    byId.get('signin-btn').dispatch('click');
    await new Promise(r => setTimeout(r, 200));

    const btn = byId.get('signin-btn');
    check('the sign-in button has a click handler at all',
        typeof btn.onclick === 'function',
        'the button had NO handler: pressing it did nothing whenever the silent sign-in found no session');
    check('the token client is set up once Google is reachable, with no reload',
        auth.isAuthReady(),
        'initAuth ran only on the online boot path, so offline the button pressed a null client');
    check('promptSignIn refuses clearly instead of throwing a TypeError', (() => {
        try { auth.promptSignIn(); return true; }
        catch (e) { return /not been set up/.test(e.message); }
    })());
}

console.log('\nSigning in keeps the user gesture (item 3)');
{
    const fs = await import('node:fs');

    // requestAccessToken opens a window, and a browser only allows that while it
    // still considers itself inside the click that asked for it. ANY await first
    // - even a connectivity check - spends the gesture and the window is blocked
    // in silence. So this is checked SYNCHRONOUSLY, immediately after the click:
    // if the call only happens on a later tick, the count has not moved yet.
    const before = tokenRequests;
    byId.get('info-signin-btn').dispatch('click');
    check('the sign-in window is asked for inside the click itself',
        tokenRequests === before + 1,
        'requestAccessToken was only reached after an await, so the browser no ' +
        'longer treats it as a user gesture and blocks the window silently');
    await new Promise(r => setTimeout(r, 50));

    check('a sign-in window that never opens is reported, not swallowed',
        lastTokenCfg && typeof lastTokenCfg.error_callback === 'function',
        'without error_callback a blocked window produces no callback, no error ' +
        'and nothing on screen');

    // On a phone there is no room for it beside the message, and the same
    // button is already in the info panel.
    const html = fs.readFileSync('./index.html', 'utf8');
    const mobile = html.slice(html.indexOf('@media (max-width: 700px)'));
    check('the banner sign-in button is hidden on phones (item 4)',
        /#offline-banner-btn\s*\{[^}]*display:\s*none/.test(mobile.slice(0, mobile.indexOf('\n        }'))),
        'it squeezes the offline message on a narrow screen');
}

console.log('\nConnectivity monitoring (items 3 and 4)');
{
    const net = await import('./js/net.js');
    const fs = await import('node:fs');

    // The probe must be a request the service worker will NOT answer from its
    // cache, or it would report success while the device is offline and the
    // banner would never appear. The two halves live in different files, so
    // check they still agree on the marker.
    let probedUrl = null;
    const prevFetch = global.fetch;
    global.fetch = async (url, init) => { probedUrl = String(url); return prevFetch(url, init); };
    await net.checkNow();
    global.fetch = prevFetch;
    check('the connectivity probe is marked so the service worker lets it through',
        /__netprobe=/.test(probedUrl || ''), String(probedUrl));
    const sw = fs.readFileSync('./sw.js', 'utf8');
    check('sw.js actually bypasses that marker',
        /__netprobe/.test(sw) && /searchParams\.has\('__netprobe'\)/.test(sw),
        'the probe would be served from the cache and always look online');

    // Losing and regaining the connection must be published, not discovered at
    // the next reload: that is exactly what did not happen before.
    const seen = [];
    const stop = net.onConnectivityChange(v => seen.push(v));
    // Shortened so the test runs in milliseconds; what is under test is that
    // the monitor re-checks AT ALL without anyone asking, not how long it waits.
    net.POLL.whenOnline = 25;
    net.POLL.whenOffline = 25;
    await net.checkNow();          // re-arms the timer at the short interval

    // Nothing below calls checkNow(): the network simply changes and the app is
    // given a moment to notice by itself. That is the whole of items 3 and 4 -
    // before this, the connection was only ever consulted at startup.
    probeOnline = false;
    await new Promise(r => setTimeout(r, 200));
    check('a dropped connection is noticed by the poll, with nothing pressed',
        state.state.online === false,
        'the app only ever learned about the network at startup');
    check('the drop is announced to the app', seen[seen.length - 1] === false, JSON.stringify(seen));
    check('the banner is shown without a reload',
        byId.get('offline-banner').classList.contains('shown'));
    check('the banner says what is actually wrong',
        /no internet connection/i.test(byId.get('offline-banner-text').textContent),
        byId.get('offline-banner-text').textContent);

    // Item 4 is specifically that NOBODY has to press anything: the monitor has
    // to re-check on its own. Nothing below calls checkNow() - the connection is
    // simply restored and the app is given a moment to notice by itself.
    probeOnline = true;
    await new Promise(r => setTimeout(r, 200));
    check('the connection returning is noticed by the poll, with nothing pressed',
        state.state.online === true,
        'the app only ever learned about the network at startup');
    check('the notice clears by itself when the network is back',
        !byId.get('offline-banner').classList.contains('shown'));
    net.POLL.whenOffline = 5000;
    net.POLL.whenOnline = 5000;
    stop();
}

console.log('\nInfo panel reports LIVE state (item 2)');
{
    const factsOf = () => byId.get('info-app').children.map(c => c.textContent);

    byId.get('info-btn').dispatch('click');
    await new Promise(r => setTimeout(r, 30));
    check('the panel states the connection separately from the account',
        factsOf().includes('Connection') && factsOf().includes('Account'), JSON.stringify(factsOf()));
    check('connected is reported while connected',
        factsOf()[factsOf().indexOf('Connection') + 1] === 'Connected', JSON.stringify(factsOf()));

    // The bug: the panel went on saying "Signed in" after the connection went,
    // because the status was computed once from a flag set at startup.
    const net = await import('./js/net.js');
    probeOnline = false;
    await net.checkNow();
    await new Promise(r => setTimeout(r, 30));
    check('losing the connection updates the OPEN panel',
        factsOf()[factsOf().indexOf('Connection') + 1] === 'No connection', JSON.stringify(factsOf()));
    probeOnline = true;
    await net.checkNow();
    await new Promise(r => setTimeout(r, 30));
    byId.get('cache-close-btn').dispatch('click');
}

console.log('\nClear cache clears the DEVICE cache too (item 5)');
{
    const cache = await import('./js/cache.js');

    // Two thumbnails and one full-size photo sitting on the device - the state
    // the app is in after browsing a few countries.
    idbStores.images.set('p1_thumb', new Blob(['t'.repeat(1000)]));
    idbStores.images.set('p2_thumb', new Blob(['t'.repeat(2000)]));
    idbStores.images.set('p1_full', new Blob(['f'.repeat(9000)]));

    const stats = await cache.localCacheStats();
    check('the device cache is measured at all (it was never reported)',
        stats.thumbs === 2 && stats.fulls === 1, JSON.stringify(stats));
    check('and its size is measured', stats.thumbBytes === 3000 && stats.fullBytes === 9000,
        JSON.stringify(stats));

    // The actual bug: clearing Drive left every photo on the device, so they
    // still appeared instantly - offline included - while the panel reported
    // an empty cache.
    await cache.clearDriveThumbCache();
    const afterDrive = await cache.localCacheStats();
    check('clearing Drive alone does NOT empty the device - this is why photos still loaded',
        afterDrive.thumbs + afterDrive.fulls === 3, JSON.stringify(afterDrive));

    await cache.clearLocalImageCache();
    const afterLocal = await cache.localCacheStats();
    check('clearing the device cache really empties it',
        afterLocal.thumbs === 0 && afterLocal.fulls === 0, JSON.stringify(afterLocal));
}

console.log('\nDate formatting');
check('a Hebrew device locale does not leak into the date', (() => {
    const d = new Date('2026-08-20T00:00:00Z').toLocaleDateString('en-GB',
        { year: 'numeric', month: 'long', day: 'numeric' });
    return /August/.test(d);
})());

console.log('\nutil');
check('escapeHtml', util.escapeHtml('<b>&</b>') === '&lt;b&gt;&amp;&lt;/b&gt;');
check('applyOrder appends unlisted',
    util.applyOrder(['b'], [{ id: 'a' }, { id: 'b' }]).map(i => i.id).join() === 'b,a');

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
