// World-boundary loading, the Mercator maths the antique frame depends on, and
// the frame/compass geometry itself.

import {
    FRAME_COLOR, FRAME_LIGHT_COLOR, MAP_BG_COLOR, MUTED_COLOR, BORDER_COLOR
} from './config.js';

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

// ---------- the map as a standalone SVG ----------
// The exported file is opened without this app, so it cannot use Leaflet: the
// cover map is drawn here from the same GeoJSON and the same Mercator maths the
// live map uses, as plain SVG path data with the colours written in.
//
// Coordinates are rounded to one decimal and points closer together than
// SIMPLIFY_PX are dropped. On a 1100px-wide map that is invisible, and it is
// the difference between a couple of megabytes of path data and a few hundred
// kilobytes - which matters in a file that already carries every photo.
const SIMPLIFY_PX = 0.6;

function ringToPath(ring, px, py) {
    let d = '';
    let lastX = null, lastY = null;
    for (let i = 0; i < ring.length; i++) {
        const x = px(ring[i][0]);
        const y = py(ring[i][1]);
        const keep = lastX === null ||
            Math.abs(x - lastX) >= SIMPLIFY_PX || Math.abs(y - lastY) >= SIMPLIFY_PX ||
            i === ring.length - 1;
        if (!keep) continue;
        d += (lastX === null ? 'M' : 'L') + x.toFixed(1) + ' ' + y.toFixed(1);
        lastX = x; lastY = y;
    }
    return d ? d + 'Z' : '';
}

function featurePath(geometry, px, py) {
    const polys = geometry.type === 'Polygon' ? [geometry.coordinates]
        : geometry.type === 'MultiPolygon' ? geometry.coordinates : [];
    return polys.map(rings => rings.map(r => ringToPath(r, px, py)).join('')).join('');
}

// `fillFor(code)` returns { fill, opacity } for one country.
export async function buildWorldSvg(fillFor, opts) {
    const width = (opts && opts.width) || 1100;
    const features = await getGeoFeatures();

    const yMin = mercatorY(FRAME_LAT_MIN), yMax = mercatorY(FRAME_LAT_MAX);
    const lonSpan = FRAME_LON_MAX - FRAME_LON_MIN;
    const ySpan = yMax - yMin;
    const height = Math.round(width * ySpan / lonSpan);

    // The world wraps at the Bering Strait, so anything west of the left edge
    // belongs on the right-hand side of this map, not off it.
    const normLon = lon => (lon < FRAME_LON_MIN ? lon + 360 : lon);
    const px = lon => ((normLon(lon) - FRAME_LON_MIN) / lonSpan) * width;
    // Clamped before projecting: mercatorY(90) is infinite.
    const py = lat => ((yMax - mercatorY(Math.max(-85, Math.min(85, lat)))) / ySpan) * height;

    let out = `<svg viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg" ` +
              `width="100%" role="img" aria-label="World map of this collection">`;
    out += `<rect x="0" y="0" width="${width}" height="${height}" fill="${MAP_BG_COLOR}"/>`;

    features.forEach(f => {
        const code = getCodeForFeature(f);
        if (!code) return;
        const d = featurePath(f.geometry, px, py);
        if (!d) return;
        const style = fillFor(code) || {};
        out += `<path d="${d}" fill="${style.fill || MUTED_COLOR}" fill-opacity="${style.opacity == null ? 0.18 : style.opacity}" ` +
               `stroke="${BORDER_COLOR}" stroke-width="0.5"/>`;
    });

    // The grid, then the striped border on top of it - same geometry as the
    // live map's frame, so the cover is recognisably the same picture.
    const latInnerTop = inverseMercatorY(yMax - FRAME_BAND_THICKNESS);
    const latInnerBottom = inverseMercatorY(yMin + FRAME_BAND_THICKNESS);
    const lonInnerLeft = FRAME_LON_MIN + FRAME_BAND_THICKNESS;
    const lonInnerRight = FRAME_LON_MAX - FRAME_BAND_THICKNESS;

    out += `<g stroke="${FRAME_COLOR}" stroke-width="0.6" opacity="0.4" fill="none">`;
    meridianLons().forEach(lon => {
        out += `<line x1="${px(lon).toFixed(1)}" y1="${py(latInnerTop).toFixed(1)}" ` +
               `x2="${px(lon).toFixed(1)}" y2="${py(latInnerBottom).toFixed(1)}"/>`;
    });
    parallelYs().forEach(y => {
        const lat = inverseMercatorY(y);
        out += `<line x1="${px(lonInnerLeft).toFixed(1)}" y1="${py(lat).toFixed(1)}" ` +
               `x2="${px(lonInnerRight).toFixed(1)}" y2="${py(lat).toFixed(1)}"/>`;
    });
    out += `</g>`;

    const rect = (lat0, lon0, lat1, lon1, fill, opacity) => {
        const x = px(lon0), y = py(lat1), w = px(lon1) - x, h = py(lat0) - y;
        return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${Math.abs(w).toFixed(1)}" ` +
               `height="${Math.abs(h).toFixed(1)}" fill="${fill}" fill-opacity="${opacity}" ` +
               `stroke="${FRAME_COLOR}" stroke-width="0.8"/>`;
    };

    const nHoriz = Math.max(4, Math.round(lonSpan / FRAME_STRIPE_LEN));
    for (let i = 0; i < nHoriz; i++) {
        const lon0 = FRAME_LON_MIN + (lonSpan * i) / nHoriz;
        const lon1 = FRAME_LON_MIN + (lonSpan * (i + 1)) / nHoriz;
        const dark = i % 2 === 0;
        out += rect(latInnerTop, lon0, FRAME_LAT_MAX, lon1, dark ? FRAME_COLOR : FRAME_LIGHT_COLOR, dark ? 0.85 : 1);
        out += rect(FRAME_LAT_MIN, lon0, latInnerBottom, lon1, dark ? FRAME_COLOR : FRAME_LIGHT_COLOR, dark ? 0.85 : 1);
    }
    const nVert = Math.max(4, Math.round(ySpan / FRAME_STRIPE_LEN));
    for (let i = 0; i < nVert; i++) {
        const lat0 = inverseMercatorY(yMin + (ySpan * i) / nVert);
        const lat1 = inverseMercatorY(yMin + (ySpan * (i + 1)) / nVert);
        const dark = i % 2 === 0;
        out += rect(lat0, FRAME_LON_MIN, lat1, lonInnerLeft, dark ? FRAME_COLOR : FRAME_LIGHT_COLOR, dark ? 0.85 : 1);
        out += rect(lat0, lonInnerRight, lat1, FRAME_LON_MAX, dark ? FRAME_COLOR : FRAME_LIGHT_COLOR, dark ? 0.85 : 1);
    }

    out += '</svg>';
    return { svg: out, width, height };
}
