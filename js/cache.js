// Image caching: an IndexedDB blob store in this browser, plus a shared
// thumbnail cache in the app's private Drive appData space so a thumbnail
// generated on one device is instant on every other one.

import { withAuth, driveFetch } from './auth.js';
import { resizeDims } from './util.js';

// ---------- IndexedDB ----------
let dbPromise = null;

// Asks the browser not to auto-evict cached images under storage pressure.
// Not guaranteed (especially on Safari), but it meaningfully helps.
if (navigator.storage && navigator.storage.persist) {
    navigator.storage.persist().then(granted => {
        console.log('Persistent storage granted:', granted);
    }).catch(() => {});
}

function getDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
        // v2 adds a small "meta" store used to persist the Drive-side thumbnail
        // index locally - unrelated to the "images" blob cache, just sharing
        // the same database.
        const request = indexedDB.open('coin_collection_cache', 2);
        request.onupgradeneeded = () => {
            if (!request.result.objectStoreNames.contains('images')) {
                request.result.createObjectStore('images');
            }
            if (!request.result.objectStoreNames.contains('meta')) {
                request.result.createObjectStore('meta');
            }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
        // Without this, another tab holding the database open leaves open()
        // in a state where NEITHER onsuccess nor onerror ever fires - the
        // promise hangs forever and every image behind it spins indefinitely.
        request.onblocked = () => reject(new Error('IndexedDB is blocked by another tab of this app'));
    });
    return dbPromise;
}

function storeGet(store, key) {
    return getDB().then(db => new Promise((resolve, reject) => {
        const req = db.transaction(store, 'readonly').objectStore(store).get(key);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error);
    }));
}

function storePut(store, key, value) {
    return getDB().then(db => new Promise((resolve, reject) => {
        const tx = db.transaction(store, 'readwrite');
        tx.objectStore(store).put(value, key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    }));
}

function storeDelete(store, key) {
    return getDB().then(db => new Promise((resolve, reject) => {
        const tx = db.transaction(store, 'readwrite');
        tx.objectStore(store).delete(key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    }));
}

const cacheGet = key => storeGet('images', key);
const cacheSet = (key, blob) => storePut('images', key, blob);
const cacheDelete = key => storeDelete('images', key);
export const getMeta = key => storeGet('meta', key);
export const setMeta = (key, value) => storePut('meta', key, value);

// Rejects instead of hanging. Several links in the thumbnail chain (an
// IndexedDB transaction, a fetch on a flaky mobile connection) can in practice
// settle neither way; without this the UI shows a spinner forever and there is
// nothing to diagnose.
function withTimeout(promise, ms, label) {
    let timer;
    return Promise.race([
        promise.finally(() => clearTimeout(timer)),
        new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)), ms);
        })
    ]);
}

// Recent thumbnail failures, surfaced in the info panel so a problem on a
// phone can be read without plugging it into a desktop for DevTools.
export const thumbErrors = [];
function noteThumbError(stage, fileId, err) {
    const message = (err && err.message) ? err.message : String(err);
    thumbErrors.unshift({ when: Date.now(), stage, fileId, message });
    if (thumbErrors.length > 12) thumbErrors.length = 12;
    console.warn(`[thumbnail:${stage}]`, fileId, message);
}

// ---------- full images ----------
// Google's fast thumbnailLink CDN blocks browser access, so the full image is
// downloaded once and shrunk locally, and that small version cached separately.
export async function fetchFullImageBlob(fileId) {
    const cacheKey = fileId + '_full';
    const cached = await cacheGet(cacheKey);
    if (cached) {
        if (cached.type && cached.type.startsWith('image/')) return cached;
        // A bad (non-image) response got cached previously - throw it away and
        // fetch fresh instead of failing forever.
        await cacheDelete(cacheKey);
    }

    const resp = await driveFetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`);
    const blob = await resp.blob();
    if (!blob.type.startsWith('image/')) {
        const text = await blob.text().catch(() => '');
        throw new Error(`Drive did not return image data for file ${fileId} (got "${blob.type}"): ${text.slice(0, 300)}`);
    }
    // Not awaited: storing it is an optimisation for next time, and a stalled
    // IndexedDB write must never hold up the picture the user is waiting for.
    cacheSet(cacheKey, blob).catch(err => noteThumbError('cache-write', fileId, err));
    return blob;
}

// ---------- resizing ----------
// Prefers createImageBitmap with its resize option (Chrome/Edge/Firefox): the
// browser decodes straight to the target size using its native image pipeline,
// which is faster and sharper than decoding full-res into an <img> and scaling
// by hand. Falls back to Image+canvas where that isn't supported (e.g. Safari).
export async function resizeImageBlob(blob, maxDim, quality = 0.86) {
    if (typeof createImageBitmap === 'function') {
        try {
            const srcBitmap = await createImageBitmap(blob);
            const [w, h] = resizeDims(srcBitmap.width, srcBitmap.height, maxDim);
            const resizedBitmap = await createImageBitmap(srcBitmap, {
                resizeWidth: w, resizeHeight: h, resizeQuality: 'high'
            });
            srcBitmap.close();
            const canvas = document.createElement('canvas');
            canvas.width = w; canvas.height = h;
            canvas.getContext('2d').drawImage(resizedBitmap, 0, 0, w, h);
            resizedBitmap.close();
            return await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', quality));
        } catch (err) {
            console.warn('createImageBitmap resize failed, falling back:', err);
        }
    }
    return new Promise((resolve, reject) => {
        const img = new Image();
        const objUrl = URL.createObjectURL(blob);
        img.onload = () => {
            const [width, height] = resizeDims(img.width, img.height, maxDim);
            const canvas = document.createElement('canvas');
            canvas.width = width; canvas.height = height;
            canvas.getContext('2d').drawImage(img, 0, 0, width, height);
            canvas.toBlob(resolve, 'image/jpeg', quality);
            URL.revokeObjectURL(objUrl);
        };
        img.onerror = () => {
            URL.revokeObjectURL(objUrl);
            reject(new Error(`Could not decode image (blob type="${blob.type}", size=${blob.size} bytes)`));
        };
        img.src = objUrl;
    });
}

// Shrinks by a factor (4 = quarter width and height) - used to keep shared
// export files to a sane size.
export function resizeImageBlobByFactor(blob, factor) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        const objUrl = URL.createObjectURL(blob);
        img.onload = () => {
            const width = Math.max(1, Math.round(img.width / factor));
            const height = Math.max(1, Math.round(img.height / factor));
            const canvas = document.createElement('canvas');
            canvas.width = width; canvas.height = height;
            canvas.getContext('2d').drawImage(img, 0, 0, width, height);
            canvas.toBlob(resolve, 'image/jpeg', 0.8);
            URL.revokeObjectURL(objUrl);
        };
        img.onerror = () => {
            URL.revokeObjectURL(objUrl);
            reject(new Error(`Could not decode image (blob type="${blob.type}", size=${blob.size} bytes)`));
        };
        img.src = objUrl;
    });
}

// ---------- Drive-side thumbnail cache ----------
// The IndexedDB cache above only helps on repeat views in the SAME browser.
// Once a thumbnail has been generated it is also uploaded to the app's hidden
// appData folder as "<fileId>_thumb.jpg", so every later view on any device
// fetches that small file instead of the full-size photo.
//
// The index has to list every thumbnail ever cached before it can answer "is
// this one already there?", so it is persisted locally and, after the first
// time, only whatever was added since this browser's last sync is requested.
const THUMB_META_KEY = 'driveThumbIndex';
const FULL_RESYNC_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

let driveThumbIndexPromise = null;
let lastThumbSyncTime = null;
export let lastThumbUploadError = null;

function persistThumbIndex(index, syncTime) {
    if (syncTime) lastThumbSyncTime = syncTime;
    return setMeta(THUMB_META_KEY, {
        entries: [...index.entries()],
        lastSyncTime: lastThumbSyncTime,
        syncedAt: Date.now()
    }).catch(err => console.warn('Could not persist thumbnail index:', err));
}

export function getDriveThumbIndex() {
    if (driveThumbIndexPromise) return driveThumbIndexPromise;
    driveThumbIndexPromise = (async () => {
        let persisted = null;
        try { persisted = await getMeta(THUMB_META_KEY); }
        catch (err) { console.warn('Could not read persisted thumbnail index:', err); }

        // The incremental sync can only ever ADD entries (it filters on
        // createdTime), so it never notices thumbnails deleted from another
        // device. Two cheap guards: a full resync once the local index goes
        // stale, and per-entry self-healing when a fetch 404s below.
        const stale = !persisted || !persisted.syncedAt ||
            (Date.now() - persisted.syncedAt) > FULL_RESYNC_AFTER_MS;

        const index = new Map((persisted && !stale) ? persisted.entries : []); // name -> {id, size}
        const lastSyncTime = stale ? null : (persisted ? persisted.lastSyncTime : null);
        lastThumbSyncTime = lastSyncTime;
        let newestSeen = lastSyncTime;

        let q = "name contains '_thumb.jpg' and trashed=false";
        if (lastSyncTime) q += ` and createdTime >= '${lastSyncTime}'`;

        let pageToken;
        do {
            const resp = await withAuth(() => gapi.client.drive.files.list({
                spaces: 'appDataFolder', q,
                fields: 'nextPageToken, files(id, name, size, createdTime)',
                pageSize: 1000, pageToken
            }));
            (resp.result.files || []).forEach(f => {
                index.set(f.name, { id: f.id, size: Number(f.size) || 0 });
                if (!newestSeen || f.createdTime > newestSeen) newestSeen = f.createdTime;
            });
            pageToken = resp.result.nextPageToken;
        } while (pageToken);

        if (stale || (newestSeen && newestSeen !== lastSyncTime)) {
            // Not on the critical path - the resolved Map is already correct in
            // memory regardless of whether this succeeds.
            persistThumbIndex(index, newestSeen);
        }
        return index;
    })();
    return driveThumbIndexPromise;
}

export async function clearDriveThumbCache() {
    const index = await getDriveThumbIndex();
    const ids = [...index.values()].map(v => v.id);
    // Independent Drive calls, so fire them all at once instead of awaiting one
    // full round trip per thumbnail (this used to take minutes for a big cache).
    await Promise.all(ids.map(id =>
        withAuth(() => gapi.client.drive.files.delete({ fileId: id }))
            .catch(err => console.warn('Could not delete cached thumbnail', id, err))
    ));
    driveThumbIndexPromise = null; // force a fresh rebuild next time
    lastThumbSyncTime = null;
    await setMeta(THUMB_META_KEY, { entries: [], lastSyncTime: null, syncedAt: Date.now() });
}

async function fetchDriveThumbBlob(driveThumbId) {
    const resp = await driveFetch(`https://www.googleapis.com/drive/v3/files/${driveThumbId}?alt=media`);
    return resp.blob();
}

const thumbUploadsInFlight = new Set();

// Fire-and-forget: never blocks or breaks thumbnail display if it fails
// (offline, quota) - it is purely a "make next time faster" step.
//
// Uses fetch() with a native FormData body rather than a hand-built
// multipart/related string. The hand-rolled version was the actual bug behind
// thumbnails never being cached: it relied on a helper that shared its name
// with an unrelated function later in the file, so the later declaration won
// for every caller and the upload sent a "data:image/jpeg;base64,..." string as
// the file content, which Drive silently rejected every time. Splitting this
// codebase into modules (v2.08) makes that class of collision impossible.
async function uploadThumbnailToDrive(fileId, thumbBlob) {
    const thumbName = fileId + '_thumb.jpg';
    if (thumbUploadsInFlight.has(thumbName)) return;
    thumbUploadsInFlight.add(thumbName);
    try {
        const index = await getDriveThumbIndex();
        if (index.has(thumbName)) return; // already cached by another tab/device
        const metadata = { name: thumbName, mimeType: 'image/jpeg', parents: ['appDataFolder'] };
        const form = new FormData();
        form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
        form.append('file', thumbBlob);
        // No Content-Type header - the browser sets the multipart boundary.
        const resp = await driveFetch(
            'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart',
            { method: 'POST', body: form }
        );
        const result = await resp.json();
        index.set(thumbName, { id: result.id, size: thumbBlob.size });
        lastThumbUploadError = null;
    } catch (err) {
        lastThumbUploadError = (err && err.message) ? err.message : String(err);
        console.warn('Could not cache thumbnail to Drive for', fileId, ':', err);
    } finally {
        thumbUploadsInFlight.delete(thumbName);
    }
}

// How long any single stage may take before it is treated as failed.
const CACHE_READ_TIMEOUT_MS = 8000;
const INDEX_TIMEOUT_MS = 10000;
const DOWNLOAD_TIMEOUT_MS = 60000;

async function getThumbnailBlobUrl(fileId) {
    const cacheKey = fileId + '_thumb';

    // 1. Already in this browser's cache - the fast path, no network at all.
    try {
        const cached = await withTimeout(cacheGet(cacheKey), CACHE_READ_TIMEOUT_MS, 'local cache read');
        if (cached) return URL.createObjectURL(cached);
    } catch (err) {
        // A broken IndexedDB must not stop images loading; it only means every
        // view costs a download.
        noteThumbError('local-cache', fileId, err);
    }

    // 2. The shared Drive-side thumbnail, if this or another device made one.
    //
    // The index is ONE memoised promise shared by every thumbnail, so if it
    // hangs, every image on the screen hangs behind it - which is exactly what
    // "none of the pictures load, they just spin" looks like. It is therefore
    // raced against a timeout, and a slow or broken index simply falls through
    // to the full-size download below instead of blocking the whole modal.
    try {
        const index = await withTimeout(getDriveThumbIndex(), INDEX_TIMEOUT_MS, 'Drive thumbnail index');
        const thumbName = fileId + '_thumb.jpg';
        const entry = index.get(thumbName);
        if (entry) {
            try {
                const thumbBlob = await withTimeout(
                    fetchDriveThumbBlob(entry.id), DOWNLOAD_TIMEOUT_MS, 'cached thumbnail download');
                cacheSet(cacheKey, thumbBlob).catch(err => noteThumbError('cache-write', fileId, err));
                return URL.createObjectURL(thumbBlob);
            } catch (err) {
                // 404 means it was deleted elsewhere (e.g. "Clear cache" on
                // another device). Drop the stale entry and regenerate below.
                if (err && err.status === 404) {
                    index.delete(thumbName);
                    persistThumbIndex(index, null);
                } else {
                    noteThumbError('drive-thumb', fileId, err);
                }
            }
        }
    } catch (err) {
        noteThumbError('index', fileId, err);
    }

    // 3. Last resort: download the original and shrink it here.
    const fullBlob = await withTimeout(
        fetchFullImageBlob(fileId), DOWNLOAD_TIMEOUT_MS, 'full image download');
    const thumbBlob = await resizeImageBlob(fullBlob, 320);
    cacheSet(cacheKey, thumbBlob).catch(err => noteThumbError('cache-write', fileId, err));
    uploadThumbnailToDrive(fileId, thumbBlob); // background, never awaited
    return URL.createObjectURL(thumbBlob);
}

export async function getFullImageBlobUrl(fileId) {
    const blob = await fetchFullImageBlob(fileId);
    return URL.createObjectURL(blob);
}

// ---------- object-URL ownership ----------
// Every createObjectURL pins its blob in memory until explicitly revoked, and
// nothing used to revoke anything: after browsing twenty countries, every
// thumbnail from all twenty was still held. These caches give each URL an owner
// and a lifetime.
//
// The modal cache does double duty: organise mode re-renders the whole modal on
// every arrow press, and each render used to re-read every thumbnail from
// IndexedDB and mint a fresh (leaked) URL. Now a re-render reuses what it has.
const modalObjectUrls = new Map(); // fileId -> object URL, owned by the open modal
const modalUrlPending = new Map(); // fileId -> in-flight promise, so N renders share one read

export function modalThumbUrl(fileId) {
    if (modalObjectUrls.has(fileId)) return Promise.resolve(modalObjectUrls.get(fileId));
    if (modalUrlPending.has(fileId)) return modalUrlPending.get(fileId);
    const p = getThumbnailBlobUrl(fileId).then(url => {
        modalUrlPending.delete(fileId);
        // A concurrent caller may have won the race; keep one URL only.
        if (modalObjectUrls.has(fileId)) {
            URL.revokeObjectURL(url);
            return modalObjectUrls.get(fileId);
        }
        modalObjectUrls.set(fileId, url);
        return url;
    }).catch(err => {
        modalUrlPending.delete(fileId);
        throw err;
    });
    modalUrlPending.set(fileId, p);
    return p;
}

export function releaseModalObjectUrls() {
    modalObjectUrls.forEach(url => URL.revokeObjectURL(url));
    modalObjectUrls.clear();
    // Anything still in flight resolves into an unowned URL, so revoke it as
    // it lands instead of leaking it.
    modalUrlPending.forEach(p => p.then(url => URL.revokeObjectURL(url)).catch(() => {}));
    modalUrlPending.clear();
}

let enlargeObjectUrl = null;
export function setEnlargeObjectUrl(url) {
    if (enlargeObjectUrl) URL.revokeObjectURL(enlargeObjectUrl);
    enlargeObjectUrl = url;
}
