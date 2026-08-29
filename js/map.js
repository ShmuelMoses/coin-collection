// The Leaflet map: countries, the antique frame, colouring and labels.

import { MUTED_COLOR, BORDER_COLOR, styleFor, REVEAL_MS } from './config.js';
import { state, passesFilters, matchesQuery, isOwned } from './state.js';
import {
    getGeoFeatures, getCodeForFeature, isTinyTerritory, featureCenter,
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
// `animate` gives the "filling in / erasing country by country" transition in
// random order over durationMs. Only countries that actually CHANGE are
// animated - state.shownCodes remembers what is on screen - so each call only
// touches what is different. Typing in the search box colours instantly;
// animating that too would make it feel laggy.
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
        if (animate) {
            if (state.shownCodes.has(code) !== show) changes.push({ layers, owned, toShow: show });
        } else {
            layers.forEach(layer => layer.setStyle(styleFor(show, owned)));
        }
        if (show) state.shownCodes.add(code); else state.shownCodes.delete(code);
    });

    countryRowEls.forEach((item, code) => {
        item.style.display = passesFilters(code, item.dataset.name) ? 'flex' : 'none';
    });
    refreshLabels();

    if (animate && changes.length) {
        for (let i = changes.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [changes[i], changes[j]] = [changes[j], changes[i]];
        }
        const step = durationMs / changes.length;
        changes.forEach((entry, idx) => {
            setTimeout(() => {
                entry.layers.forEach(layer => layer.setStyle(styleFor(entry.toShow, entry.owned)));
            }, idx * step);
        });
        // Settle pass: dozens of setStyle calls land close together across
        // these staggered timeouts, and on slower devices the canvas renderer
        // can drop one, leaving a country stuck in its old colour.
        // state.shownCodes already holds the correct end state for EVERY code,
        // so once the animation is done re-assert every layer unconditionally -
        // a cheap no-op when nothing was dropped, a fix when something was.
        setTimeout(() => {
            Object.entries(state.countryLayers).forEach(([code, layers]) => {
                layers.forEach(layer => layer.setStyle(styleFor(state.shownCodes.has(code), isOwned(code))));
            });
        }, durationMs + 50);
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
        if (isOwned(code)) {
            layer.on('click', () => openModal(code));
            layer.on('mouseover', function () {
                if (passesFilters(code, name)) this.setStyle({ fillOpacity: 0.9 });
            });
            layer.on('mouseout', function () {
                if (passesFilters(code, name)) this.setStyle({ fillOpacity: 0.65 });
            });
        } else {
            // Nothing to open, so clicking pins the name label instead (click
            // again to unpin) - the touch equivalent of hovering.
            layer.on('click', () => {
                if (state.clickedLabelCodes.has(code)) state.clickedLabelCodes.delete(code);
                else state.clickedLabelCodes.add(code);
                refreshLabels();
            });
        }
    }

    const polygonFeatures = [];
    const tinyFeatures = [];
    features.forEach(f => (isTinyTerritory(f) ? tinyFeatures : polygonFeatures).push(f));

    L.geoJSON({ type: 'FeatureCollection', features: polygonFeatures }, {
        style: { weight: 0.6, color: BORDER_COLOR, fillColor: MUTED_COLOR, fillOpacity: 0.1 },
        onEachFeature: (feature, layer) => {
            register(canonicalCode(getCodeForFeature(feature)), feature.properties['name'], layer);
        }
    }).addTo(leafletMap);

    // Territories whose outline is smaller than a pixel at world zoom get a
    // fixed-size dot instead. They used to be dropped from the map entirely
    // unless you owned them, so the map could never show you a country you were
    // still missing - Malta, Singapore, Bahrain and most of the micro-states
    // simply did not exist in "None yet" view.
    tinyFeatures.forEach(feature => {
        const code = canonicalCode(getCodeForFeature(feature));
        if (!code) return;
        const marker = L.circleMarker(featureCenter(feature.geometry), {
            radius: 4, weight: 1, color: BORDER_COLOR,
            fillColor: MUTED_COLOR, fillOpacity: 0.1
        }).addTo(leafletMap);
        register(code, feature.properties['name'], marker);
    });

    buildMapFrame().addTo(leafletMap);

    const compassSvgEl = new DOMParser().parseFromString(COMPASS_ROSE_SVG, 'image/svg+xml').documentElement;
    L.svgOverlay(compassSvgEl, COMPASS_BOUNDS, {
        interactive: false, className: 'compass-rose-overlay'
    }).addTo(leafletMap);

    applyFilters({ animate: true });
    fitFrameToViewport();
}
