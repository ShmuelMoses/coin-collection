// Manual categories and sort order, per collection per country, stored in
// Drive appData so they follow you to every device you sign in from.

import { LAYOUTS_FILENAME } from './config.js';
import { readJsonFromAppData, saveJsonToAppData } from './drive.js';
import { SNAP, saveSnapshot, readSnapshot } from './cache.js';
import { state } from './state.js';
import { applyOrder } from './util.js';

let layoutsCache = null; // {fileId, data: {collectionId: {countryCode: {...}}}}

// Countries edited in THIS session, as "collectionId|countryCode". Only these
// are written over the remote copy on save.
const dirtyLayoutKeys = new Set();

export function markLayoutDirty(code) {
    dirtyLayoutKeys.add(state.currentCollectionId + '|' + code);
}

async function readLayoutsFile() {
    const { fileId, data } = await readJsonFromAppData(LAYOUTS_FILENAME, {});
    return { fileId, data };
}

export async function loadLayouts() {
    if (layoutsCache) return layoutsCache;
    if (state.offline) {
        // Offline: whatever was saved on the last successful online load.
        const snap = await readSnapshot(SNAP.layouts);
        layoutsCache = { fileId: null, data: (snap && snap.value) || {} };
        return layoutsCache;
    }
    layoutsCache = await readLayoutsFile();
    saveSnapshot(SNAP.layouts, layoutsCache.data); // for the next offline visit
    return layoutsCache;
}

export function resetLayouts() {
    layoutsCache = null;
    dirtyLayoutKeys.clear();
}

export function getCountryLayout(code) {
    // In normal use loadLayouts() has already run (showCollectionView awaits
    // it), but this must not be the thing that throws if it hasn't: an empty
    // layout is a perfectly valid answer and callers can carry on.
    if (!layoutsCache) layoutsCache = { fileId: null, data: {} };
    const data = layoutsCache.data;
    if (!data[state.currentCollectionId]) data[state.currentCollectionId] = {};
    const perCollection = data[state.currentCollectionId];
    if (!perCollection[code]) perCollection[code] = { categories: [], uncategorizedOrder: [] };
    if (!perCollection[code].uncategorizedOrder) perCollection[code].uncategorizedOrder = [];
    // Older layouts have no name for the default section; an empty string means
    // "not named yet" and reads as the fallback below.
    if (typeof perCollection[code].uncategorizedName !== 'string') {
        perCollection[code].uncategorizedName = '';
    }
    return perCollection[code];
}

// The section holding everything that has not been put in a category. It was
// always labelled "Uncategorized", which describes the app's data model rather
// than the contents - and it is usually the main run of a country's notes, not
// the leftovers. It can now be named like any other section; the label below is
// only what it falls back to.
export const DEFAULT_SECTION_NAME = 'Uncategorized';

export function uncategorizedLabel(layout) {
    const name = layout && layout.uncategorizedName;
    return (name && name.trim()) ? name.trim() : DEFAULT_SECTION_NAME;
}

// layouts.json used to be read once per page load and written back WHOLE, so a
// desktop tab opened in the morning would silently erase every category created
// on the phone since. The remote file is now re-read immediately before each
// write and only the countries actually edited in this session are laid over
// it, so two devices editing different countries no longer destroy each
// other's work.
export async function saveLayoutsToDrive() {
    if (state.offline) throw new Error('Categories cannot be saved while offline.');
    const localData = layoutsCache.data;

    let remote;
    try {
        remote = await readLayoutsFile();
    } catch (err) {
        // If the re-read fails we still want the edit saved; fall back to the
        // previous whole-file behaviour rather than losing what was just done.
        console.warn('Could not re-read layouts before saving, writing local copy:', err);
        remote = { fileId: layoutsCache.fileId, data: localData };
    }

    const merged = remote.data || {};
    dirtyLayoutKeys.forEach(key => {
        const sep = key.indexOf('|');
        const colId = key.slice(0, sep);
        const code = key.slice(sep + 1);
        const localEntry = localData[colId] && localData[colId][code];
        if (!localEntry) return;
        if (!merged[colId]) merged[colId] = {};
        merged[colId][code] = localEntry;
    });

    const newId = await saveJsonToAppData(LAYOUTS_FILENAME, remote.fileId, merged);
    layoutsCache = { fileId: remote.fileId || newId, data: merged };
    saveSnapshot(SNAP.layouts, merged);
    dirtyLayoutKeys.clear();
}

// ---------- shared notes keep ONE arrangement ----------
// A note shared by a currency group sits in every country of that group. Each
// country had its own layout, so arranging the euro notes in France left Spain,
// Greece and two dozen others still in their original order - the same work, 27
// times over. Arranging one country now arranges the shared notes in all of
// them: same category, same order.
//
// Only the SHARED images are copied across. Each country's own notes keep their
// own places, and they are left after the shared ones so the block that is the
// same everywhere reads the same everywhere.

// Every image id in one country, as the modal sees it.
function ownIdsFor(code) {
    const entry = state.cvCountryMap[code];
    return new Set(entry ? entry.own.map(i => i.id) : []);
}

// The order the source country ACTUALLY shows, which is not the same as its
// stored uncategorizedOrder: that lists only the images explicitly moved, and
// applyOrder appends the rest.
function displayedUncategorized(code, layout) {
    const entry = state.cvCountryMap[code];
    if (!entry) return [];
    const categorized = new Set(layout.categories.flatMap(c => c.imageIds));
    const raw = entry.own.filter(i => !categorized.has(i.id));
    return applyOrder(layout.uncategorizedOrder, raw).map(i => i.id);
}

export function propagateSharedLayout(sourceCode) {
    const src = getCountryLayout(sourceCode);
    const srcIds = ownIdsFor(sourceCode);
    if (!srcIds.size) return [];

    const srcUncategorized = displayedUncategorized(sourceCode, src);
    const touched = [];

    Object.keys(state.cvCountryMap).forEach(code => {
        if (code === sourceCode) return;
        const shared = new Set([...ownIdsFor(code)].filter(id => srcIds.has(id)));
        if (!shared.size) return;

        const target = getCountryLayout(code);
        // Lift the shared images out of wherever they are in this country...
        target.categories.forEach(cat => {
            cat.imageIds = cat.imageIds.filter(id => !shared.has(id));
        });
        target.uncategorizedOrder = target.uncategorizedOrder.filter(id => !shared.has(id));

        // ...and put them back where the source has them, in the source's order.
        src.categories.forEach(srcCat => {
            const ids = srcCat.imageIds.filter(id => shared.has(id));
            if (!ids.length) return;
            let cat = target.categories.find(c => c.name === srcCat.name);
            if (!cat) { cat = { name: srcCat.name, imageIds: [] }; target.categories.push(cat); }
            cat.imageIds = ids.concat(cat.imageIds);
        });
        target.uncategorizedOrder =
            srcUncategorized.filter(id => shared.has(id)).concat(target.uncategorizedOrder);

        markLayoutDirty(code);
        touched.push(code);
    });
    return touched;
}
