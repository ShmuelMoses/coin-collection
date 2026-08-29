// Entry point: boot, sign-in, the collections screen, and the collection view's
// control wiring.

import {
    API_KEY, APP_VERSION, TRANSITION_MS
} from './config.js';
import { initAuth, promptSignIn, trySilentSignIn, clearToken, getAccessToken } from './auth.js';
import { loadCollections, saveCollections, fetchCollectionData, getFolderInfo } from './drive.js';
import { getDriveThumbIndex, clearDriveThumbCache, lastThumbUploadError, releaseModalObjectUrls, thumbErrors } from './cache.js';
import { state, resetCollectionState } from './state.js';
import { COUNTRY_NAMES, buildCountryMap, countryTotalCount, uniqueImageCount } from './countries.js';
import { loadLayouts } from './layouts.js';
import { initModal, closeModal, isModalOpen, setModalCollectionName } from './modal.js';
import { renderList } from './list.js';
import {
    initMap, destroyMap, applyFilters, fitFrameToViewport,
    focusOnMatches, invalidateMapSize
} from './map.js';
import { buildCollectionExport, shareOrDownloadFile, isExportCancelled } from './export.js';
import { alertDialog, confirmDialog, promptDialog, showProgressDialog, showChoiceDialog } from './dialog.js';

const statusEl = document.getElementById('status');
const contentEl = document.getElementById('content');
const setStatus = msg => { statusEl.textContent = msg; };

document.getElementById('login-version').textContent = APP_VERSION;

let collectionsState = { fileId: null, collections: [] };
let currentCollection = null;
let currentFolderInfo = null; // {createdTime} for the open collection
let signedOutShown = false;

// ---------- boot ----------
function loadGapiClient() {
    gapi.load('client:picker', async () => {
        try {
            await gapi.client.init({ apiKey: API_KEY });
            await gapi.client.load('https://www.googleapis.com/discovery/v1/apis/drive/v3/rest');

            const btn = document.getElementById('signin-btn');
            btn.disabled = false;
            btn.textContent = 'Sign in with Google';

            initAuth({ onSignIn: startSignedInSession, onExpired: reportSignedOut });
            // Try a silent sign-in first: if access was granted before and the
            // Google session is still live, this logs back in with no click.
            trySilentSignIn();
        } catch (err) {
            console.error(err);
            setStatus('Failed to load Google API: ' + (err.message || JSON.stringify(err)));
        }
    });
}
window.onload = loadGapiClient;

document.getElementById('signin-btn').onclick = () => promptSignIn();

async function startSignedInSession() {
    signedOutShown = false;
    setStatus('Loading your collections...');
    try {
        await showCollectionsScreen();
    } catch (err) {
        console.error(err);
        setStatus('Error: ' + (err.message || JSON.stringify(err)));
    }
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
    btn.onclick = () => { signedOutShown = false; promptSignIn(); };
    contentEl.appendChild(btn);
    setStatus('Your Google sign-in expired. Please sign in again.');
}

// ---------- collections screen ----------
async function showCollectionsScreen() {
    const { fileId, collections } = await loadCollections();
    collectionsState = { fileId, collections };
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

    const addBtn = document.createElement('button');
    addBtn.className = 'primary-btn';
    addBtn.textContent = '+ Add new collection';
    addBtn.onclick = addNewCollection;
    contentEl.appendChild(addBtn);
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
        setStatus('Could not save that collection: ' + (err.message || err));
    }
}

// ---------- opening a collection ----------
async function openCollection(col) {
    contentEl.innerHTML = '';
    const p = document.createElement('p');
    p.textContent = `Opening "${col.name}"...`;
    contentEl.appendChild(p);
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
        await showCollectionView(col, countries);
    } catch (err) {
        console.error(err);
        contentEl.innerHTML = '';
        const e = document.createElement('p');
        e.style.color = 'var(--accent-none)';
        e.textContent = 'Error: ' + (err.message || JSON.stringify(err));
        contentEl.appendChild(e);
    }
}

async function showCollectionView(col, countries) {
    currentCollection = col;
    state.currentCollectionId = col.id;
    setModalCollectionName(col.name);
    await loadLayouts();

    state.cvCountries = countries;
    state.cvCountryMap = buildCountryMap(countries);
    state.collectionData = {};
    Object.entries(state.cvCountryMap).forEach(([code, entry]) => {
        const total = countryTotalCount(entry);
        if (total > 0) {
            state.collectionData[code] = { count: total, name: COUNTRY_NAMES[code] || code };
        }
    });

    document.getElementById('login-box').style.display = 'none';
    document.getElementById('collection-view').style.display = 'flex';
    document.getElementById('cv-title').textContent = col.name;

    renderViewToggle();
    await initMap();
    renderList(); // after initMap, so countryNameLookup is populated
    history.pushState({ screen: 'collection' }, '');
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
    showCollectionsScreen();
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
        await alertDialog('Could not build that file: ' + (err.message || err), 'Share failed');
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
        await alertDialog('Could not remove that collection: ' + (err.message || err), 'Remove failed');
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
        fact(col, 'Contents', `${uniqueImageCount(state.cvCountryMap)} items in ${countryCount} ` +
            `countr${countryCount === 1 ? 'y' : 'ies'}`);
    } else {
        fact(col, 'Name', 'No collection open');
    }
    document.getElementById('export-btn').style.display = hasCollection ? 'flex' : 'none';
    document.getElementById('delete-collection-btn').style.display = hasCollection ? 'flex' : 'none';

    const appDl = document.getElementById('info-app');
    appDl.innerHTML = '';
    fact(appDl, 'Version', APP_VERSION);

    renderThumbErrors();

    const statsEl = document.getElementById('cache-modal-stats');
    statsEl.textContent = 'Loading cache info…';
    try {
        const index = await getDriveThumbIndex();
        const count = index.size;
        const totalBytes = [...index.values()].reduce((sum, v) => sum + (v.size || 0), 0);
        const mb = (totalBytes / (1024 * 1024)).toFixed(1);
        statsEl.textContent = `${count} thumbnail${count === 1 ? '' : 's'} cached in Drive — ≈ ${mb} MB`;
        if (lastThumbUploadError) {
            const warn = document.createElement('div');
            warn.style.cssText = 'color:var(--accent-none);font-size:11px;margin-top:8px;';
            warn.textContent = 'Last upload error: ' + lastThumbUploadError;
            statsEl.appendChild(warn);
        }
    } catch (err) {
        statsEl.textContent = 'Could not read cache info: ' + (err.message || err);
    }
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
document.getElementById('cache-clear-btn').onclick = async () => {
    const ok = await confirmDialog(
        "Delete all cached thumbnails from Drive? They'll be regenerated automatically the next time each photo is viewed.",
        { title: 'Clear cache', confirmLabel: 'Clear' }
    );
    if (!ok) return;
    const statsEl = document.getElementById('cache-modal-stats');
    statsEl.textContent = 'Clearing…';
    try {
        await clearDriveThumbCache();
        statsEl.textContent = 'Cache cleared.';
    } catch (err) {
        statsEl.textContent = 'Failed to clear cache: ' + (err.message || err);
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
