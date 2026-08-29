// All Google Drive reads and writes.

import { withAuth, driveFetch } from './auth.js';
import { COLLECTIONS_FILENAME, MULTI_CURRENCY_CONFIG_FILENAME } from './config.js';

// ---------- appData JSON files ----------
// One writer for both collections.json and layouts.json. Each used to
// hand-build a multipart/related body with the same hardcoded boundary string,
// while a third path (the thumbnail uploader) did the same job with FormData.
// FormData is the version that is provably right: the browser generates the
// boundary and encodes the parts, so there is no boundary to collide with.
export async function saveJsonToAppData(filename, fileId, value) {
    const metadata = { name: filename, mimeType: 'application/json' };
    if (!fileId) metadata.parents = ['appDataFolder'];

    const form = new FormData();
    form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
    form.append('file', new Blob([JSON.stringify(value)], { type: 'application/json' }));

    const url = fileId
        ? `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=multipart`
        : `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart`;

    const resp = await driveFetch(url, { method: fileId ? 'PATCH' : 'POST', body: form });
    const result = await resp.json();
    return result.id;
}

export async function readJsonFromAppData(filename, fallback) {
    const listResp = await withAuth(() => gapi.client.drive.files.list({
        spaces: 'appDataFolder', q: `name='${filename}'`, fields: 'files(id, name)'
    }));
    const files = listResp.result.files;
    if (!files || files.length === 0) return { fileId: null, data: fallback };
    const fileId = files[0].id;
    const contentResp = await withAuth(() =>
        gapi.client.drive.files.get({ fileId, alt: 'media' }));
    return { fileId, data: JSON.parse(contentResp.body || JSON.stringify(fallback)) };
}

// ---------- the saved list of collections ----------
export async function loadCollections() {
    const { fileId, data } = await readJsonFromAppData(COLLECTIONS_FILENAME, []);
    return { fileId, collections: data };
}

export function saveCollections(fileId, collections) {
    return saveJsonToAppData(COLLECTIONS_FILENAME, fileId, collections);
}

// ---------- optional "shared currency" config ----------
// A plain-text file named exactly this, placed directly in the collection's
// root Drive folder alongside the country folders, one currency group per line:
//   EUR:AUT, BEL, HRV, CYP, EST, FIN, FRA, DEU, GRC, IRL, ...
// Any folder in the root whose name matches a currency code from this file
// (e.g. a folder literally named "EUR") is treated as a shared pool rather than
// a country of its own: its images are folded into EVERY listed country, so a
// Eurozone note only has to be filed once instead of copied into 27 folders.
// Blank lines and lines starting with # are ignored. A missing or unparsable
// file means no groups, and never blocks opening the collection.
export function parseCurrencyGroups(text) {
    const groups = {};
    (text || '').split('\n').forEach(line => {
        line = line.trim();
        if (!line || line.startsWith('#')) return;
        const colonIdx = line.indexOf(':');
        if (colonIdx === -1) return;
        const currency = line.slice(0, colonIdx).trim().toUpperCase();
        const codes = line.slice(colonIdx + 1).split(',')
            .map(c => c.trim().toUpperCase()).filter(Boolean);
        if (currency && codes.length) groups[currency] = codes;
    });
    return groups;
}

export async function readCurrencyGroups(rootFolderId) {
    try {
        // Matches the name whether it is an extensionless upload, a ".txt", or
        // a Google Doc - an exact name= match was too strict and would silently
        // find nothing (disabling the whole feature) over a leftover ".txt".
        const listResp = await withAuth(() => gapi.client.drive.files.list({
            q: `'${rootFolderId}' in parents and name contains '${MULTI_CURRENCY_CONFIG_FILENAME}' and trashed=false`,
            fields: 'files(id, name, mimeType)'
        }));
        const candidates = listResp.result.files || [];
        const file = candidates.find(f => f.name === MULTI_CURRENCY_CONFIG_FILENAME) || candidates[0];
        if (!file) {
            console.log(`[currency config] no file matching "${MULTI_CURRENCY_CONFIG_FILENAME}" in the collection's root folder - shared-currency merging is off.`);
            return {};
        }
        console.log(`[currency config] using "${file.name}" (${file.mimeType})`);

        let text;
        if (file.mimeType === 'application/vnd.google-apps.document') {
            const exportResp = await withAuth(() => gapi.client.drive.files.export({
                fileId: file.id, mimeType: 'text/plain'
            }));
            text = exportResp.body;
        } else {
            const contentResp = await withAuth(() => gapi.client.drive.files.get({
                fileId: file.id, alt: 'media'
            }));
            text = contentResp.body;
        }
        const groups = parseCurrencyGroups(text);
        console.log('[currency config] parsed groups:', groups);
        return groups;
    } catch (err) {
        console.warn(`Could not read ${MULTI_CURRENCY_CONFIG_FILENAME} config:`, err);
        return {};
    }
}

// ---------- listing a collection's images ----------
// Lists the images in MANY folders using a handful of requests instead of one
// per folder. Drive accepts several "'id' in parents" clauses in a single
// query, so ~25 folders are asked for at once and the results are grouped back
// up client-side using each file's `parents`. For a 100-country collection this
// is the difference between 101 round trips (throttled to six at a time by the
// browser) and about five - by far the biggest cost in opening a collection.
export const FOLDERS_PER_QUERY = 25; // keeps the query URL inside Drive's length limit

export async function listImagesForFolders(folders) {
    const byFolderId = {};
    folders.forEach(f => { byFolderId[f.id] = []; });

    const chunks = [];
    for (let i = 0; i < folders.length; i += FOLDERS_PER_QUERY) {
        chunks.push(folders.slice(i, i + FOLDERS_PER_QUERY));
    }

    await Promise.all(chunks.map(async chunk => {
        const parentClause = chunk.map(f => `'${f.id}' in parents`).join(' or ');
        let pageToken;
        do {
            const resp = await withAuth(() => gapi.client.drive.files.list({
                q: `(${parentClause}) and mimeType contains 'image/' and trashed=false`,
                // `parents` is what lets us put each file back in its folder.
                fields: 'nextPageToken, files(id, name, parents)',
                pageSize: 1000,
                pageToken
            }));
            (resp.result.files || []).forEach(file => {
                (file.parents || []).forEach(parentId => {
                    if (byFolderId[parentId]) {
                        byFolderId[parentId].push({ id: file.id, name: file.name });
                    }
                });
            });
            pageToken = resp.result.nextPageToken;
        } while (pageToken);
    }));

    // A batched query interleaves folders arbitrarily, so sort by name for a
    // stable order. (Countries organised manually keep their own saved order.)
    Object.values(byFolderId).forEach(images =>
        images.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
    );
    return byFolderId;
}

// Folds each currency group's shared images into every country that uses it.
// Pure, so it can be tested without Drive.
export function mergeCurrencyGroups(countries, currencyGroups, imagesByFolderName, folderNames) {
    const countryByCode = {};
    countries.forEach(c => { countryByCode[c.code.toUpperCase()] = c; });

    Object.entries(currencyGroups).forEach(([currency, codes]) => {
        const sharedImages = imagesByFolderName[currency] || [];
        if (!sharedImages.length) {
            console.log(`[currency config] "${currency}" group (${codes.join(', ')}) has no matching folder ` +
                `(or an empty one) among: ${(folderNames || []).join(', ') || '(no folders at all)'} - skipped.`);
            return;
        }
        console.log(`[currency config] "${currency}": folding ${sharedImages.length} shared image(s) into ${codes.length} countries.`);
        codes.forEach(code => {
            let entry = countryByCode[code];
            if (!entry) {
                entry = { code, images: [] };
                countries.push(entry);
                countryByCode[code] = entry;
            }
            const existingIds = new Set(entry.images.map(img => img.id));
            sharedImages.forEach(img => { if (!existingIds.has(img.id)) entry.images.push(img); });
        });
    });
    return countries;
}

export async function fetchCollectionData(rootFolderId) {
    const [foldersResp, currencyGroups] = await Promise.all([
        withAuth(() => gapi.client.drive.files.list({
            q: `'${rootFolderId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
            fields: 'files(id, name)',
            pageSize: 1000
        })),
        readCurrencyGroups(rootFolderId)
    ]);
    const folders = foldersResp.result.files || [];

    // Country folders and currency folders alike - a currency folder's images
    // are fetched once here, then reused for every country in its group.
    const imagesByFolderId = await listImagesForFolders(folders);
    const imagesByFolderName = {};
    folders.forEach(f => {
        imagesByFolderName[f.name.toUpperCase()] = imagesByFolderId[f.id] || [];
    });

    const currencyFolderNames = new Set(Object.keys(currencyGroups));
    const countries = folders
        .filter(f => !currencyFolderNames.has(f.name.toUpperCase()))
        .map(f => ({ code: f.name, images: (imagesByFolderName[f.name.toUpperCase()] || []).slice() }));

    return mergeCurrencyGroups(countries, currencyGroups, imagesByFolderName,
                               folders.map(f => f.name));
}
