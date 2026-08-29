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

// Deletes every cached FULL-SIZE image, keeping the small thumbnails. Full
// originals are several megabytes each and thumbnails are tens of kilobytes, so
// this reclaims nearly all the space while losing almost nothing useful.
function evictFullImages() {
    return getDB().then(db => new Promise((resolve, reject) => {
        const tx = db.transaction('images', 'readwrite');
        const store = tx.objectStore('images');
        const req = store.openKeyCursor();
        let removed = 0;
        req.onsuccess = () => {
            const cursor = req.result;
            if (!cursor) return;
            if (String(cursor.key).endsWith('_full')) { store.delete(cursor.key); removed++; }
            cursor.continue();
        };
        tx.oncomplete = () => { console.warn(`[cache] evicted ${removed} full-size images to free space`); resolve(removed); };
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
// Set once the browser refuses to store any more: full-size originals are the
// space hogs, so we stop caching them rather than fail on every write.
let skipFullImageCaching = false;

export async function fetchFullImageBlob(fileId) {
    const cacheKey = fileId + '_full';

    // A broken or full IndexedDB must cost SPEED, not function. This read used
    // to be unprotected, so once the local database started refusing (a full
    // quota is the usual reason, and full-size photos fill one quickly) the
    // download below was never even attempted and every uncached photo failed.
    try {
        const cached = await cacheGet(cacheKey);
        if (cached) {
            if (cached.type && cached.type.startsWith('image/')) return cached;
            // A bad (non-image) response got cached previously - throw it away.
            await cacheDelete(cacheKey).catch(() => {});
        }
    } catch (err) {
        noteThumbError('full-cache-read', fileId, err);
    }

    const resp = await driveFetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`);
    const blob = await resp.blob();
    if (!blob.type.startsWith('image/')) {
        const text = await blob.text().catch(() => '');
        throw new Error(`Drive did not return image data for file ${fileId} (got "${blob.type}"): ${text.slice(0, 300)}`);
    }
    // Not awaited: storing it is an optimisation for next time, and a stalled
    // IndexedDB write must never hold up the picture the user is waiting for.
    if (!skipFullImageCaching) {
        cacheSet(cacheKey, blob).catch(err => {
            noteThumbError('cache-write', fileId, err);
            // Out of space: drop the full-size originals (the bulk of the
            // usage) and stop storing more of them this session. Thumbnails,
            // which are tiny and are what the grid actually needs, keep working.
            if (err && (err.name === 'QuotaExceededError' || /quota/i.test(err.message || ''))) {
                skipFullImageCaching = true;
                evictFullImages().catch(e => console.warn('Could not evict cached images:', e));
            }
        });
    }
    return blob;
}

// ---------- resizing ----------
// Prefers createImageBitmap with its resize option (Chrome/Edge/Firefox): the
// browser decodes straight to the target size using its native image pipeline,
// which is faster and sharper than decoding full-res into an <img> and scaling
// by hand. Falls back to Image+canvas where that isn't supported (e.g. Safari).
function canvasToBlob(canvas, quality) {
    return new Promise((resolve, reject) => {
        try {
            canvas.toBlob(
                b => b ? resolve(b) : reject(new Error('canvas.toBlob produced no data')),
                'image/jpeg', quality);
        } catch (err) {
            reject(err); // some browsers throw outright on an oversized canvas
        }
    });
}

// Decodes STRAIGHT to the target size. Passing only resizeWidth makes the
// browser compute the height itself, so the full-resolution bitmap is never
// materialised - which matters enormously: a 12-megapixel phone photo is about
// 48 MB decoded, and the previous version decoded it in full purely to read its
// dimensions before shrinking it. Several of those at once is what a phone
// cannot survive.
async function resizeViaBitmap(blob, maxDim, quality) {
    const bitmap = await createImageBitmap(blob, { resizeWidth: maxDim, resizeQuality: 'high' });
    try {
        // Portrait images come back taller than maxDim (only the width was
        // constrained), so scale during the draw - free, no second decode.
        const scale = Math.min(1, maxDim / bitmap.width, maxDim / bitmap.height);
        const w = Math.max(1, Math.round(bitmap.width * scale));
        const h = Math.max(1, Math.round(bitmap.height * scale));
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h);
        return await canvasToBlob(canvas, quality);
    } finally {
        bitmap.close();
    }
}

function resizeViaImage(blob, maxDim, quality) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        const objUrl = URL.createObjectURL(blob);
        img.onload = async () => {
            try {
                const [width, height] = resizeDims(img.width, img.height, maxDim);
                const canvas = document.createElement('canvas');
                canvas.width = width; canvas.height = height;
                canvas.getContext('2d').drawImage(img, 0, 0, width, height);
                resolve(await canvasToBlob(canvas, quality));
            } catch (err) {
                reject(err);
            } finally {
                URL.revokeObjectURL(objUrl);
            }
        };
        img.onerror = () => {
            URL.revokeObjectURL(objUrl);
            reject(new Error(`Could not decode image (type="${blob.type}", ${blob.size} bytes)`));
        };
        img.src = objUrl;
    });
}

// Always settles: every path is bounded. This had no timeout at all, so a
// decode that stalled under memory pressure hung its caller forever.
export async function resizeImageBlob(blob, maxDim, quality = 0.86) {
    if (typeof createImageBitmap === 'function') {
        try {
            return await withTimeout(
                resizeViaBitmap(blob, maxDim, quality), TIMEOUTS.resize, 'image decode');
        } catch (err) {
            console.warn('Fast resize failed, falling back:', err);
        }
    }
    return withTimeout(resizeViaImage(blob, maxDim, quality), TIMEOUTS.resize, 'image decode (fallback)');
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

// How long each stage may take before it is treated as failed. Exported as one
// mutable object so the values are in a single visible place (and so the tests
// can shorten them). They are deliberately not generous: on a phone a stalled
// stage that takes a minute to give up is indistinguishable from a hang, and
// while it waits it is occupying one of the few queue slots.
export const TIMEOUTS = {
    cacheRead: 8000,
    index: 10000,
    download: 30000,
    resize: 20000,
    job: 55000,   // outer bound on download + decode + encode together
};

// Generating a thumbnail from the original is EXPENSIVE: it downloads several
// megabytes and then decodes them into a full-resolution bitmap. A 12-megapixel
// phone photo is around 48 MB once decoded, and the modal used to start one of
// these for every photo in the country at the same moment - eight of them is
// close to 400 MB of bitmaps at once. A desktop absorbs that; a phone does not,
// and the requests would crawl until they hit the timeout and reported
// "Could not load". Reading an ALREADY cached thumbnail is cheap and skips this
// queue entirely, which is why previously-cached countries kept working.
const THUMB_CONCURRENCY =
    (navigator.deviceMemory && navigator.deviceMemory <= 4) ? 2 : 3;

// A job that never settles used to hold its slot forever, and once all the
// slots were held that way the queue was dead: every later photo waited behind
// it with no error and no timeout - an endless spinner. Nothing may occupy a
// slot indefinitely (see TIMEOUTS.job).
let activeThumbJobs = 0;
const thumbQueue = [];

function runQueuedThumbJobs() {
    while (activeThumbJobs < THUMB_CONCURRENCY && thumbQueue.length) {
        const job = thumbQueue.shift();
        activeThumbJobs++;
        let released = false;
        const release = () => {
            if (released) return; // belt and braces: release exactly once
            released = true;
            activeThumbJobs--;
            runQueuedThumbJobs();
        };
        // Promise.resolve().then(run) also converts a synchronous throw in the
        // job into a rejection, so it cannot escape past the release either.
        withTimeout(Promise.resolve().then(job.run), TIMEOUTS.job, 'thumbnail job')
            .then(job.resolve, job.reject)
            .finally(release);
    }
}

function queueThumbJob(run) {
    return new Promise((resolve, reject) => {
        thumbQueue.push({ run, resolve, reject });
        runQueuedThumbJobs();
    });
}

// Dropped when the modal closes, so a country you have already left stops
// competing for the queue with the one you just opened.
export function clearThumbQueue() {
    while (thumbQueue.length) {
        const job = thumbQueue.shift();
        job.reject(new Error('cancelled'));
    }
}

async function getThumbnailBlobUrl(fileId) {
    const cacheKey = fileId + '_thumb';

    // 1. Already in this browser's cache - the fast path, no network at all.
    try {
        const cached = await withTimeout(cacheGet(cacheKey), TIMEOUTS.cacheRead, 'local cache read');
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
        const index = await withTimeout(getDriveThumbIndex(), TIMEOUTS.index, 'Drive thumbnail index');
        const thumbName = fileId + '_thumb.jpg';
        const entry = index.get(thumbName);
        if (entry) {
            try {
                const thumbBlob = await withTimeout(
                    fetchDriveThumbBlob(entry.id), TIMEOUTS.download, 'cached thumbnail download');
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

    // 3. Last resort: download the original and shrink it here. Queued, so only
    //    a couple of these heavy jobs are ever in flight at once.
    return queueThumbJob(async () => {
        try {
            const fullBlob = await withTimeout(
                fetchFullImageBlob(fileId), TIMEOUTS.download, 'full image download');
            const thumbBlob = await resizeImageBlob(fullBlob, 320);
            cacheSet(cacheKey, thumbBlob).catch(err => noteThumbError('cache-write', fileId, err));
            uploadThumbnailToDrive(fileId, thumbBlob); // background, never awaited
            return URL.createObjectURL(thumbBlob);
        } catch (err) {
            // This is the stage that actually fails in practice, and it used to
            // throw straight out to the caller without being recorded - which is
            // why the info panel's error list stayed empty while every image
            // showed "Could not load".
            noteThumbError('generate', fileId, err);
            throw err;
        }
    });
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
