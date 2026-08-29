// World-boundary loading, the Mercator maths the antique frame depends on, and
// the frame/compass geometry itself.

import { FRAME_COLOR, FRAME_LIGHT_COLOR } from './config.js';

// ---------- feature identity and filtering ----------
// countries.geojson stores "-99" for anything without a real ISO code. Most of
// those are not places you can collect from - reefs, sand banks, ice fields,
// military bases - but a few are, so they get an explicit code here. Without
// this they ALL resolved to the same "-99" key and collided into a single
// bogus map entry, which also produced one junk row in the list view.
const NAME_TO_CODE_OVERRIDE = {
    'France': 'FRA',
    'Norway': 'NOR',
    'Somaliland': 'SLD',
    'Kosovo': 'KSV',           // referenced by the EUR group in multi_country_currencies
    'Northern Cyprus': 'CYN',
};

export function getCodeForFeature(feature) {
    const rawCode = feature.properties['ISO3166-1-Alpha-3'];
    const name = feature.properties['name'];
    if (rawCode && rawCode !== '-99') return rawCode;
    return NAME_TO_CODE_OVERRIDE[name] || null;
}

export function bboxArea(geometry) {
    let minLat = 90, maxLat = -90, minLng = 180, maxLng = -180;
    (function walk(coords) {
        if (typeof coords[0] === 'number') {
            const [lng, lat] = coords;
            if (lat < minLat) minLat = lat; if (lat > maxLat) maxLat = lat;
            if (lng < minLng) minLng = lng; if (lng > maxLng) maxLng = lng;
        } else { coords.forEach(walk); }
    })(geometry.coordinates);
    return (maxLat - minLat) * (maxLng - minLng);
}

// EVERY country is drawn, at any size. There used to be a minimum-area
// threshold that hid ~17 micro-states unless you already owned them, so the
// map could never show you a country you were still missing - Malta,
// Singapore, Monaco, San Marino, the Caribbean states and so on simply did not
// exist in "None yet" view. The only things filtered now are Antarctica
// (nothing is ever collected there, and it eats the whole southern view) and
// features with no usable country code.
export function featureFilter(feature) {
    if (feature.properties['name'] === 'Antarctica') return false;
    return !!getCodeForFeature(feature);
}

// ---------- the boundaries file ----------
// Only the PARSED FILE is cached, never the filtered result: the filter depends
// on which countries are owned, so caching the filtered array meant the first
// collection opened in a session decided the map for every collection after it.
let cachedGeoJson = null;

export async function getGeoFeatures() {
    if (!cachedGeoJson) {
        cachedGeoJson = await fetch('countries.geojson').then(r => r.json());
    }
    return cachedGeoJson.features.filter(featureFilter);
}

// ---------- Mercator ----------
// A fixed number of DEGREES is not a fixed distance on screen: Mercator
// stretches latitude by 1/cos(lat), so a band near the pole renders far taller
// than the same band at the equator. Everything about the frame - border
// thickness, stripe length, grid spacing - is therefore computed in PROJECTED
// space and converted back to a latitude only at the moment of drawing.
export function mercatorY(latDeg) {
    const rad = latDeg * Math.PI / 180;
    return Math.log(Math.tan(Math.PI / 4 + rad / 2)) * 180 / Math.PI;
}

export function inverseMercatorY(y) {
    const rad = 2 * Math.atan(Math.exp(y * Math.PI / 180)) - Math.PI / 2;
    return rad * 180 / Math.PI;
}

export const FRAME_LAT_MIN = -60, FRAME_LAT_MAX = 84;
// Longitude runs -169..191 rather than -180..180: the world wraps at the Bering
// Strait (open water) instead of through the middle of Russia.
export const FRAME_LON_MIN = -169, FRAME_LON_MAX = 191;
export const FRAME_BOUNDS = [[FRAME_LAT_MIN, FRAME_LON_MIN], [FRAME_LAT_MAX, FRAME_LON_MAX]];

// ONE step for both grid directions, in projected units. Longitude degrees are
// already unstretched, so this is 30 degrees of longitude horizontally;
// vertically it is 30 units of PROJECTED y, deliberately not 30 degrees of
// latitude. Stepping the parallels by a fixed number of degrees is what made
// the spacing look wrong - the 60-to-80 band came out three times taller than
// every other one, which reads as a missing line in the middle of it.
export const GRID_STEP = 30;
export const FRAME_BAND_THICKNESS = 1.6; // projected units, same scale as longitude degrees
export const FRAME_STRIPE_LEN = 12;

// Compass rose: centred exactly on a grid intersection, in open South Pacific
// water. Both coordinates are DERIVED from the grid rather than written as
// literals, so they cannot silently drift off an intersection if the grid step
// changes. The latitude is whichever one the parallel at projected y =
// -GRID_STEP falls on (about -28.7 degrees, near Easter Island) - it is NOT
// -30 degrees, because the grid is spaced in projected space.
export const COMPASS_CENTER_LAT = inverseMercatorY(-GRID_STEP);
export const COMPASS_CENTER_LON = -4 * GRID_STEP; // -120
export const COMPASS_HALF_SIZE = 11;
export const COMPASS_BOUNDS = [
    [COMPASS_CENTER_LAT - COMPASS_HALF_SIZE, COMPASS_CENTER_LON - COMPASS_HALF_SIZE],
    [COMPASS_CENTER_LAT + COMPASS_HALF_SIZE, COMPASS_CENTER_LON + COMPASS_HALF_SIZE]
];

// Returns the projected-y positions of every parallel the grid should draw.
// Exported so it can be asserted on directly in the tests.
export function parallelYs() {
    const yMin = mercatorY(FRAME_LAT_MIN), yMax = mercatorY(FRAME_LAT_MAX);
    const yBottomLimit = yMin + FRAME_BAND_THICKNESS;
    const yTopLimit = yMax - FRAME_BAND_THICKNESS;
    const ys = [];
    // k = 0 is the equator, so it is always a ruled line as on a real map, and
    // every other parallel is a whole number of steps from it.
    for (let k = Math.ceil(yBottomLimit / GRID_STEP); k * GRID_STEP < yTopLimit; k++) {
        const y = k * GRID_STEP;
        if (y <= yBottomLimit || y >= yTopLimit) continue;
        ys.push(y);
    }
    return ys;
}

export function meridianLons() {
    const lonInnerLeft = FRAME_LON_MIN + FRAME_BAND_THICKNESS;
    const lonInnerRight = FRAME_LON_MAX - FRAME_BAND_THICKNESS;
    const lons = [];
    for (let lon = Math.ceil(FRAME_LON_MIN / GRID_STEP) * GRID_STEP; lon < FRAME_LON_MAX; lon += GRID_STEP) {
        if (lon <= lonInnerLeft || lon >= lonInnerRight) continue;
        lons.push(lon);
    }
    return lons;
}

// Builds the striped border + lat/long grid as a Leaflet layerGroup.
//
// Rendered on its own SVG renderer rather than the shared canvas the country
// polygons use. That was originally added while chasing a "grid line near the
// pole is missing" report, on the theory that the canvas was dropping it - that
// theory was wrong (the line was always drawn; the problem was spacing, see
// GRID_STEP). It is kept because SVG renders these hairlines more crisply, and
// ~40 elements is far too few for the canvas performance argument to apply.
export function buildMapFrame() {
    const frameRenderer = L.svg({ padding: 2 });
    const group = L.layerGroup();
    const lineStyle = { color: FRAME_COLOR, weight: 1, opacity: 0.8, interactive: false, fill: false, renderer: frameRenderer };
    const gridStyle = { color: FRAME_COLOR, weight: 0.6, opacity: 0.4, interactive: false, fill: false, renderer: frameRenderer };

    function stripe(bounds, dark) {
        L.rectangle(bounds, {
            color: FRAME_COLOR, weight: 1, opacity: 0.8,
            fillColor: dark ? FRAME_COLOR : FRAME_LIGHT_COLOR, fillOpacity: dark ? 0.85 : 1,
            interactive: false, renderer: frameRenderer
        }).addTo(group);
    }

    const yMin = mercatorY(FRAME_LAT_MIN), yMax = mercatorY(FRAME_LAT_MAX);
    const latInnerTop = inverseMercatorY(yMax - FRAME_BAND_THICKNESS);
    const latInnerBottom = inverseMercatorY(yMin + FRAME_BAND_THICKNESS);
    const lonInnerLeft = FRAME_LON_MIN + FRAME_BAND_THICKNESS;
    const lonInnerRight = FRAME_LON_MAX - FRAME_BAND_THICKNESS;

    // Top and bottom bands: stripes evenly spaced in longitude - the x scale
    // does not depend on latitude, so no correction is needed here.
    const lonSpan = FRAME_LON_MAX - FRAME_LON_MIN;
    const nHoriz = Math.max(4, Math.round(lonSpan / FRAME_STRIPE_LEN));
    for (let i = 0; i < nHoriz; i++) {
        const lon0 = FRAME_LON_MIN + (lonSpan * i) / nHoriz;
        const lon1 = FRAME_LON_MIN + (lonSpan * (i + 1)) / nHoriz;
        const dark = i % 2 === 0;
        stripe([[latInnerTop, lon0], [FRAME_LAT_MAX, lon1]], dark);
        stripe([[FRAME_LAT_MIN, lon0], [latInnerBottom, lon1]], dark);
    }
    // Left and right bands: stripes evenly spaced in PROJECTED y, so each
    // covers the same visual length instead of growing near the poles.
    const ySpan = yMax - yMin;
    const nVert = Math.max(4, Math.round(ySpan / FRAME_STRIPE_LEN));
    for (let i = 0; i < nVert; i++) {
        const lat0 = inverseMercatorY(yMin + (ySpan * i) / nVert);
        const lat1 = inverseMercatorY(yMin + (ySpan * (i + 1)) / nVert);
        const dark = i % 2 === 0;
        stripe([[lat0, FRAME_LON_MIN], [lat1, lonInnerLeft]], dark);
        stripe([[lat0, lonInnerRight], [lat1, FRAME_LON_MAX]], dark);
    }

    // Thin rule separating the striped border from the map content
    L.polyline([
        [latInnerBottom, lonInnerLeft], [latInnerBottom, lonInnerRight],
        [latInnerTop, lonInnerRight], [latInnerTop, lonInnerLeft],
        [latInnerBottom, lonInnerLeft]
    ], lineStyle).addTo(group);

    meridianLons().forEach(lon => {
        L.polyline([[latInnerBottom, lon], [latInnerTop, lon]], gridStyle).addTo(group);
    });
    parallelYs().forEach(y => {
        const lat = inverseMercatorY(y);
        L.polyline([[lat, lonInnerLeft], [lat, lonInnerRight]], gridStyle).addTo(group);
    });

    return group;
}
