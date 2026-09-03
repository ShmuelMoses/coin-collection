// Entry point: boot, sign-in, the collections screen, and the collection view's
// control wiring.

import {
    API_KEY, APP_VERSION, TRANSITION_MS, BOOT_TIMEOUTS
} from './config.js';
import { initAuth, promptSignIn, trySilentSignIn, clearToken, getAccessToken, isAuthReady } from './auth.js';
import { loadCollections, saveCollections, fetchCollectionData, getFolderInfo } from './drive.js';
import {
    getDriveThumbIndex, clearDriveThumbCache, clearLocalImageCache, localCacheStats,
    lastThumbUploadError, releaseModalObjectUrls, thumbErrors,
    SNAP, saveSnapshot, readSnapshot
} from './cache.js';
import { state, resetCollectionState } from './state.js';
import { startConnectivityMonitor, onConnectivityChange, checkNow } from './net.js';
import {
    COUNTRY_NAMES, buildCountryMap, countryTotalCount, uniqueImageCount,
    kindCounts, KIND_BANKNOTE, KIND_COIN, KIND_UNKNOWN
} from './countries.js';
import { loadLayouts, resetLayouts } from './layouts.js';
import { initModal, closeModal, isModalOpen, setModalCollectionName } from './modal.js';
import { renderList } from './list.js';
import {
    initMap, destroyMap, applyFilters, fitFrameToViewport,
    focusOnMatches, invalidateMapSize
} from './map.js';
import { buildCollectionExport, shareOrDownloadFile, isExportCancelled } from './export.js';
import { alertDialog, confirmDialog, promptDialog, showProgressDialog, showChoiceDialog } from './dialog.js';
import { describeError, isNetworkError } from './util.js';

const statusEl = document.getElementById('status');
const contentEl = document.getElementById('content');
const setStatus = msg => { statusEl.textContent = msg; };

document.getElementById('login-version').textContent = APP_VERSION;

let collectionsState = { fileId: null, collections: [] };
let currentCollection = null;
let currentFolderInfo = null; // {createdTime} for the open collection
let signedOutShown = false;

// ---------- boot ----------
// Google's two scripts come from the network, so with no connection they never
// arrive and `gapi` / `google` are simply not defined. That used to be a dead
// end: the sign-in button stayed disabled and the app could do nothing, even
// though every photo was already on the device.
function googleScriptsPresent() {
    return typeof gapi !== 'undefined' && typeof gapi.load === 'function'
        && typeof google !== 'undefined'
        && !!(google.accounts && google.accounts.oauth2);
}

// The two <script> tags in index.html are fetched once, at page load, and are
// never retried. A page opened with no connection therefore had no way to ever
// obtain them short of a full reload - which is why the offline sign-in button
// could only offer to reload the page. Appending the tag again asks for it now.
function loadScript(src) {
    return new Promise((resolve, reject) => {
        const el = document.createElement('script');
        el.src = src;
        el.async = true;
        el.onload = () => resolve();
        el.onerror = () => reject(new Error('Could not load ' + src));
        (document.head || document.body).appendChild(el);
    });
}

function waitFor(predicate, ms) {
    return new Promise(resolve => {
        if (predicate()) return resolve(true);
        const started = Date.now();
        const t = setInterval(() => {
            if (predicate()) { clearInterval(t); resolve(true); }
            else if (Date.now() - started >= ms) { clearInterval(t); resolve(false); }
        }, 100);
    });
}

async function ensureGoogleScripts() {
    if (googleScriptsPresent()) return;
    // The tags in index.html are async, so on a slow connection they may simply
    // not have run yet - give them a bounded moment before replacing them.
    if (await waitFor(googleScriptsPresent, BOOT_TIMEOUTS.existingScriptWait)) return;

    [
        (typeof gapi === 'undefined' || typeof gapi.load !== 'function')
            ? 'https://apis.google.com/js/api.js' : null,
        (typeof google === 'undefined' || !(google.accounts && google.accounts.oauth2))
            ? 'https://accounts.google.com/gsi/client' : null,
    ].filter(Boolean).forEach(src => {
        loadScript(src).catch(err => console.warn(String(err)));
    });

    // Waiting on the GLOBALS rather than on the load events: a request that
    // hangs instead of failing (the usual shape of a phone on a wifi with no
    // route out) never fires either event, and waiting on it is what left the
    // page stuck with no offline option at all.
    if (!await waitFor(googleScriptsPresent, BOOT_TIMEOUTS.retryScriptWait)) {
        throw new Error("Google's sign-in scripts could not be loaded.");
    }
}

// Nothing in the setup below may hang. gapi.client.init and the discovery
// document load are ordinary network calls with no timeout of their own, so on
// a connection that stalls they never settle - and an unsettled promise there
// means the offline option is never offered at all.
function withDeadline(promise, ms, label) {
    let timer;
    return Promise.race([
        promise.finally(() => clearTimeout(timer)),
        new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(label)), ms);
        })
    ]);
}

// One-time Google client setup: scripts, the Drive discovery document, and the
// token client. This used to live inside the online-only boot path, so in
// offline mode initAuth() had never run and the sign-in button was pressing a
// null token client. It is now reachable from every sign-in entry point.
//
// A failed attempt clears itself so the next press tries again, rather than
// leaving a rejected promise memoised forever.
let googleReadyPromise = null;
function ensureGoogleReady() {
    if (googleReadyPromise) return googleReadyPromise;
    googleReadyPromise = withDeadline((async () => {
        await ensureGoogleScripts();
        // gapi.load fetches more code of its own, so it stalls on a dead
        // connection exactly like the script tags do. Its bound was 20s, which
        // is where most of the half-minute before the offline option appeared
        // was actually going: the two script tags were served from the browser
        // cache, so the wait above passed instantly and everything piled up here.
        await new Promise((resolve, reject) => {
            const t = setTimeout(() => reject(new Error('Google API loader did not respond')),
                BOOT_TIMEOUTS.gapiLoad);
            gapi.load('client:picker', () => { clearTimeout(t); resolve(); });
        });
        await gapi.client.init({ apiKey: API_KEY });
        await gapi.client.load('https://www.googleapis.com/discovery/v1/apis/drive/v3/rest');
        if (!isAuthReady()) {
            initAuth({
                onSignIn: startSignedInSession,
                onExpired: reportSignedOut,
                onError: reportSignInError,
            });
        }
    })(), BOOT_TIMEOUTS.googleReady, 'Google could not be reached in time.');
    googleReadyPromise.catch(() => { googleReadyPromise = null; });
    return googleReadyPromise;
}

let booted = false;
async function boot() {
    if (booted) return;
    booted = true;

    startConnectivityMonitor();
    onConnectivityChange(handleConnectivityChange);

    const btn = document.getElementById('signin-btn');
    // This button had NO click handler at all: sign-in depended entirely on the
    // silent attempt below succeeding, so whenever there was no live Google
    // session the button did nothing at all when pressed.
    if (btn) btn.onclick = () => attemptSignIn();

    // Ask the network first. Every Google step below stalls rather than fails
    // when there is no route out, so with no connection this used to spend the
    // whole chain of timeouts - about half a minute - before offering the
    // offline option. This answers in milliseconds when the device knows it is
    // offline, and within a few seconds otherwise.
    setStatus('Checking your connection…');
    await checkNow();
    if (!state.online) {
        await offerOfflineMode('You appear to be offline.');
        return;
    }

    setStatus('Connecting to Google…');
    try {
        await ensureGoogleReady();
        setStatus('');
        if (btn) { btn.disabled = false; btn.textContent = 'Sign in with Google'; }
        // Try a silent sign-in first: if access was granted before and the
        // Google session is still live, this logs back in with no click.
        trySilentSignIn();
    } catch (err) {
        console.error(err);
        await offerOfflineMode(navigator.onLine === false || !state.online
            ? 'You appear to be offline.'
            : "Google's sign-in could not be reached.");
    }
}

// NOT window.onload. The load event waits for every subresource, Google's two
// <script> tags included - and a request that hangs rather than fails (a phone
// on a wifi with no route out, which is the normal Android shape of "no
// internet") delays it indefinitely. boot() then never ran at all, so the page
// sat on a disabled "Loading..." button with no offline option, which is
// exactly what Android was doing. This module is deferred, so the DOM is
// already parsed by the time it runs and there is nothing left to wait for.
if (typeof document !== 'undefined' && document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
    boot();
}
// Kept only as a belt-and-braces fallback; the guard above makes it a no-op in
// the normal case.
window.onload = boot;

// ---------- connectivity ----------
// Every reaction to the connection changing goes through here, so the banner,
// the disabled controls and the info panel can never disagree with each other.
function handleConnectivityChange(online) {
    updateConnectionUi();
    if (!online) return;
    // Back online while running from the saved copy: try to pick the session up
    // silently, so in the common case (the Google session is still live) the
    // app simply becomes editable again with nothing to press.
    if (state.offline) {
        ensureGoogleReady()
            .then(() => trySilentSignIn())
            .catch(err => console.warn('Could not resume the session automatically:', err));
    }
}

// Editing needs BOTH a signed-in session and a live connection; each on its own
// is not enough, and a write attempted without either fails at the Drive call.
function canEdit() { return !state.offline && state.online; }

// One place that decides everything the connection affects on screen.
function updateConnectionUi() {
    const banner = document.getElementById('offline-banner');
    if (banner) {
        const show = state.offline || !state.online;
        banner.classList.toggle('shown', show);
        const text = document.getElementById('offline-banner-text');
        const signIn = document.getElementById('offline-banner-btn');
        if (text) {
            text.textContent = !state.online
                ? 'No internet connection - showing what is saved on this device. Changes are disabled.'
                : 'Not signed in - showing your last saved copy. Sign in to make changes.';
        }
        // Only worth offering when there is a connection to sign in over.
        if (signIn) signIn.style.display = (state.online && state.offline) ? 'inline-flex' : 'none';
    }
    applyConnectionRestrictions();
    refreshInfoStatus();
}

// ---------- offline mode ----------
// Offered only when there is actually something saved to show; without a
// snapshot an "offline" button would open an empty app, which is worse than
// saying plainly that nothing has been saved yet.
async function offerOfflineMode(reason) {
    const snap = await readSnapshot(SNAP.collections);
    const btn = document.getElementById('signin-btn');
    if (btn) {
        btn.disabled = false;
        btn.textContent = 'Sign in with Google';
        btn.onclick = () => attemptSignIn();
    }
    // This can now be reached more than once (a failed attempt, then a retry
    // after the connection changes). The note and the button are therefore one
    // REPLACEABLE block: the previous version removed only the note, so a
    // second attempt left two "Continue without signing in" buttons stacked up.
    const stale = document.getElementById('login-offline-block');
    if (stale) stale.remove();

    if (!snap) {
        setStatus(reason + ' Nothing has been saved for offline use yet - ' +
                  'open your collection once while connected.');
        return;
    }

    const block = document.createElement('div');
    block.id = 'login-offline-block';

    const note = document.createElement('p');
    note.id = 'login-offline-note';
    note.textContent = reason + ' You can open the copy saved on this device: ' +
        'photos already viewed will be there, and nothing can be changed until you sign in.';

    const offlineBtn = document.createElement('button');
    offlineBtn.className = 'legend-btn';
    offlineBtn.style.justifyContent = 'center';
    offlineBtn.textContent = 'Continue without signing in';
    offlineBtn.onclick = () => enterOfflineMode(snap.value);

    setStatus('');
    block.appendChild(note);
    block.appendChild(offlineBtn);
    contentEl.appendChild(block);
}

async function enterOfflineMode(collections) {
    state.offline = true;
    collectionsState = { fileId: null, collections: collections || [] };
    updateConnectionUi();
    setStatus('');
    await showCollectionsScreen({ fromSnapshot: true });
}

// Leaving offline mode: a successful sign-in re-reads everything from Drive.
function leaveOfflineMode() {
    state.offline = false;
    resetLayouts();
    updateConnectionUi();
}

// Applies the disabled look to everything that would write to Drive. They stay
// visible rather than disappearing, so the app doesn't look like it has lost
// features - the banner explains why they are greyed out.
//
// "Clear cache" is deliberately NOT in this list any more: it now clears the
// on-device copies too, which works perfectly well with no connection.
function applyConnectionRestrictions() {
    const locked = !canEdit();
    ['export-btn', 'delete-collection-btn'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.classList.toggle('offline-disabled', locked);
    });
    const signinBtn = document.getElementById('info-signin-btn');
    if (signinBtn) signinBtn.style.display = state.offline ? 'flex' : 'none';
}

async function startSignedInSession() {
    signedOutShown = false;
    // Signing in from offline mode should return you to what you were looking
    // at, not throw you back to the collections list.
    const reopen = state.offline ? currentCollection : null;
    leaveOfflineMode();
    try {
        if (reopen) {
            await openCollection(reopen, { inPlace: true });
        } else {
            setStatus('Loading your collections...');
            await showCollectionsScreen();
        }
    } catch (err) {
        console.error(err);
        setStatus(describeError(err, 'Your collections could not be loaded'));
    }
}

// Google reports here when the sign-in window never opened at all. It used to
// report nowhere: the failure was completely silent, which is what pressing
// Sign in and having nothing happen actually looked like.
function reportSignInError(type) {
    const message = type === 'popup_failed_to_open'
        ? 'Your browser blocked the Google sign-in window. Allow pop-ups for this ' +
          'site and press Sign in again.'
        : 'The Google sign-in window did not finish. Please try again.';
    alertDialog(message, 'Sign-in did not complete');
}

// Reached only when a silent refresh genuinely fails - revoked access, offline,
// or a consent screen still in "Testing" mode, where Google expires the grant
// after 7 days no matter what the app does.
function reportSignedOut() {
    clearToken();
    if (signedOutShown) return;
    signedOutShown = true;

    destroyMap();
    releaseModalObjectUrls();
    document.getElementById('modal').style.display = 'none';
    document.getElementById('modal-backdrop').style.display = 'none';
    document.getElementById('collection-view').style.display = 'none';
    document.getElementById('login-box').style.display = 'block';

    contentEl.innerHTML = '';
    const btn = document.createElement('button');
    btn.className = 'primary-btn';
    btn.textContent = 'Sign in with Google';
    // attemptSignIn, not promptSignIn: after a long gap the connection may be
    // gone, or Google's client may need setting up again, and both are handled
    // there rather than throwing on a null token client.
    btn.onclick = () => { signedOutShown = false; attemptSignIn(); };
    contentEl.appendChild(btn);
    setStatus('Your Google sign-in expired. Please sign in again.');
}

// ---------- collections screen ----------
async function showCollectionsScreen(opts) {
    if (!(opts && opts.fromSnapshot) && !state.offline) {
        const { fileId, collections } = await loadCollections();
        collectionsState = { fileId, collections };
        // Recorded so the list can be shown next time there is no connection.
        saveSnapshot(SNAP.collections, collections);
    }
    const { collections } = collectionsState;
    setStatus('');

    contentEl.innerHTML = '';
    if (collections.length === 0) {
        const p = document.createElement('p');
        p.style.cssText = 'font-size:14px;color:var(--text-dim);';
        p.textContent = "You don't have any collections yet.";
        contentEl.appendChild(p);
        const btn = document.createElement('button');
        btn.className = 'primary-btn';
        btn.textContent = '+ Create your first collection';
        btn.onclick = addNewCollection;
        contentEl.appendChild(btn);
        return;
    }

    collections.forEach(col => {
        const item = document.createElement('div');
        item.className = 'collection-item';
        item.onclick = () => openCollection(col);

        const nameSpan = document.createElement('span');
        nameSpan.textContent = col.name;
        nameSpan.style.flex = '1';
        item.appendChild(nameSpan);

        // No delete control here any more: removing a collection lives in the
        // info panel, alongside everything else about the open collection.
        contentEl.appendChild(item);
    });

    // Adding a collection needs the Drive picker, so it is not offered offline.
    const addBtn = document.createElement('button');
    addBtn.className = 'primary-btn';
    addBtn.textContent = '+ Add new collection';
    addBtn.onclick = addNewCollection;
    if (state.offline) addBtn.classList.add('offline-disabled');
    contentEl.appendChild(addBtn);

    if (state.offline) {
        const note = document.createElement('p');
        note.id = 'login-offline-note';
        note.textContent = 'Offline - this is the copy saved on this device. ' +
            'Sign in to make changes.';
        contentEl.appendChild(note);

        const signIn = document.createElement('button');
        signIn.className = 'legend-btn';
        signIn.style.justifyContent = 'center';
        signIn.textContent = 'Sign in to Google';
        signIn.onclick = () => attemptSignIn();
        contentEl.appendChild(signIn);
    }
}

// The single sign-in entry point, used by the login screen, the collections
// screen, the offline banner and the info panel. It loads whatever part of
// Google's client is still missing (including the two <script> tags themselves,
// if the page was opened with no connection) and only then asks for a token.
let signInInFlight = false;
// Google's requestAccessToken opens a window, and a browser only allows that
// while it still considers itself inside the click that asked for it. EVERY
// await before it spends that gesture - a connectivity check is enough - and
// the window is then blocked silently: no callback, no error, nothing happens.
// That is why signing in from the info panel failed once the connection came
// back, while the same code worked at startup (where the silent path uses an
// iframe rather than a window).
//
// So when Google is already set up, the call is made SYNCHRONOUSLY inside the
// click. Everything slow is done ahead of time instead: boot does it, and so
// does the connectivity monitor the moment the connection returns.
function attemptSignIn() {
    if (signInInFlight) return;
    if (isAuthReady() && state.online) {
        try {
            promptSignIn();
            return;
        } catch (err) {
            console.warn('Sign-in could not start:', err);
        }
    }
    prepareThenSignIn();
}

async function prepareThenSignIn() {
    signInInFlight = true;
    let failure = null;
    try {
        // Don't trust a stale flag for something the user just asked for.
        await checkNow();
        if (!state.online) {
            failure = new Error('There is still no internet connection, so Google cannot be reached.');
            failure.plainMessage = true; // already says everything; don't wrap it
        } else {
            await ensureGoogleReady();
            promptSignIn();
        }
    } catch (err) {
        console.error('Sign-in could not start:', err);
        failure = err;
    } finally {
        // Released BEFORE the message below. The flag exists to stop two
        // sign-in windows being launched at once, not to lock the button while
        // a dialog the user has to dismiss is on screen.
        signInInFlight = false;
    }
    if (!failure) return;

    // Put the offline option back in front of the user FIRST, so it is already
    // there when the message is dismissed rather than leaving them with a
    // dialog and no way forward. offerOfflineMode replaces the whole block, so
    // pressing Sign in repeatedly cannot stack up copies of it.
    if (document.getElementById('login-box').style.display !== 'none') {
        await offerOfflineMode('Google could not be reached.');
    }
    await alertDialog(
        failure.plainMessage ? failure.message : describeError(failure, 'Google could not be reached'),
        'Cannot sign in');
}

function addNewCollection() {
    const picker = new google.picker.PickerBuilder()
        .addView(new google.picker.DocsView(google.picker.ViewId.FOLDERS)
            .setSelectFolderEnabled(true)
            .setIncludeFolders(true))
        .setOAuthToken(getAccessToken())
        .setDeveloperKey(API_KEY)
        .setCallback(pickerCallback)
        .build();
    picker.setVisible(true);
}

async function pickerCallback(data) {
    if (data.action !== google.picker.Action.PICKED) return;

    const folder = data.docs[0];
    const typed = await promptDialog('Name this collection:', folder.name, { title: 'New collection' });
    if (typed === null) return; // cancelled
    const displayName = typed.trim() || folder.name;

    // Build the new list without touching the live one, and only commit after
    // Drive confirms the write - pushing first meant a failed save left a
    // collection on screen that had never been persisted.
    const updated = collectionsState.collections.concat([{ id: folder.id, name: displayName }]);
    setStatus('Saving...');
    try {
        const newFileId = await saveCollections(collectionsState.fileId, updated);
        collectionsState = { fileId: newFileId, collections: updated };
        await showCollectionsScreen();
    } catch (err) {
        console.error('Could not save the new collection:', err);
        setStatus(describeError(err, 'That collection could not be saved'));
    }
}

// ---------- opening a collection ----------
async function openCollection(col, opts) {
    contentEl.innerHTML = '';
    const p = document.createElement('p');
    p.textContent = `Opening "${col.name}"...`;
    contentEl.appendChild(p);

    if (state.offline) {
        const snap = await readSnapshot(SNAP.collection(col.id));
        if (!snap) {
            contentEl.innerHTML = '';
            await alertDialog(
                `"${col.name}" has not been saved for offline use yet. Open it once ` +
                `while connected and it will be available here afterwards.`,
                'Not available offline');
            await showCollectionsScreen({ fromSnapshot: true });
            return;
        }
        setStatus('');
        currentFolderInfo = snap.folderInfo || null;
        await showCollectionView(col, snap.value, opts);
        return;
    }

    setStatus('Reading folders and images...');
    // Warmed up but never awaited, and its rejection is swallowed here: this
    // promise is memoised and shared by every thumbnail, so an unhandled
    // rejection on it would surface later on each of them.
    getDriveThumbIndex().catch(err => console.warn('Thumbnail index warm-up failed:', err));

    try {
        // Folder metadata is fetched alongside the contents (not awaited
        // separately) purely so the info panel can show a creation date.
        const [countries, folderInfo] = await Promise.all([
            fetchCollectionData(col.id),
            getFolderInfo(col.id).catch(err => {
                console.warn('Could not read folder metadata:', err);
                return null;
            })
        ]);
        currentFolderInfo = folderInfo;
        setStatus('');
        // Everything needed to show this collection again with no connection,
        // including the folder date the info panel displays.
        saveSnapshot(SNAP.collection(col.id), countries, { folderInfo });
        await showCollectionView(col, countries, opts);
    } catch (err) {
        console.error(err);
        contentEl.innerHTML = '';
        const e = document.createElement('p');
        e.style.color = 'var(--accent-none)';
        e.textContent = describeError(err, `"${col.name}" could not be opened`);
        contentEl.appendChild(e);
        // A network failure is exactly when the saved copy is worth offering.
        if (isNetworkError(err)) {
            const snap = await readSnapshot(SNAP.collection(col.id));
            if (snap) {
                const useCache = document.createElement('button');
                useCache.className = 'legend-btn';
                useCache.style.justifyContent = 'center';
                useCache.textContent = 'Open the saved copy instead';
                useCache.onclick = async () => {
                    state.offline = true;
                    updateConnectionUi();
                    currentFolderInfo = snap.folderInfo || null;
                    await showCollectionView(col, snap.value, opts);
                };
                contentEl.appendChild(useCache);
            }
        }
        const back = document.createElement('button');
        back.className = 'legend-btn';
        back.style.justifyContent = 'center';
        back.textContent = 'Back to collections';
        back.onclick = () => showCollectionsScreen({ fromSnapshot: state.offline });
        contentEl.appendChild(back);
    }
}

async function showCollectionView(col, countries, opts) {
    // Re-opening the collection already on screen (a sign-in from offline mode
    // reloads it from Drive): tear the old map down first, and take no extra
    // history entry - the user did not navigate anywhere.
    const inPlace = !!(opts && opts.inPlace);
    if (inPlace) { destroyMap(); releaseModalObjectUrls(); }

    currentCollection = col;
    state.currentCollectionId = col.id;
    setModalCollectionName(col.name);
    await loadLayouts();

    state.cvCountries = countries;
    state.cvCountryMap = buildCountryMap(countries);
    rebuildCollectionData();

    document.getElementById('login-box').style.display = 'none';
    document.getElementById('collection-view').style.display = 'flex';
    document.getElementById('cv-title').textContent = col.name;

    renderViewToggle();
    renderItemTypeButton();
    updateConnectionUi();
    await initMap();
    renderList(); // after initMap, so countryNameLookup is populated
    if (!inPlace) history.pushState({ screen: 'collection' }, '');
}

function goBackToCollections(fromPopstate) {
    destroyMap();
    releaseModalObjectUrls();
    resetCollectionState();
    currentCollection = null;
    currentFolderInfo = null;
    setModalCollectionName('');
    document.getElementById('collection-view').style.display = 'none';
    document.getElementById('login-box').style.display = 'block';
    contentEl.innerHTML = '<p>Loading your collections...</p>';
    showCollectionsScreen({ fromSnapshot: state.offline });
    if (!fromPopstate) {
        state.suppressNextPopstate = true;
        history.back();
    }
}

// Makes the phone's back gesture close a modal or step back to the collections
// list first, instead of leaving the site immediately.
window.addEventListener('popstate', () => {
    if (state.suppressNextPopstate) { state.suppressNextPopstate = false; return; }
    if (isModalOpen()) {
        closeModal(true);
    } else if (document.getElementById('collection-view').style.display === 'flex') {
        goBackToCollections(true);
    }
});

// ---------- collection-view controls ----------
const MAP_ICON_SVG = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6"/><line x1="8" y1="2" x2="8" y2="18"/><line x1="16" y1="6" x2="16" y2="22"/></svg>';
const LIST_ICON_SVG = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>';

// ---------- banknotes / coins ----------
// Which folder an image came out of is what decides its kind, and the folder
// name's CASE is what says so: "ISR" holds banknotes, "isr" holds coins. Both
// are the same country on the map.
const SVG_OPEN = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" ' +
    'stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">';
const BANKNOTE_ICON_SVG = SVG_OPEN +
    '<rect x="2" y="6" width="20" height="12" rx="2"/>' +
    '<circle cx="12" cy="12" r="2.9"/>' +
    '<line x1="5.6" y1="9.8" x2="5.6" y2="14.2"/>' +
    '<line x1="18.4" y1="9.8" x2="18.4" y2="14.2"/></svg>';
const COIN_ICON_SVG = SVG_OPEN +
    '<circle cx="12" cy="12" r="8.6"/>' +
    '<circle cx="12" cy="12" r="4.6"/></svg>';
// Laid out side by side rather than overlapping: an overlap needs an opaque
// fill to cut the note out, and no single fill colour is right in both themes.
const BOTH_ICON_SVG = SVG_OPEN +
    '<rect x="1.4" y="3" width="13.2" height="8" rx="1.5"/>' +
    '<circle cx="8" cy="7" r="1.7"/>' +
    '<circle cx="16.4" cy="16.2" r="5.6"/>' +
    '<circle cx="16.4" cy="16.2" r="2.7"/></svg>';

const ITEM_TYPES = [
    { key: 'both', label: 'Showing: Banknotes and coins', icon: BOTH_ICON_SVG },
    { key: KIND_BANKNOTE, label: 'Showing: Banknotes only', icon: BANKNOTE_ICON_SVG },
    { key: KIND_COIN, label: 'Showing: Coins only', icon: COIN_ICON_SVG },
];

// Recomputed rather than stored, because "owned" is relative to what is being
// shown: with banknotes selected, a country you only have coins from has a
// count of zero and is painted as one you have nothing from.
function rebuildCollectionData() {
    state.collectionData = {};
    Object.entries(state.cvCountryMap).forEach(([code, entry]) => {
        const total = countryTotalCount(entry, state.itemType);
        if (total > 0) {
            state.collectionData[code] = { count: total, name: COUNTRY_NAMES[code] || code };
        }
    });
}

function renderItemTypeButton() {
    const btn = document.getElementById('item-type-btn');
    if (!btn) return;
    const mode = ITEM_TYPES.find(m => m.key === state.itemType) || ITEM_TYPES[0];
    btn.innerHTML = mode.icon;
    btn.title = mode.label;
    btn.setAttribute('aria-label', mode.label);
}

function renderViewToggle() {
    const btn = document.getElementById('view-toggle-btn');
    const showMap = state.currentView === 'map';
    document.getElementById('map').style.display = showMap ? 'block' : 'none';
    document.getElementById('list-view').style.display = showMap ? 'none' : 'block';
    // The icon shows where the button will take you NEXT, not the mode you are
    // already in - so on the map it is the list icon, and vice versa.
    btn.innerHTML = showMap ? LIST_ICON_SVG : MAP_ICON_SVG;
    const label = showMap ? 'Switch to List view' : 'Switch to Map view';
    btn.title = label;
    btn.setAttribute('aria-label', label);
    if (showMap) invalidateMapSize();
}

const COLOR_MODES = [
    { key: 'both', label: 'Coloring: Have items + None yet', color: 'linear-gradient(90deg, var(--accent-owned), var(--accent-none))' },
    { key: 'owned', label: 'Coloring: Have items', color: 'var(--accent-owned)' },
    { key: 'none', label: 'Coloring: None yet', color: 'var(--accent-none)' },
];

function renderColorModeButton() {
    const mode = COLOR_MODES.find(m => m.key === state.colorMode);
    const btn = document.getElementById('color-mode-btn');
    document.getElementById('color-mode-label').textContent = mode.label;
    document.getElementById('color-mode-dot').style.background = mode.color;
    btn.title = mode.label;
    btn.setAttribute('aria-label', mode.label);
}

function initControls() {
    const searchBox = document.getElementById('search-box');
    const searchGhost = document.getElementById('search-ghost');

    document.getElementById('view-toggle-btn').onclick = () => {
        state.currentView = state.currentView === 'map' ? 'list' : 'map';
        renderViewToggle();
    };

    document.getElementById('back-btn').onclick = () => goBackToCollections(false);

    document.getElementById('item-type-btn').onclick = () => {
        const idx = ITEM_TYPES.findIndex(m => m.key === state.itemType);
        state.itemType = ITEM_TYPES[(idx + 1) % ITEM_TYPES.length].key;
        renderItemTypeButton();
        // Ownership itself changes here, so the counts, the list and the map
        // colours all have to be rebuilt - in that order, because the list and
        // the map both read collectionData.
        rebuildCollectionData();
        renderList();
        applyFilters({ animate: true, durationMs: TRANSITION_MS });
    };

    function updateGhostSuggestion() {
        const typed = searchBox.value;
        if (typed === '') { searchGhost.value = ''; return; }
        const typedLower = typed.toLowerCase();
        const suggestion = Object.values(state.countryNameLookup)
            .find(n => n.toLowerCase().startsWith(typedLower));
        searchGhost.value = suggestion ? typed + suggestion.slice(typed.length) : '';
    }

    // The ghost suggestion updates instantly (it tracks the caret), but the
    // filter pass touches every country layer, so it is debounced - running it
    // on each keypress made typing lag on Android.
    let searchDebounce = null;
    searchBox.oninput = () => {
        state.searchQuery = searchBox.value;
        updateGhostSuggestion();
        clearTimeout(searchDebounce);
        searchDebounce = setTimeout(() => {
            const matched = applyFilters();
            if (searchBox.value.trim() !== '' && matched.length === 1) focusOnMatches(matched);
        }, 120);
    };
    searchBox.onkeydown = e => {
        if ((e.key === 'Tab' || e.key === 'ArrowRight') && searchGhost.value &&
            searchBox.selectionStart === searchBox.value.length) {
            e.preventDefault();
            searchBox.value = searchGhost.value;
            searchGhost.value = '';
            state.searchQuery = searchBox.value;
            focusOnMatches(applyFilters());
        } else if (e.key === 'Enter') {
            state.searchQuery = searchBox.value;
            focusOnMatches(applyFilters());
        }
    };

    document.getElementById('color-mode-btn').onclick = () => {
        const idx = COLOR_MODES.findIndex(m => m.key === state.colorMode);
        state.colorMode = COLOR_MODES[(idx + 1) % COLOR_MODES.length].key;
        renderColorModeButton();
        applyFilters({ animate: true, durationMs: TRANSITION_MS });
    };
    renderColorModeButton();

    document.getElementById('reset-btn').onclick = () => {
        searchBox.value = ''; searchGhost.value = '';
        state.searchQuery = '';
        state.clickedLabelCodes.clear();
        state.colorMode = 'both';
        renderColorModeButton();
        applyFilters({ animate: true });
        fitFrameToViewport();
    };

}

// ---------- sharing the whole collection ----------
// The options are stated as a size PER PHOTO, because that is something you can
// actually predict the result from: 40 photos at 0.5 MB is roughly a 20 MB
// file. The old "a tenth of size" told you nothing about the outcome.
const SHARE_SIZES = [
    { value: 1024 * 1024, label: '1 MB per photo',   hint: 'Best quality, largest file' },
    { value: 512 * 1024,  label: '0.5 MB per photo', hint: 'A good balance' },
    { value: 100 * 1024,  label: '0.1 MB per photo', hint: 'Smallest file, lowest quality' },
];

async function exportWholeCollection() {
    if (!currentCollection) return;
    closeCacheModal(); // launched from the info panel

    const countryCount = Object.keys(state.collectionData).length;
    const photoCount = uniqueImageCount(state.cvCountryMap);
    if (countryCount === 0) {
        await alertDialog('There is nothing to share yet.');
        return;
    }

    const choice = await showChoiceDialog({
        title: 'Share collection',
        message: `One file with every photo in "${currentCollection.name}" ` +
                 `(${photoCount} items, ${countryCount} countries) and a table of contents. ` +
                 `Pick how much detail each photo keeps.`,
        options: SHARE_SIZES.map(o => ({
            value: String(o.value),
            label: o.label,
            hint: `${o.hint} — about ${formatSize(o.value * photoCount)} in total`
        }))
    });
    if (!choice) return;

    const progress = showProgressDialog('Preparing', 'Collecting photos…', { cancellable: true });
    try {
        const result = await buildCollectionExport(
            currentCollection.name, Number(choice),
            (done, total) => progress.setMessage(`Preparing photo ${done} of ${total}…`),
            progress.signal
        );
        progress.close();
        await shareOrDownloadFile(result.blob, result.filename);
    } catch (err) {
        progress.close();
        if (isExportCancelled(err)) return; // the user asked to stop
        console.error('Collection share failed:', err);
        await alertDialog(describeError(err, 'That file could not be built'), 'Share failed');
    }
}

function formatSize(bytes) {
    return bytes >= 1024 * 1024
        ? (bytes / (1024 * 1024)).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1) + ' MB'
        : Math.round(bytes / 1024) + ' KB';
}

// Removes the OPEN collection from the app, then returns to the list. The same
// action used to live only on the collections screen; it is here too so
// everything about the open collection is in one place.
async function removeOpenCollection() {
    if (!currentCollection) return;
    closeCacheModal();
    const col = currentCollection;
    const ok = await confirmDialog(
        `Remove "${col.name}" from your collections list? This only removes it from ` +
        `this app - the folder and all photos stay exactly as they are in your Google Drive.`,
        { title: 'Remove collection', confirmLabel: 'Remove' }
    );
    if (!ok) return;

    const updated = collectionsState.collections.filter(c => c.id !== col.id);
    try {
        const newFileId = await saveCollections(collectionsState.fileId, updated);
        collectionsState = { fileId: newFileId, collections: updated };
        goBackToCollections(false);
    } catch (err) {
        console.error('Could not remove the collection:', err);
        await alertDialog(describeError(err, 'That collection could not be removed'), 'Remove failed');
    }
}

// ---------- info panel ----------
// Split in two on purpose: what belongs to THIS COLLECTION (what it is, when it
// was made, sharing it, removing it) and what belongs to THE APPLICATION
// (version, the thumbnail cache, recent errors).
function fact(dl, label, value) {
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    dd.textContent = value;
    dl.append(dt, dd);
}

// Always en-GB, never the device locale: the interface is in English, and on a
// Hebrew phone toLocaleDateString() with no locale produced a Hebrew month in
// the middle of an otherwise English panel.
function formatDate(iso) {
    if (!iso) return 'unknown';
    const d = new Date(iso);
    if (isNaN(d)) return 'unknown';
    return d.toLocaleDateString('en-GB', { year: 'numeric', month: 'long', day: 'numeric' });
}

function renderThumbErrors() {
    const box = document.getElementById('info-errors');
    box.innerHTML = '';
    if (!thumbErrors.length) return;
    thumbErrors.slice(0, 6).forEach(e => {
        const row = document.createElement('div');
        row.className = 'err-row';
        const stage = document.createElement('span');
        stage.className = 'err-stage';
        stage.textContent = e.stage + ' — ';
        row.appendChild(stage);
        row.appendChild(document.createTextNode(e.message));
        box.appendChild(row);
    });
}

// Both of these are LIVE state, so they get their own lines and are re-rendered
// whenever the connection changes. The panel used to print one "Status" line
// computed from a flag that was only ever set at startup, so it went on saying
// "Signed in" long after the connection had gone.
async function renderAppFacts() {
    const appDl = document.getElementById('info-app');
    appDl.innerHTML = '';
    fact(appDl, 'Version', APP_VERSION);
    fact(appDl, 'Connection', state.online ? 'Connected' : 'No connection');
    fact(appDl, 'Account', state.offline
        ? 'Not signed in - saved copy, changes disabled'
        : (state.online ? 'Signed in' : 'Signed in - changes disabled until the connection returns'));
    const snap = await readSnapshot(SNAP.collections);
    if (snap && snap.savedAt) {
        fact(appDl, 'Saved for offline', formatDate(new Date(snap.savedAt).toISOString()));
    }
}

function infoModalOpen() {
    return document.getElementById('cache-modal').style.display === 'block';
}

// Called from updateConnectionUi, so the panel corrects itself while it is open
// rather than showing whatever was true when it was first drawn.
function refreshInfoStatus() {
    if (!infoModalOpen()) return;
    renderAppFacts().catch(err => console.warn('Could not refresh the info panel:', err));
}

async function renderCacheStats() {
    const statsEl = document.getElementById('cache-modal-stats');
    const line = text => {
        const d = document.createElement('div');
        d.textContent = text;
        statsEl.appendChild(d);
        return d;
    };

    statsEl.textContent = 'Reading cache…';
    let local = null;
    try { local = await localCacheStats(); }
    catch (err) { console.warn('Could not read the local cache:', err); }

    statsEl.innerHTML = '';
    // The device cache is what actually makes a photo appear instantly, so it
    // is reported first - and reported at all, which it never used to be.
    if (local) {
        const parts = [`${local.thumbs} thumbnail${local.thumbs === 1 ? '' : 's'} ` +
                       `≈ ${formatSize(local.thumbBytes)}`];
        if (local.fulls) {
            parts.push(`${local.fulls} full-size photo${local.fulls === 1 ? '' : 's'} ` +
                       `≈ ${formatSize(local.fullBytes)}`);
        }
        line('On this device: ' + parts.join(', '));
    } else {
        line('On this device: the cache could not be read.');
    }

    if (!state.online) {
        line('In Drive: needs a connection.');
        return;
    }
    const driveLine = line('In Drive: reading…');
    try {
        const index = await getDriveThumbIndex();
        const count = index.size;
        const totalBytes = [...index.values()].reduce((sum, v) => sum + (v.size || 0), 0);
        driveLine.textContent = `In Drive: ${count} thumbnail${count === 1 ? '' : 's'} ` +
                                `≈ ${formatSize(totalBytes)}`;
        if (lastThumbUploadError) {
            const warn = document.createElement('div');
            warn.style.cssText = 'color:var(--accent-none);font-size:11px;margin-top:8px;';
            warn.textContent = 'Last upload error: ' + lastThumbUploadError;
            statsEl.appendChild(warn);
        }
    } catch (err) {
        driveLine.textContent = describeError(err, 'In Drive: the details could not be read');
    }
}

async function openInfoModal() {
    document.getElementById('cache-modal-backdrop').style.display = 'block';
    document.getElementById('cache-modal').style.display = 'block';

    const col = document.getElementById('info-collection');
    col.innerHTML = '';
    const hasCollection = !!currentCollection;
    if (hasCollection) {
        fact(col, 'Name', currentCollection.name);
        fact(col, 'Created', formatDate(currentFolderInfo && currentFolderInfo.createdTime));
        const countryCount = Object.keys(state.collectionData).length;
        const shownCount = uniqueImageCount(state.cvCountryMap, state.itemType);
        const shownLabel = state.itemType === KIND_BANKNOTE ? 'banknotes'
            : state.itemType === KIND_COIN ? 'coins' : 'items';
        fact(col, 'Showing', `${shownCount} ${shownLabel} in ${countryCount} ` +
            `countr${countryCount === 1 ? 'y' : 'ies'}`);

        // The whole collection, whatever is currently selected - and, most
        // usefully, how many folders were named neither all-caps nor all-
        // lowercase, since those are the ones to rename.
        const kinds = kindCounts(state.cvCountryMap);
        const parts = [`${kinds[KIND_BANKNOTE]} banknote${kinds[KIND_BANKNOTE] === 1 ? '' : 's'}`,
                       `${kinds[KIND_COIN]} coin${kinds[KIND_COIN] === 1 ? '' : 's'}`];
        if (kinds[KIND_UNKNOWN]) {
            parts.push(`${kinds[KIND_UNKNOWN]} unclassified (folder named neither ` +
                       `ALL CAPS nor all lowercase - shown in every mode)`);
        }
        fact(col, 'In total', parts.join(', '));
    } else {
        fact(col, 'Name', 'No collection open');
    }
    document.getElementById('export-btn').style.display = hasCollection ? 'flex' : 'none';
    document.getElementById('delete-collection-btn').style.display = hasCollection ? 'flex' : 'none';

    await renderAppFacts();
    renderThumbErrors();
    applyConnectionRestrictions();
    // The panel is the one place the connection is stated outright, so take the
    // chance to make sure the answer is current rather than up to 20s old.
    checkNow();
    await renderCacheStats();
}

function closeCacheModal() {
    document.getElementById('cache-modal-backdrop').style.display = 'none';
    document.getElementById('cache-modal').style.display = 'none';
}

document.getElementById('info-btn').onclick = openInfoModal;
document.getElementById('cache-modal-backdrop').onclick = closeCacheModal;
document.getElementById('cache-close-btn').onclick = closeCacheModal;
document.getElementById('export-btn').onclick = exportWholeCollection;
document.getElementById('delete-collection-btn').onclick = removeOpenCollection;
document.getElementById('info-signin-btn').onclick = () => { closeCacheModal(); attemptSignIn(); };
const bannerSignInBtn = document.getElementById('offline-banner-btn');
if (bannerSignInBtn) bannerSignInBtn.onclick = () => attemptSignIn();

// Clears BOTH caches. It used to delete only the Drive-side copies, so every
// picture still appeared instantly - offline included - immediately after
// "Clear cache" reported that nothing was cached. The device copies are what
// make a photo instant, and they were never touched.
document.getElementById('cache-clear-btn').onclick = async () => {
    const ok = await confirmDialog(
        state.online
            ? 'Delete every cached thumbnail, both on this device and in Drive? Photos are ' +
              'downloaded and shrunk again the next time each one is viewed.'
            : 'There is no connection, so only the copies stored on this device can be cleared. ' +
              'Photos will not be available offline until you reconnect and view them again. Continue?',
        { title: 'Clear cache', confirmLabel: 'Clear' }
    );
    if (!ok) return;
    const statsEl = document.getElementById('cache-modal-stats');
    statsEl.textContent = 'Clearing…';
    try {
        // Object URLs minted before the clear still point at blobs held in
        // memory, so a picture on screen would survive it. Dropping them means
        // the next view genuinely re-reads.
        releaseModalObjectUrls();
        await clearLocalImageCache();
        if (state.online) await clearDriveThumbCache();
        await renderCacheStats();
    } catch (err) {
        statsEl.textContent = describeError(err, 'The cache could not be cleared');
    }
};

// ---------- service worker (offline) ----------
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('sw.js').catch(err => {
            console.warn('Service worker registration failed:', err);
        });
    });
}

initModal();
initControls();
