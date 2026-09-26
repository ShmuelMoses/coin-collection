// The Leaflet map: countries, the antique frame, colouring and labels.

import {
    MUTED_COLOR, BORDER_COLOR, styleFor,
    REVEAL_MS, COUNTRY_FADE_MS, REVEAL_MAX_STEP_MS
} from './config.js';
import { state, passesFilters, matchesQuery, isOwned } from './state.js';
import {
    getProjectedFeatures, getCodeForFeature,
    buildMapFrame, FRAME_BOUNDS, COMPASS_BOUNDS
} from './geo.js';
import { canonicalCode, filterEntry } from './countries.js';
import { openModal } from './modal.js';
import { countryRowEls } from './list.js';
import { getCountryBackgroundId } from './layouts.js';
import { mapFillThumbUrl, releaseMapFillUrls } from './cache.js';

// Decorative antique-map compass rose. Added with L.svgOverlay bound to a real
// lat/lng box rather than a fixed-pixel marker, so it scales with the map
// instead of staying a constant screen size - it should look printed on the
// map, the way a real antique map's compass rose is.
const COMPASS_ROSE_SVG = `<svg class="compass-rose-overlay" viewBox="-10 -10 220 220" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
            <circle cx="100" cy="100" r="101" fill="none" stroke="currentColor" stroke-width="1.2" opacity="0.5"/>
            <circle cx="100" cy="100" r="80" fill="none" stroke="currentColor" stroke-width="0.7" opacity="0.35"/>
            <g stroke="currentColor" stroke-width="1" opacity="0.5">
                <line x1="123.3" y1="13.1" x2="125.4" y2="5.3"/><line x1="145.0" y1="22.1" x2="150.0" y2="13.4"/><line x1="177.9" y1="55.0" x2="186.6" y2="50.0"/><line x1="186.9" y1="76.7" x2="194.7" y2="74.6"/><line x1="186.9" y1="123.3" x2="194.7" y2="125.4"/><line x1="177.9" y1="145.0" x2="186.6" y2="150.0"/><line x1="145.0" y1="177.9" x2="150.0" y2="186.6"/><line x1="123.3" y1="186.9" x2="125.4" y2="194.7"/><line x1="76.7" y1="186.9" x2="74.6" y2="194.7"/><line x1="55.0" y1="177.9" x2="50.0" y2="186.6"/><line x1="22.1" y1="145.0" x2="13.4" y2="150.0"/><line x1="13.1" y1="123.3" x2="5.3" y2="125.4"/><line x1="13.1" y1="76.7" x2="5.3" y2="74.6"/><line x1="22.1" y1="55.0" x2="13.4" y2="50.0"/><line x1="55.0" y1="22.1" x2="50.0" y2="13.4"/><line x1="76.7" y1="13.1" x2="74.6" y2="5.3"/>
            </g>
            <polygon points="138.9,61.1 122.0,100.0 138.9,138.9 100.0,122.0 61.1,138.9 78.0,100.0 61.1,61.1 100.0,78.0" fill="currentColor" opacity="0.3"/>
            <polygon points="100.0,12.0 115.6,84.4 188.0,100.0 115.6,115.6 100.0,188.0 84.4,115.6 12.0,100.0 84.4,84.4" fill="currentColor" opacity="0.75"/>
            <circle cx="100" cy="100" r="5" fill="currentColor" opacity="0.9"/>
            <text x="100" y="-4" text-anchor="middle" dominant-baseline="central" font-size="22" font-family="Georgia, 'Times New Roman', serif" font-style="italic" fill="currentColor" opacity="0.9">N</text>
            <text x="204" y="100" text-anchor="middle" dominant-baseline="central" font-size="22" font-family="Georgia, 'Times New Roman', serif" font-style="italic" fill="currentColor" opacity="0.9">E</text>
            <text x="100" y="204" text-anchor="middle" dominant-baseline="central" font-size="22" font-family="Georgia, 'Times New Roman', serif" font-style="italic" fill="currentColor" opacity="0.9">S</text>
            <text x="-4" y="100" text-anchor="middle" dominant-baseline="central" font-size="22" font-family="Georgia, 'Times New Roman', serif" font-style="italic" fill="currentColor" opacity="0.9">W</text>
        </svg>`;

export let leafletMap = null;

// One definition of a country's outline, used both by the map itself and by
// the photo fills drawn over it. Two copies is how the photo countries ended
// up wearing an outline four times heavier than their neighbours.
export const COUNTRY_BORDER = { color: BORDER_COLOR, weight: 0.6 };

// ---------- colouring ----------
// Colour maths for the cross-fade. The palette lives in CSS custom properties,
// so a value can arrive as #rgb, #rrggbb or rgb()/rgba() - all of which have to
// become numbers before anything can be interpolated.
function parseColor(value) {
    const s = String(value || '').trim();
    const m = s.match(/^rgba?\(([^)]+)\)$/i);
    if (m) {
        const p = m[1].split(',').map(v => parseFloat(v));
        return [p[0] | 0, p[1] | 0, p[2] | 0];
    }
    let hex = s.replace('#', '');
    if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
    const n = parseInt(hex, 16);
    if (isNaN(n)) return [0, 0, 0];
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const mix = (a, b, t) => Math.round(a + (b - a) * t);
// Smoothstep: no hard start or stop, so each country eases into its colour
// instead of snapping on at t=0.
const ease = t => t * t * (3 - 2 * t);

// Only one fade may be in flight. A second press while the first is still
// running would otherwise leave two loops writing different colours to the
// same layers, and whichever finished last would win.
let activeFade = null;
function cancelFade() {
    if (activeFade === null) return;
    cancelAnimationFrame(activeFade);
    activeFade = null;
}

// The countries come in one after another: each has its own short fade, and
// their start times are spread across the sweep in the order the layers were
// built, so the colour travels across the map instead of appearing everywhere
// at once.
//
// durationMs is a ceiling, not a fixed length. The gap between one country and
// the next is the window divided between them, capped at REVEAL_MAX_STEP_MS -
// otherwise a four-country collection would stretch those four over three
// seconds and look broken rather than deliberate.
function animateFill(changes, durationMs, onDone) {
    const specs = changes.map(ch => ({
        layers: ch.layers,
        fromRgb: parseColor(ch.from.fillColor),
        toRgb: parseColor(ch.to.fillColor),
        fromOpacity: ch.from.fillOpacity,
        toOpacity: ch.to.fillOpacity,
        to: ch.to,
        done: false,
    }));

    const fadeMs = Math.min(COUNTRY_FADE_MS, durationMs);
    const spread = Math.max(0, durationMs - fadeMs);
    const step = specs.length > 1
        ? Math.min(REVEAL_MAX_STEP_MS, spread / (specs.length - 1))
        : 0;
    specs.forEach((s, i) => { s.startAt = i * step; });
    const totalMs = step * Math.max(0, specs.length - 1) + fadeMs;

    const started = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    // Every frame repaints the whole canvas, so on a phone with 250 polygons
    // there is nothing to gain from 60fps. ~33fps is indistinguishable for a
    // colour fade and costs half as much.
    const MIN_FRAME_MS = 30;
    let lastPainted = -Infinity;

    const finish = () => {
        activeFade = null;
        specs.forEach(s => s.layers.forEach(layer => layer.setStyle(s.to)));
        if (onDone) onDone();
    };

    const frame = () => {
        const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
        const elapsed = now - started;
        if (elapsed >= totalMs) { finish(); return; }
        if (now - lastPainted >= MIN_FRAME_MS) {
            lastPainted = now;
            specs.forEach(s => {
                // Finished countries are left alone rather than restyled every
                // frame, and ones whose turn has not come are left at the
                // colour they already have on screen.
                if (s.done) return;
                const t = fadeMs > 0 ? (elapsed - s.startAt) / fadeMs : 1;
                if (t <= 0) return;
                if (t >= 1) {
                    s.layers.forEach(layer => layer.setStyle(s.to));
                    s.done = true;
                    return;
                }
                const e = ease(t);
                const style = {
                    fillColor: `rgb(${mix(s.fromRgb[0], s.toRgb[0], e)},` +
                               `${mix(s.fromRgb[1], s.toRgb[1], e)},` +
                               `${mix(s.fromRgb[2], s.toRgb[2], e)})`,
                    fillOpacity: s.fromOpacity + (s.toOpacity - s.fromOpacity) * e,
                };
                s.layers.forEach(layer => layer.setStyle(style));
            });
        }
        activeFade = requestAnimationFrame(frame);
    };
    activeFade = requestAnimationFrame(frame);
}

// `animate` colours in every country that changes, one after another, within
// durationMs. Only countries that actually CHANGE are animated - shownCodes and
// ownedCodes remember what is on screen - so each call only touches what is
// different. Typing in the search box colours instantly; animating that too
// would make it feel laggy.
export function applyFilters(opts) {
    const animate = !!(opts && opts.animate);
    const durationMs = (opts && opts.durationMs) || REVEAL_MS;
    const matched = [];
    const changes = [];

    Object.entries(state.countryLayers).forEach(([code, layers]) => {
        const name = state.countryNameLookup[code] || code;
        const owned = isOwned(code);
        const show = passesFilters(code, name);
        if (show) matched.push(code);
        // Both halves matter: switching between banknotes and coins can flip a
        // country from the owned colour to the not-owned one without changing
        // whether it is coloured at all.
        const wasShown = state.shownCodes.has(code);
        const wasOwned = state.ownedCodes.has(code);
        // What the country is PAINTED as, which in the photo map is not the
        // same as whether it passes the filters: a country you have nothing
        // from is left uncoloured there, because the photo map is about the
        // photos and a map of red countries competes with them. shownCodes
        // tracks the paint, so turning the photo map on or off is itself a
        // change, and fades like every other change.
        const painted = show && !(state.noteFills && !owned);
        if (animate) {
            if (wasShown !== painted || wasOwned !== owned) {
                changes.push({
                    layers,
                    from: styleFor(wasShown, wasOwned),
                    to: styleFor(painted, owned),
                });
            }
        } else {
            layers.forEach(layer => layer.setStyle(styleFor(painted, owned)));
        }
        if (painted) state.shownCodes.add(code); else state.shownCodes.delete(code);
        if (owned) state.ownedCodes.add(code); else state.ownedCodes.delete(code);
    });

    countryRowEls.forEach((item, code) => {
        item.style.display = passesFilters(code, item.dataset.name) ? 'flex' : 'none';
    });
    refreshLabels();
    // The same filters decide which countries are filled with a photo.
    refreshNoteFills();

    cancelFade();
    if (animate && changes.length) {
        // Settle pass: the canvas renderer can drop a style change under load,
        // leaving a country stuck mid-fade. shownCodes / ownedCodes already
        // hold the correct end state for EVERY code, so once the fade is done
        // re-assert every layer unconditionally - a no-op when nothing was
        // dropped, a fix when something was.
        animateFill(changes, durationMs, () => {
            Object.entries(state.countryLayers).forEach(([code, layers]) => {
                const style = styleFor(state.shownCodes.has(code), state.ownedCodes.has(code));
                layers.forEach(layer => layer.setStyle(style));
            });
        });
    }
    return matched;
}

// ---------- name labels ----------
// Leaflet has no setter for a tooltip's `permanent` flag, so changing it means
// unbind + rebind - but this used to do that for ALL ~250 countries on every
// call, and it is called on every keystroke. state.labelShownCodes remembers
// what is pinned, so only the few that actually flip are touched.
export function refreshLabels() {
    const query = state.searchQuery.trim();
    const isSearching = query !== '';
    const lowered = query.toLowerCase();

    Object.entries(state.countryLayers).forEach(([code, layers]) => {
        const name = state.countryNameLookup[code] || code;
        const shouldShow = state.clickedLabelCodes.has(code) ||
            (isSearching && matchesQuery(code, name, lowered));
        if (state.labelShownCodes.has(code) === shouldShow) return; // unchanged
        layers.forEach(layer => {
            if (layer.getTooltip()) layer.unbindTooltip();
            layer.bindTooltip(name, { permanent: shouldShow, direction: 'center', className: 'country-label' });
        });
        if (shouldShow) state.labelShownCodes.add(code); else state.labelShownCodes.delete(code);
    });
}

// ---------- viewport ----------
// minZoom is recomputed from the ACTUAL viewport every time, rather than being
// a fixed number set once in the constructor: a value tuned for a wide desktop
// window left a narrow phone unable to zoom out far enough to see the whole map.
export function fitFrameToViewport() {
    if (!leafletMap) return;
    const fitZoom = leafletMap.getBoundsZoom(FRAME_BOUNDS, false, L.point(10, 10));
    leafletMap.setMinZoom(fitZoom);
    leafletMap.fitBounds(FRAME_BOUNDS, { padding: [10, 10] });
}

export function focusOnMatches(matched) {
    if (!matched.length || !leafletMap) return;
    const allLayers = matched.flatMap(c => state.countryLayers[c] || []);
    if (!allLayers.length) return;
    if (allLayers.length === 1 && allLayers[0].getBounds) {
        leafletMap.fitBounds(allLayers[0].getBounds(), { maxZoom: 7, padding: [40, 40] });
    } else {
        leafletMap.fitBounds(L.featureGroup(allLayers).getBounds(), { maxZoom: 6, padding: [40, 40] });
    }
}

// Hiding #map with display:none can leave Leaflet's canvas renderer with a
// stale size, so coming back from list view could show a blank map until some
// later pan forced a repaint. The rAF-deferred second call covers browsers
// where layout has not settled on the first.
export function invalidateMapSize() {
    if (!leafletMap) return;
    leafletMap.invalidateSize();
    requestAnimationFrame(() => leafletMap.invalidateSize());
}

export function destroyMap() {
    clearFills();
    fillPane = null;
    fillRenderer = null;
    fillGroup = null;
    fillDefs = null;
    if (leafletMap) { leafletMap.remove(); leafletMap = null; }
}

// ---------- the photo map ----------
// Countries you own something from can be filled with the note or coin you
// picked for them instead of a flat colour.
//
// The map itself is drawn on a CANVAS, which is what keeps 260 countries and
// 63,000 points smooth on a phone - and a canvas cannot fill a shape with an
// image through Leaflet. So the filled countries, and ONLY those, get a second
// polygon in an SVG layer above the canvas: a handful of SVG paths costs
// nothing, where moving the whole map to SVG would not.
let fillPane = null;
let fillRenderer = null;
let fillGroup = null;
let fillDefs = null;
// code -> the image id it is currently drawn with, so a refresh that changes
// nothing does nothing.
const drawnFills = new Map();
// code -> { pattern, image, bounds }, so every photo can be put back in place
// when the map moves.
const patterns = new Map();

const PATTERN_ID = code => 'notefill-' + code;

function ensureFillLayer() {
    if (fillGroup) return;
    // Above the country canvas (overlayPane, 400) and below the name labels
    // (markerPane, 600).
    fillPane = leafletMap.createPane('noteFills');
    fillPane.style.zIndex = 450;
    // The fills are decoration over the real countries: every click, hover and
    // tooltip still belongs to the canvas polygon underneath.
    fillPane.style.pointerEvents = 'none';
    fillRenderer = L.svg({ pane: 'noteFills', padding: 0.2 });
    fillGroup = L.layerGroup([], { pane: 'noteFills' }).addTo(leafletMap);
    fillRenderer.addTo(leafletMap);
    leafletMap.on('zoomend viewreset moveend', repositionFills);
}

function ensureDefs() {
    const svg = fillRenderer && fillRenderer._container;
    if (!svg) return null;
    if (fillDefs && fillDefs.parentNode === svg) return fillDefs;
    fillDefs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
    svg.appendChild(fillDefs);
    return fillDefs;
}

function loadImage(url) {
    return new Promise((resolve, reject) => {
        const probe = new Image();
        probe.onload = () => resolve(probe);
        probe.onerror = () => reject(new Error('image could not be decoded'));
        probe.src = url;
    });
}

// ---------- one side of the note ----------
// A photo in this collection holds BOTH faces of a note, sometimes one above
// the other and sometimes side by side, with a band of pure black between them
// (and often around them). Two faces shrunk into one country show nothing
// legible, so the front is cut out and that is what the country wears.
//
// The band is found rather than assumed: nothing about the photo says which
// way round it was taken, and a rule like "the top half" would cut the
// side-by-side photos down the middle of a face.
const BLACK_MAX = 42;        // a channel value at or under this counts as black
const BLACK_LINE = 0.93;     // how much of a line must be black for it to count
const MIN_SIDE = 0.25;       // a face smaller than this of the photo is not a face

function isBlackAt(data, i) {
    return data[i] <= BLACK_MAX && data[i + 1] <= BLACK_MAX && data[i + 2] <= BLACK_MAX;
}

// Runs of fully black lines inside [lo, hi], as [start, end] pairs.
function blackRuns(fraction, lo, hi) {
    const runs = [];
    let start = -1;
    for (let i = lo; i <= hi; i++) {
        const black = fraction[i] >= BLACK_LINE;
        if (black && start === -1) start = i;
        if ((!black || i === hi) && start !== -1) {
            runs.push([start, black ? i : i - 1]);
            start = -1;
        }
    }
    return runs;
}

// The rectangle holding the FIRST face - the top one, or the left one.
// `img` is ImageData: { data (RGBA), width, height }.
export function frontSideRect(img) {
    const { data, width, height } = img;
    const whole = { x: 0, y: 0, w: width, h: height };
    if (!width || !height) return whole;

    const rowBlack = new Float64Array(height);
    const colBlack = new Float64Array(width);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            if (isBlackAt(data, (y * width + x) * 4)) { rowBlack[y]++; colBlack[x]++; }
        }
    }
    for (let y = 0; y < height; y++) rowBlack[y] /= width;
    for (let x = 0; x < width; x++) colBlack[x] /= height;

    // 1. Drop a black surround, so a photo taken on a black cloth is measured
    //    by its contents and not by its background.
    let y0 = 0, y1 = height - 1, x0 = 0, x1 = width - 1;
    while (y0 < y1 && rowBlack[y0] >= BLACK_LINE) y0++;
    while (y1 > y0 && rowBlack[y1] >= BLACK_LINE) y1--;
    while (x0 < x1 && colBlack[x0] >= BLACK_LINE) x0++;
    while (x1 > x0 && colBlack[x1] >= BLACK_LINE) x1--;
    const inner = { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
    if (inner.w < 2 || inner.h < 2) return whole;

    // 2. Re-measure inside that box: a row is only "black" if it is black
    //    across the CONTENT, not across margins already discounted.
    const rowIn = new Float64Array(height);
    const colIn = new Float64Array(width);
    for (let y = y0; y <= y1; y++) {
        let n = 0;
        for (let x = x0; x <= x1; x++) if (isBlackAt(data, (y * width + x) * 4)) n++;
        rowIn[y] = n / inner.w;
    }
    for (let x = x0; x <= x1; x++) {
        let n = 0;
        for (let y = y0; y <= y1; y++) if (isBlackAt(data, (y * width + x) * 4)) n++;
        colIn[x] = n / inner.h;
    }

    // 3. The separator is the longest black run that leaves a real face on
    //    each side of it.
    const pick = (fraction, lo, hi, size) => {
        let best = null;
        blackRuns(fraction, lo, hi).forEach(([a, b]) => {
            const before = a - lo, after = hi - b;
            if (before < size * MIN_SIDE || after < size * MIN_SIDE) return;
            if (!best || (b - a) > (best[1] - best[0])) best = [a, b];
        });
        return best;
    };
    const hSplit = pick(rowIn, y0, y1, inner.h);   // faces stacked
    const vSplit = pick(colIn, x0, x1, inner.w);   // faces side by side

    // 4. If both look possible, the longer band is the real one.
    const hLen = hSplit ? (hSplit[1] - hSplit[0] + 1) / inner.h : 0;
    const vLen = vSplit ? (vSplit[1] - vSplit[0] + 1) / inner.w : 0;
    if (hSplit && hLen >= vLen) return { x: inner.x, y: y0, w: inner.w, h: hSplit[0] - y0 };
    if (vSplit) return { x: x0, y: inner.y, w: vSplit[0] - x0, h: inner.h };
    return inner;   // one face, or a photo with no separator - keep it whole
}

// Cut once per photo and remembered: the same note can fill a country through
// many repaints, and reading a canvas back is the one expensive step here.
const sideCache = new Map();

async function frontSideOf(imageId, url) {
    if (sideCache.has(imageId)) return sideCache.get(imageId);
    let result = { href: url, aspect: 1 };
    try {
        const img = await loadImage(url);
        const w = img.naturalWidth || 1, h = img.naturalHeight || 1;
        result = { href: url, aspect: w / h };
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(img, 0, 0);
        const rect = frontSideRect(ctx.getImageData(0, 0, w, h));
        if (rect.w >= 2 && rect.h >= 2 && (rect.w !== w || rect.h !== h)) {
            const out = document.createElement('canvas');
            out.width = rect.w; out.height = rect.h;
            out.getContext('2d').drawImage(img, rect.x, rect.y, rect.w, rect.h, 0, 0, rect.w, rect.h);
            result = { href: out.toDataURL('image/jpeg', 0.88), aspect: rect.w / rect.h };
        }
    } catch (err) {
        // A photo that cannot be read back is shown whole rather than not at
        // all - both faces in a country beats an empty country.
        console.warn('Could not cut one side out of', imageId, err);
    }
    sideCache.set(imageId, result);
    return result;
}

// ---------- where the photo sits ----------
// The pattern was measured in objectBoundingBox units - fractions of the
// path's own bounding box - which looks right until you zoom in. Leaflet CLIPS
// a polygon to the visible area, so once part of a country is off screen its
// path's bounding box is the visible piece, not the country, and the photo
// slid to a different part of the note at every zoom.
//
// The box is now measured from the country's real, unclipped bounds, in the
// map's own pixel space, and re-measured whenever the map moves. Clipping the
// path no longer moves anything.
export function layerBox(a, b) {
    return {
        x: Math.min(a.x, b.x),
        y: Math.min(a.y, b.y),
        w: Math.abs(b.x - a.x),
        h: Math.abs(b.y - a.y),
    };
}

function countryBounds(layers) {
    let bounds = null;
    layers.forEach(layer => {
        if (!layer.getBounds) return;
        const b = layer.getBounds();
        bounds = bounds ? bounds.extend(b) : L.latLngBounds(b.getSouthWest(), b.getNorthEast());
    });
    return bounds;
}

function applyPatternBox(entry) {
    if (!leafletMap || !entry || !entry.bounds) return;
    const box = layerBox(
        leafletMap.latLngToLayerPoint(entry.bounds.getNorthWest()),
        leafletMap.latLngToLayerPoint(entry.bounds.getSouthEast()));
    if (!(box.w > 0 && box.h > 0)) return;
    entry.pattern.setAttribute('x', String(box.x));
    entry.pattern.setAttribute('y', String(box.y));
    entry.pattern.setAttribute('width', String(box.w));
    entry.pattern.setAttribute('height', String(box.h));
    entry.image.setAttribute('width', String(box.w));
    entry.image.setAttribute('height', String(box.h));
}

// Leaflet transforms the whole pane during an animated zoom, so the photo
// travels with its country; when the animation ends the renderer re-lays the
// paths out in fresh pixel coordinates, and the pattern has to follow.
function repositionFills() {
    patterns.forEach(applyPatternBox);
}

async function addFill(code, imageId, layers) {
    const url = await mapFillThumbUrl(imageId);
    // The country may have been switched off, or a different photo chosen,
    // while the thumbnail was being read.
    if (drawnFills.get(code) !== imageId || !fillGroup) { return; }

    const defs = ensureDefs();
    if (!defs) return;
    const side = await frontSideOf(imageId, url);
    if (drawnFills.get(code) !== imageId) return;
    const bounds = countryBounds(layers);
    if (!bounds) return;

    const NS = 'http://www.w3.org/2000/svg';
    const pattern = document.createElementNS(NS, 'pattern');
    pattern.setAttribute('id', PATTERN_ID(code));
    pattern.setAttribute('patternUnits', 'userSpaceOnUse');
    const image = document.createElementNS(NS, 'image');
    image.setAttribute('href', side.href);
    image.setAttributeNS('http://www.w3.org/1999/xlink', 'href', side.href); // older WebKit
    image.setAttribute('x', '0');
    image.setAttribute('y', '0');
    // The note COVERS the country rather than sitting inside it: it is scaled
    // until no part of the country is left bare, and the country's outline
    // crops what hangs over. In real pixel space the browser can do this
    // itself, correctly, which is what "slice" means.
    image.setAttribute('preserveAspectRatio', 'xMidYMid slice');
    pattern.appendChild(image);
    defs.appendChild(pattern);
    const entry = { pattern, image, bounds };
    patterns.set(code, entry);
    applyPatternBox(entry);

    layers.forEach(layer => {
        if (!layer.getLatLngs) return;
        L.polygon(layer.getLatLngs(), {
            renderer: fillRenderer,
            pane: 'noteFills',
            interactive: false,
            // Exactly the border every other country is drawn with, so a
            // filled country does not sit on the map in a heavier outline
            // than its neighbours - a photo already sets it apart.
            color: COUNTRY_BORDER.color,
            weight: COUNTRY_BORDER.weight,
            opacity: 1,
            fillColor: `url(#${PATTERN_ID(code)})`,
            fillOpacity: 1,
            className: 'note-fill',
        }).addTo(fillGroup);
    });
}

function clearFills() {
    drawnFills.clear();
    patterns.clear();
    if (fillGroup) fillGroup.clearLayers();
    if (fillDefs) fillDefs.innerHTML = '';
    releaseMapFillUrls();
}

function isShownItem(code, imageId) {
    const entry = state.cvCountryMap[code];
    if (!entry) return false;
    const shown = filterEntry(entry, state.itemType);
    if (!shown) return false;
    if (shown.own.some(i => i.id === imageId)) return true;
    return Object.values(shown.historical || {}).some(list => list.some(i => i.id === imageId));
}

// Rebuilt rather than patched: the set is small, and the alternative is
// tracking which country changed for which of half a dozen reasons.
export function refreshNoteFills() {
    if (!leafletMap) return;
    if (!state.noteFills) { clearFills(); return; }
    ensureFillLayer();

    const wanted = new Map();
    Object.entries(state.countryLayers).forEach(([code, layers]) => {
        if (!isOwned(code)) return;
        if (!passesFilters(code, state.countryNameLookup[code] || code)) return;
        const imageId = getCountryBackgroundId(code);
        // The chosen photo must be one the view is actually showing: a
        // banknote picked for a country must not go on filling it while the
        // map is switched to coins.
        if (imageId && isShownItem(code, imageId)) wanted.set(code, { imageId, layers });
    });

    let same = wanted.size === drawnFills.size;
    if (same) for (const [code, w] of wanted) if (drawnFills.get(code) !== w.imageId) { same = false; break; }
    if (same) return;

    if (fillGroup) fillGroup.clearLayers();
    if (fillDefs) fillDefs.innerHTML = '';
    drawnFills.clear();
    patterns.clear();
    wanted.forEach((w, code) => {
        drawnFills.set(code, w.imageId);
        addFill(code, w.imageId, w.layers).catch(err => console.warn('Could not fill', code, err));
    });
}

// ---------- construction ----------
export async function initMap() {
    state.countryLayers = {};
    state.countryNameLookup = {};
    state.labelShownCodes = new Set();
    state.shownCodes = new Set();
    state.ownedCodes = new Set();

    leafletMap = L.map('map', {
        preferCanvas: true,
        // CRS.Simple: the boundaries are projected to Equal Earth ONCE when
        // they are loaded (see geo.js), and Leaflet is then just a pan/zoom
        // surface over that flat plane. A custom L.CRS would need the inverse
        // projection on every pan, and Equal Earth has no closed-form inverse.
        crs: L.CRS.Simple,
        // Without this the map fits the window a whole zoom step short of
        // filling it. CRS.Simple doubles the scale per zoom level and Leaflet
        // snaps to whole levels by default, so a frame that needs 3.2x is
        // drawn at 2x - half the screen wasted. There are no zoom buttons to
        // make awkward, so exact fitting costs nothing.
        zoomSnap: 0,
        worldCopyJump: false,
        maxBounds: FRAME_BOUNDS,
        maxBoundsViscosity: 1.0,
        zoomControl: false,
        // Leaflet's own badge in the bottom-right corner ("Leaflet", with a
        // Ukrainian flag since 1.9). It exists to credit map-TILE providers,
        // and this map uses no tiles at all - every country is drawn from the
        // GeoJSON file in this repo - so there is nothing there to credit, and
        // a flag in the corner of an antique map is simply out of place.
        // Leaflet's BSD-2 licence asks for the copyright notice to be kept in
        // the source, which it is (see the comment on the script tag in
        // index.html and the header of leaflet.js), not on screen.
        attributionControl: false
    }).setView([0, 0], 1);

    const features = await getProjectedFeatures();

    function register(code, name, layer) {
        if (!state.countryLayers[code]) state.countryLayers[code] = [];
        state.countryLayers[code].push(layer);
        state.countryNameLookup[code] = name;

        layer.bindTooltip(name, { direction: 'center', className: 'country-label' });
        // Decided at CLICK time, not here. Whether a country has anything in it
        // now depends on whether banknotes, coins or both are selected, so a
        // handler chosen once at build time would go on opening an empty modal
        // for a country whose only items were just filtered out.
        layer.on('click', () => {
            if (isOwned(code)) { openModal(code); return; }
            // Nothing to open, so clicking pins the name label instead (click
            // again to unpin) - the touch equivalent of hovering.
            if (state.clickedLabelCodes.has(code)) state.clickedLabelCodes.delete(code);
            else state.clickedLabelCodes.add(code);
            refreshLabels();
        });
        layer.on('mouseover', function () {
            if (isOwned(code) && passesFilters(code, name)) this.setStyle({ fillOpacity: 0.9 });
        });
        layer.on('mouseout', function () {
            if (isOwned(code) && passesFilters(code, name)) this.setStyle({ fillOpacity: 0.65 });
        });
    }

    // Every country is one polygon layer, at any size. There is no longer a
    // minimum-area threshold and no separate marker path: the micro-states are
    // drawn like everything else, so they are present in "None yet", in the
    // list, and in the world total. At world zoom the smallest are sub-pixel -
    // zoom in, or search for one by name, and it is there.
    L.geoJSON({ type: 'FeatureCollection', features }, {
        style: {
            weight: COUNTRY_BORDER.weight, color: COUNTRY_BORDER.color,
            fillColor: MUTED_COLOR, fillOpacity: 0.1,
        },
        onEachFeature: (feature, layer) => {
            register(canonicalCode(getCodeForFeature(feature)), feature.properties['name'], layer);
        }
    }).addTo(leafletMap);

    buildMapFrame().addTo(leafletMap);

    const compassSvgEl = new DOMParser().parseFromString(COMPASS_ROSE_SVG, 'image/svg+xml').documentElement;
    L.svgOverlay(compassSvgEl, COMPASS_BOUNDS, {
        interactive: false, className: 'compass-rose-overlay'
    }).addTo(leafletMap);

    applyFilters({ animate: true });
    fitFrameToViewport();
}
