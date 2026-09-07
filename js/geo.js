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

// ---------- Equal Earth ----------
// The map is drawn on the Equal Earth projection (Savric, Patterson & Jenny,
// 2018), which the UN General Assembly voted on 4 September 2026 to recommend
// wherever the relative size of countries matters. That is exactly what this
// map is for: it is a picture of which countries you have and which you do
// not, and on Mercator, Greenland reads as the size of Africa when it is a
// fourteenth of it - so Canada, Russia and Greenland dominated a picture that
// is supposed to be about proportion.
//
// Every web map uses Mercator because square tiles have to line up. This one
// draws its own polygons from countries.geojson and loads no tiles at all, so
// that reason never applied here.
//
// The projection is applied ONCE, when the boundaries are loaded, and Leaflet
// then runs on L.CRS.Simple over the resulting flat plane. The alternative -
// a custom L.CRS - would need the inverse projection on every pan, and Equal
// Earth has no closed-form inverse: it needs Newton iteration.
const EE_A1 = 1.340264, EE_A2 = -0.081106, EE_A3 = 0.000893, EE_A4 = 0.003796;
const EE_M = Math.sqrt(3) / 2;

// The world wraps at the Bering Strait rather than through the middle of
// Russia, exactly as before - now expressed as the projection's central
// meridian instead of a shifted longitude range.
export const CENTRAL_MERIDIAN = 11;
export const LON_MIN = CENTRAL_MERIDIAN - 180;
export const LON_MAX = CENTRAL_MERIDIAN + 180;

// Scaled so the world is 360 units wide, the same as the old longitude range.
// That keeps every frame constant below (band thickness, stripe length, grid
// step) meaning what it always meant, and keeps the zoom levels familiar.
const EE_HALF_WIDTH = Math.PI / (EE_M * EE_A1);   // x at lon 180, on the equator
const PROJ_SCALE = 180 / EE_HALF_WIDTH;

// Anything west of the seam belongs on the far side of this map, not off it.
export function normaliseLon(lon) {
    let l = lon;
    while (l < LON_MIN) l += 360;
    while (l > LON_MAX) l -= 360;
    return l;
}

// [lon, lat] in degrees -> [x, y] in projected units, y positive north.
export function project(lon, lat) {
    const lam = (normaliseLon(lon) - CENTRAL_MERIDIAN) * Math.PI / 180;
    const phi = Math.max(-90, Math.min(90, lat)) * Math.PI / 180;
    const th = Math.asin(EE_M * Math.sin(phi));
    const th2 = th * th, th6 = th2 * th2 * th2;
    const x = lam * Math.cos(th) /
        (EE_M * (EE_A1 + 3 * EE_A2 * th2 + th6 * (7 * EE_A3 + 9 * EE_A4 * th2)));
    const y = th * (EE_A1 + EE_A2 * th2 + th6 * (EE_A3 + EE_A4 * th2));
    return [x * PROJ_SCALE, y * PROJ_SCALE];
}

// The half-width of the world at one latitude. Equal Earth is a lens, not a
// rectangle: this is what the parallels are drawn across, and what leaves the
// corners of the frame empty.
export function halfWidthAt(lat) {
    return project(LON_MAX, lat)[0];
}

// ---------- the projected boundaries ----------
// Projected once and memoised. Leaflet reads GeoJSON as [lng, lat] and, under
// CRS.Simple, uses those numbers as plain x / y - so the projected pair goes
// straight into the same slots.
let projectedCache = null;

export async function getProjectedFeatures() {
    if (projectedCache) return projectedCache;
    const features = await getGeoFeatures();
    const mapCoords = c => (typeof c[0] === 'number')
        ? project(c[0], c[1])
        : c.map(mapCoords);
    projectedCache = features.map(f => ({
        type: 'Feature',
        properties: f.properties,
        geometry: { type: f.geometry.type, coordinates: mapCoords(f.geometry.coordinates) },
    }));
    return projectedCache;
}

// ---------- the frame ----------
// Latitudes the map is drawn between. Equal Earth compresses the high
// latitudes on its own, so this is now only about not leaving a band of empty
// ocean at the bottom where Antarctica would have been.
export const FRAME_LAT_MIN = -58, FRAME_LAT_MAX = 84;

// A rectangle around the whole lens, with a little air. The world touches the
// left and right bands only at the equator; above and below that the corners
// are empty, which is what a pseudocylindrical map looks like in a rectangular
// frame - and is the honest shape of the projection rather than a crop of it.
const FRAME_PAD = 11;
export const FRAME_X_MAX = 180 + FRAME_PAD;
export const FRAME_X_MIN = -FRAME_X_MAX;
export const FRAME_Y_MAX = project(CENTRAL_MERIDIAN, FRAME_LAT_MAX)[1] + FRAME_PAD;
export const FRAME_Y_MIN = project(CENTRAL_MERIDIAN, FRAME_LAT_MIN)[1] - FRAME_PAD;

// Leaflet bounds are [[lat, lng]] = [[y, x]] under CRS.Simple.
export const FRAME_BOUNDS = [[FRAME_Y_MIN, FRAME_X_MIN], [FRAME_Y_MAX, FRAME_X_MAX]];

export const FRAME_BAND_THICKNESS = 3.4; // projected units
export const FRAME_STRIPE_LEN = 12;
export const GRID_STEP = 30;             // degrees, for both parallels and meridians

export const INNER_X_MIN = FRAME_X_MIN + FRAME_BAND_THICKNESS;
export const INNER_X_MAX = FRAME_X_MAX - FRAME_BAND_THICKNESS;
export const INNER_Y_MIN = FRAME_Y_MIN + FRAME_BAND_THICKNESS;
export const INNER_Y_MAX = FRAME_Y_MAX - FRAME_BAND_THICKNESS;

// Parallels are straight lines on any pseudocylindrical projection, so these
// are plain latitudes at an even spacing - and unlike Mercator, an even
// spacing in DEGREES is also an even spacing on screen here, which is what
// went wrong the first time round (see the GRID_STEP history).
export function parallelLats() {
    const lats = [];
    for (let lat = -90 + GRID_STEP; lat < 90; lat += GRID_STEP) {
        if (lat <= FRAME_LAT_MIN || lat >= FRAME_LAT_MAX) continue;
        lats.push(lat);
    }
    return lats;
}

export function meridianLons() {
    const lons = [];
    for (let lon = Math.ceil(LON_MIN / GRID_STEP) * GRID_STEP; lon < LON_MAX; lon += GRID_STEP) {
        if (lon <= LON_MIN || lon >= LON_MAX) continue;
        lons.push(lon);
    }
    return lons;
}

// A meridian is a CURVE here, so it is sampled rather than drawn as one
// segment. Returns [[y, x], ...] ready for L.polyline under CRS.Simple.
const MERIDIAN_SAMPLES = 32;
export function meridianPath(lon) {
    const pts = [];
    for (let i = 0; i <= MERIDIAN_SAMPLES; i++) {
        const lat = FRAME_LAT_MIN + (FRAME_LAT_MAX - FRAME_LAT_MIN) * i / MERIDIAN_SAMPLES;
        const [x, y] = project(lon, lat);
        pts.push([y, x]);
    }
    return pts;
}

// Each parallel stops at the edge of the lens rather than running on into the
// empty corners.
export function parallelPath(lat) {
    const [, y] = project(CENTRAL_MERIDIAN, lat);
    const w = halfWidthAt(lat);
    return [[y, -w], [y, w]];
}

// Compass rose: on a real grid intersection, in open South Pacific water.
export const COMPASS_CENTER_LON = -120;
export const COMPASS_CENTER_LAT = -30;
export const COMPASS_HALF_SIZE = 13;
const COMPASS_XY = project(COMPASS_CENTER_LON, COMPASS_CENTER_LAT);
export const COMPASS_BOUNDS = [
    [COMPASS_XY[1] - COMPASS_HALF_SIZE, COMPASS_XY[0] - COMPASS_HALF_SIZE],
    [COMPASS_XY[1] + COMPASS_HALF_SIZE, COMPASS_XY[0] + COMPASS_HALF_SIZE]
];

// Builds the striped border + graticule as a Leaflet layerGroup, in projected
// units. Rendered on its own SVG renderer rather than the shared canvas the
// country polygons use, because SVG renders these hairlines more crisply and
// ~50 elements is far too few for the canvas performance argument to apply.
export function buildMapFrame() {
    const frameRenderer = L.svg({ padding: 2 });
    const group = L.layerGroup();
    const lineStyle = { color: FRAME_COLOR, weight: 1, opacity: 0.8, interactive: false, fill: false, renderer: frameRenderer };
    const gridStyle = { color: FRAME_COLOR, weight: 0.6, opacity: 0.4, interactive: false, fill: false, renderer: frameRenderer };

    function stripe(y0, x0, y1, x1, dark) {
        L.rectangle([[y0, x0], [y1, x1]], {
            color: FRAME_COLOR, weight: 1, opacity: 0.8,
            fillColor: dark ? FRAME_COLOR : FRAME_LIGHT_COLOR, fillOpacity: dark ? 0.85 : 1,
            interactive: false, renderer: frameRenderer
        }).addTo(group);
    }

    // Both directions are now plain projected units, so the stripes are evenly
    // spaced without any correction - the whole reason the old code had to
    // work in "projected space" was Mercator's stretching, which is gone.
    const xSpan = FRAME_X_MAX - FRAME_X_MIN;
    const nHoriz = Math.max(4, Math.round(xSpan / FRAME_STRIPE_LEN));
    for (let i = 0; i < nHoriz; i++) {
        const x0 = FRAME_X_MIN + (xSpan * i) / nHoriz;
        const x1 = FRAME_X_MIN + (xSpan * (i + 1)) / nHoriz;
        const dark = i % 2 === 0;
        stripe(INNER_Y_MAX, x0, FRAME_Y_MAX, x1, dark);
        stripe(FRAME_Y_MIN, x0, INNER_Y_MIN, x1, dark);
    }
    const ySpan = FRAME_Y_MAX - FRAME_Y_MIN;
    const nVert = Math.max(4, Math.round(ySpan / FRAME_STRIPE_LEN));
    for (let i = 0; i < nVert; i++) {
        const y0 = FRAME_Y_MIN + (ySpan * i) / nVert;
        const y1 = FRAME_Y_MIN + (ySpan * (i + 1)) / nVert;
        const dark = i % 2 === 0;
        stripe(y0, FRAME_X_MIN, y1, INNER_X_MIN, dark);
        stripe(y0, INNER_X_MAX, y1, FRAME_X_MAX, dark);
    }

    // Thin rule separating the striped border from the map content
    L.polyline([
        [INNER_Y_MIN, INNER_X_MIN], [INNER_Y_MIN, INNER_X_MAX],
        [INNER_Y_MAX, INNER_X_MAX], [INNER_Y_MAX, INNER_X_MIN],
        [INNER_Y_MIN, INNER_X_MIN]
    ], lineStyle).addTo(group);

    // The graticule follows the projection: curved meridians, straight
    // parallels that stop at the edge of the lens instead of running out into
    // the empty corners.
    meridianLons().forEach(lon => L.polyline(meridianPath(lon), gridStyle).addTo(group));
    parallelLats().forEach(lat => L.polyline(parallelPath(lat), gridStyle).addTo(group));

    return group;
}

// ---------- the map as a standalone SVG ----------
// The exported file is opened without this app, so it cannot use Leaflet: the
// cover map is drawn here from the same projected boundaries and the same
// frame geometry, as plain SVG with the colours written in.
//
// Coordinates are rounded to one decimal and points closer together than
// SIMPLIFY_PX are dropped. On a 1100px-wide map that is invisible, and it is
// the difference between a megabyte and a half of path data and a few hundred
// kilobytes - which matters in a file that already carries every photo.
const SIMPLIFY_PX = 0.6;

function ringToPath(ring, sx, sy) {
    let d = '';
    let lastX = null, lastY = null;
    for (let i = 0; i < ring.length; i++) {
        const x = sx(ring[i][0]);
        const y = sy(ring[i][1]);
        const keep = lastX === null ||
            Math.abs(x - lastX) >= SIMPLIFY_PX || Math.abs(y - lastY) >= SIMPLIFY_PX ||
            i === ring.length - 1;
        if (!keep) continue;
        d += (lastX === null ? 'M' : 'L') + x.toFixed(1) + ' ' + y.toFixed(1);
        lastX = x; lastY = y;
    }
    return d ? d + 'Z' : '';
}

function featurePath(geometry, sx, sy) {
    const polys = geometry.type === 'Polygon' ? [geometry.coordinates]
        : geometry.type === 'MultiPolygon' ? geometry.coordinates : [];
    return polys.map(rings => rings.map(r => ringToPath(r, sx, sy)).join('')).join('');
}

// `fillFor(code)` returns { fill, opacity } for one country.
export async function buildWorldSvg(fillFor, opts) {
    const width = (opts && opts.width) || 1100;
    const features = await getProjectedFeatures();

    const xSpan = FRAME_X_MAX - FRAME_X_MIN;
    const ySpan = FRAME_Y_MAX - FRAME_Y_MIN;
    const height = Math.round(width * ySpan / xSpan);
    const k = width / xSpan;
    const sx = x => (x - FRAME_X_MIN) * k;
    const sy = y => (FRAME_Y_MAX - y) * k;   // SVG y grows downwards

    let out = `<svg viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg" ` +
              `width="100%" role="img" aria-label="World map of this collection">`;
    out += `<rect x="0" y="0" width="${width}" height="${height}" fill="${MAP_BG_COLOR}"/>`;

    features.forEach(f => {
        const code = getCodeForFeature(f);
        if (!code) return;
        const d = featurePath(f.geometry, sx, sy);
        if (!d) return;
        const style = fillFor(code) || {};
        out += `<path d="${d}" fill="${style.fill || MUTED_COLOR}" ` +
               `fill-opacity="${style.opacity == null ? 0.18 : style.opacity}" ` +
               `stroke="${BORDER_COLOR}" stroke-width="0.5"/>`;
    });

    const poly = pts => pts.map(([y, x]) => `${sx(x).toFixed(1)},${sy(y).toFixed(1)}`).join(' ');
    out += `<g stroke="${FRAME_COLOR}" stroke-width="0.6" opacity="0.4" fill="none">`;
    meridianLons().forEach(lon => { out += `<polyline points="${poly(meridianPath(lon))}"/>`; });
    parallelLats().forEach(lat => { out += `<polyline points="${poly(parallelPath(lat))}"/>`; });
    out += `</g>`;

    const rect = (y0, x0, y1, x1, fill, opacity) => {
        const x = sx(Math.min(x0, x1)), y = sy(Math.max(y0, y1));
        const w = Math.abs(sx(x1) - sx(x0)), h = Math.abs(sy(y0) - sy(y1));
        return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" ` +
               `height="${h.toFixed(1)}" fill="${fill}" fill-opacity="${opacity}" ` +
               `stroke="${FRAME_COLOR}" stroke-width="0.8"/>`;
    };

    const nHoriz = Math.max(4, Math.round(xSpan / FRAME_STRIPE_LEN));
    for (let i = 0; i < nHoriz; i++) {
        const x0 = FRAME_X_MIN + (xSpan * i) / nHoriz;
        const x1 = FRAME_X_MIN + (xSpan * (i + 1)) / nHoriz;
        const dark = i % 2 === 0;
        const fill = dark ? FRAME_COLOR : FRAME_LIGHT_COLOR, op = dark ? 0.85 : 1;
        out += rect(INNER_Y_MAX, x0, FRAME_Y_MAX, x1, fill, op);
        out += rect(FRAME_Y_MIN, x0, INNER_Y_MIN, x1, fill, op);
    }
    const nVert = Math.max(4, Math.round(ySpan / FRAME_STRIPE_LEN));
    for (let i = 0; i < nVert; i++) {
        const y0 = FRAME_Y_MIN + (ySpan * i) / nVert;
        const y1 = FRAME_Y_MIN + (ySpan * (i + 1)) / nVert;
        const dark = i % 2 === 0;
        const fill = dark ? FRAME_COLOR : FRAME_LIGHT_COLOR, op = dark ? 0.85 : 1;
        out += rect(y0, FRAME_X_MIN, y1, INNER_X_MIN, fill, op);
        out += rect(y0, INNER_X_MAX, y1, FRAME_X_MAX, fill, op);
    }

    out += '</svg>';
    return { svg: out, width, height };
}
