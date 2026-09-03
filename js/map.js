// The Leaflet map: countries, the antique frame, colouring and labels.

import { MUTED_COLOR, BORDER_COLOR, styleFor, REVEAL_MS } from './config.js';
import { state, passesFilters, matchesQuery, isOwned } from './state.js';
import {
    getGeoFeatures, getCodeForFeature,
    buildMapFrame, FRAME_BOUNDS, COMPASS_BOUNDS
} from './geo.js';
import { canonicalCode } from './countries.js';
import { openModal } from './modal.js';
import { countryRowEls } from './list.js';

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
// Smoothstep: no hard start or stop, so the whole map eases in together
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

// Every country changes colour AT THE SAME TIME, over durationMs. It used to
// be a staggered reveal - one country every durationMs/N - which on a large
// collection meant watching the map fill in one country at a time.
function animateFill(changes, durationMs, onDone) {
    const specs = changes.map(ch => ({
        layers: ch.layers,
        fromRgb: parseColor(ch.from.fillColor),
        toRgb: parseColor(ch.to.fillColor),
        fromOpacity: ch.from.fillOpacity,
        toOpacity: ch.to.fillOpacity,
        to: ch.to,
    }));

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
        const t = durationMs > 0 ? Math.min(1, (now - started) / durationMs) : 1;
        if (t >= 1) { finish(); return; }
        if (now - lastPainted >= MIN_FRAME_MS) {
            lastPainted = now;
            const e = ease(t);
            specs.forEach(s => {
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

// `animate` cross-fades every country that changes, all together, over
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
        if (animate) {
            if (wasShown !== show || wasOwned !== owned) {
                changes.push({
                    layers,
                    from: styleFor(wasShown, wasOwned),
                    to: styleFor(show, owned),
                });
            }
        } else {
            layers.forEach(layer => layer.setStyle(styleFor(show, owned)));
        }
        if (show) state.shownCodes.add(code); else state.shownCodes.delete(code);
        if (owned) state.ownedCodes.add(code); else state.ownedCodes.delete(code);
    });

    countryRowEls.forEach((item, code) => {
        item.style.display = passesFilters(code, item.dataset.name) ? 'flex' : 'none';
    });
    refreshLabels();

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
    if (leafletMap) { leafletMap.remove(); leafletMap = null; }
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
        worldCopyJump: false,
        maxBounds: [[-90, -169], [90, 191]],
        maxBoundsViscosity: 1.0,
        zoomControl: false
    }).setView([20, 10], 2);

    const features = await getGeoFeatures();

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
        style: { weight: 0.6, color: BORDER_COLOR, fillColor: MUTED_COLOR, fillOpacity: 0.1 },
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
