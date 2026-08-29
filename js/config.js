// Constants and the one place a colour is defined.

// ==== FILL THESE IN ====
export const CLIENT_ID = '252654816217-o1aq4hj15j9mpb3ldtor3dpq8r3ruk6h.apps.googleusercontent.com';
export const API_KEY = 'AIzaSyAJr_VFFCgezqt0si7LvoZSdCqkuMonFPk';
// ========================
// Both are public by design in a browser app - the API key is protected by
// the HTTP-referrer restriction set on it in Google Cloud Console, not by
// being secret.

export const SCOPES =
    'https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/drive.appdata';

export const COLLECTIONS_FILENAME = 'collections.json';
export const LAYOUTS_FILENAME = 'layouts.json';
export const MULTI_CURRENCY_CONFIG_FILENAME = 'multi_country_currencies';

// Single source of truth for the version: written into the login screen at
// startup, and shown in the info panel behind the sidebar's "!" button.
export const APP_VERSION = '2.10';

// Leaflet styles its layers from JavaScript, so these have to exist as JS
// values - but they are READ FROM the :root custom properties rather than
// written out a second time. Two hand-maintained copies of the palette is
// how the stray non-theme colours found in the v2.01 audit got in; with one
// source, a literal hex anywhere else is by definition a mistake.
const cssStyle = getComputedStyle(document.documentElement);
const cssVar = name => cssStyle.getPropertyValue(name).trim();

export const OWNED_COLOR = cssVar('--accent-owned');
export const NONE_COLOR = cssVar('--accent-none');
export const MUTED_COLOR = cssVar('--muted');
export const BORDER_COLOR = cssVar('--map-border');
export const FRAME_COLOR = cssVar('--frame');
export const FRAME_LIGHT_COLOR = cssVar('--frame-light');

// Styles applied to a country polygon. Kept here so the map and any future
// view paint a country the same way.
export const styleFor = (shown, isOwned) => shown
    ? { fillColor: isOwned ? OWNED_COLOR : NONE_COLOR, fillOpacity: 0.65 }
    : { fillColor: MUTED_COLOR, fillOpacity: 0.18 };

// Animation lengths for the staggered colour reveal.
export const REVEAL_MS = 5000;     // initial load / Reset view
export const TRANSITION_MS = 3000; // switching the colour-mode button
