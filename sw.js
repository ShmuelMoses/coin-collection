// Offline support for the app shell.
//
// The photos themselves already live in IndexedDB after their first view, but
// the shell came from the network every time - so launching the installed app
// without a connection gave a blank page even though the content was on the
// device. This caches the shell so it starts offline and shows whatever is
// already cached locally.
//
// Google's own scripts (accounts.google.com, apis.google.com) are deliberately
// NOT cached: they are auth-critical, change without notice, and must never be
// served stale. They simply fail offline, which app.js handles by staying on
// the sign-in screen.

const VERSION = 'v2.12';
const SHELL_CACHE = 'collections-shell-' + VERSION;

// Everything the app needs to boot with no network.
const SHELL_ASSETS = [
    './',
    './index.html',
    './leaflet.css',
    './leaflet.js',
    './countries.geojson',
    './manifest.json',
    './icons/icon-192.png',
    './icons/icon-512.png',
    './icons/apple-touch-icon.png',
    './js/app.js',
    './js/auth.js',
    './js/cache.js',
    './js/config.js',
    './js/countries.js',
    './js/dialog.js',
    './js/drive.js',
    './js/export.js',
    './js/geo.js',
    './js/layouts.js',
    './js/list.js',
    './js/map.js',
    './js/modal.js',
    './js/state.js',
    './js/util.js',
];

self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(SHELL_CACHE)
            // addAll fails the whole install if ANY file 404s, which would
            // silently leave the app with no offline support at all. Adding
            // them individually means one missing file costs only that file.
            .then(cache => Promise.all(SHELL_ASSETS.map(
                url => cache.add(url).catch(err => console.warn('[sw] could not cache', url, err))
            )))
            .then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys()
            .then(keys => Promise.all(
                keys.filter(k => k.startsWith('collections-shell-') && k !== SHELL_CACHE)
                    .map(k => caches.delete(k))
            ))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', event => {
    const req = event.request;
    if (req.method !== 'GET') return;

    const url = new URL(req.url);

    // Never touch Google's APIs or anything cross-origin: those are live data
    // and auth, and a stale copy would be worse than a clean failure.
    if (url.origin !== self.location.origin) return;

    // Network-first for the shell, so a deployed update is picked up as soon as
    // there is a connection, with the cache as the offline fallback. (Cache-
    // first would be faster but would serve an old version until the SW itself
    // updated, which is a confusing way to ship a fix.)
    event.respondWith(
        fetch(req)
            .then(resp => {
                if (resp && resp.ok) {
                    const copy = resp.clone();
                    caches.open(SHELL_CACHE).then(cache => cache.put(req, copy)).catch(() => {});
                }
                return resp;
            })
            .catch(() => caches.match(req).then(hit => hit || caches.match('./index.html')))
    );
});
