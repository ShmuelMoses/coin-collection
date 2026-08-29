// Manual categories and sort order, per collection per country, stored in
// Drive appData so they follow you to every device you sign in from.

import { LAYOUTS_FILENAME } from './config.js';
import { readJsonFromAppData, saveJsonToAppData } from './drive.js';
import { state } from './state.js';

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
    layoutsCache = await readLayoutsFile();
    return layoutsCache;
}

export function getCountryLayout(code) {
    const data = layoutsCache.data;
    if (!data[state.currentCollectionId]) data[state.currentCollectionId] = {};
    const perCollection = data[state.currentCollectionId];
    if (!perCollection[code]) perCollection[code] = { categories: [], uncategorizedOrder: [] };
    if (!perCollection[code].uncategorizedOrder) perCollection[code].uncategorizedOrder = [];
    return perCollection[code];
}

// layouts.json used to be read once per page load and written back WHOLE, so a
// desktop tab opened in the morning would silently erase every category created
// on the phone since. The remote file is now re-read immediately before each
// write and only the countries actually edited in this session are laid over
// it, so two devices editing different countries no longer destroy each
// other's work.
export async function saveLayoutsToDrive() {
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
    dirtyLayoutKeys.clear();
}
