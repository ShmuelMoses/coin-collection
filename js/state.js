// Shared mutable state for the open collection, plus the filter predicate.
//
// This module exists to break what would otherwise be an import cycle: the map
// needs to know whether a country passes the current filter, and the controls
// that change the filter need to repaint the map. Putting the filter STATE
// here (rather than in either of those modules) lets both import from it and
// neither import the other. It replaces the window._passesFilters /
// window._applyFilters / window._refreshLabels2D globals the single-file
// version used for exactly this purpose.

export const state = {
    cvCountries: [],        // raw [{code, images:[{id,name}]}] for the open collection
    cvCountryMap: {},       // merged: {code: {own:[images], historical:{histCode:[images]}}}
    collectionData: {},     // {code: {count, name}} - only countries with items
    currentCollectionId: null,
    countryLayers: {},      // code -> [Leaflet layers]
    countryNameLookup: {},  // code -> English name, for every country on the map
    colorMode: 'both',      // 'owned' | 'none' | 'both'
    currentView: 'map',     // 'map' | 'list'
    searchQuery: '',
    // Countries whose name label is pinned on because they were clicked.
    clickedLabelCodes: new Set(),
    // Countries whose label is currently pinned, so the map only rebinds the
    // tooltips that actually changed.
    labelShownCodes: new Set(),
    // Countries currently painted as coloured rather than muted.
    shownCodes: new Set(),
    // Set just before a programmatic history.back(), so the popstate handler
    // knows that navigation was already dealt with. Without it, closing the
    // modal pops TWO screens: closeModal hides the modal and calls
    // history.back(), the handler then runs, sees no modal open any more, and
    // "goes back" again - landing on the collections list.
    suppressNextPopstate: false,
    // True when the app was opened WITHOUT signing in, reading everything from
    // the local snapshots. Nothing can be written to Drive in this mode, so
    // every control that would change something is disabled rather than left
    // to fail at the moment it is pressed.
    offline: false,
    // Whether the network is actually reachable RIGHT NOW, maintained by
    // net.js. Deliberately separate from `offline` above: those are different
    // questions ("am I signed in?" vs "is there a connection?") and conflating
    // them is why the banner used to be decided once at startup and then never
    // corrected when the connection came or went.
    online: true,
};

export function resetCollectionState() {
    state.cvCountries = [];
    state.cvCountryMap = {};
    state.collectionData = {};
    state.countryLayers = {};
    state.countryNameLookup = {};
    state.colorMode = 'both';
    state.currentView = 'map';
    state.searchQuery = '';
    state.clickedLabelCodes = new Set();
    state.labelShownCodes = new Set();
    state.shownCodes = new Set();
}

export function matchesQuery(code, name, query) {
    return name.toLowerCase().includes(query) || code.toLowerCase().includes(query);
}

// Colour-mode filtering only applies when NOT actively searching, so search
// always works regardless of the current mode.
export function passesFilters(code, name) {
    const query = state.searchQuery.trim().toLowerCase();
    const searchOk = query === '' || matchesQuery(code, name, query);
    if (!searchOk) return false;
    if (query !== '') return true;
    const isOwned = Object.prototype.hasOwnProperty.call(state.collectionData, code);
    if (state.colorMode === 'owned') return isOwned;
    if (state.colorMode === 'none') return !isOwned;
    return true; // 'both'
}

export function isOwned(code) {
    return Object.prototype.hasOwnProperty.call(state.collectionData, code);
}
