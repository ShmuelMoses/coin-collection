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
export const APP_VERSION = '2.28';

// How long boot waits for Google before giving up and offering offline mode.
// One mutable object so the cadence is in a single visible place, and so the
// tests can shorten it. Every one of these is a bound on the delay before the
// user is offered a way forward, which is why none of them is generous: the
// page must never sit on "Loading..." because a request neither arrived nor
// failed, which is what a phone on a wifi with no route out actually does.
export const BOOT_TIMEOUTS = {
    existingScriptWait: 2500, // for the <script> tags already in index.html
    retryScriptWait: 3500,    // for the replacements appended after those
    gapiLoad: 6000,           // gapi.load('client:picker'), which fetches more code
    googleReady: 12000,       // whole setup, including the Drive discovery load
};

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
export const MAP_BG_COLOR = cssVar('--map-bg');

// Styles applied to a country polygon. Kept here so the map and any future
// view paint a country the same way.
export const styleFor = (shown, isOwned) => shown
    ? { fillColor: isOwned ? OWNED_COLOR : NONE_COLOR, fillOpacity: 0.65 }
    : { fillColor: MUTED_COLOR, fillOpacity: 0.18 };

// The countries colour in one after another, in a sweep across the map. These
// are the LONGEST the whole sweep may take - a big collection uses all of it, a
// small one finishes sooner (see REVEAL_MAX_STEP_MS).
export const REVEAL_MS = 3200;     // initial load / Reset view
export const TRANSITION_MS = 1900; // switching the colour-mode or item-type button

// One country's own fade, from muted to its colour. Short, so each country
// arrives as an event rather than drifting in.
export const COUNTRY_FADE_MS = 550;

// The longest gap between one country starting and the next. Without a cap, a
// collection with four countries would spread those four across the whole
// window and crawl; with it, the sweep is only as long as it needs to be.
export const REVEAL_MAX_STEP_MS = 80;
