// The per-country modal: viewing photos, the organise editor, and sharing.

import { state } from './state.js';
import { COUNTRY_NAMES } from './countries.js';
import { applyOrder } from './util.js';
import { modalThumbUrl, releaseModalObjectUrls, getFullImageBlobUrl, setEnlargeObjectUrl, clearThumbQueue } from './cache.js';
import { getCountryLayout, saveLayoutsToDrive, markLayoutDirty } from './layouts.js';
import { buildCountryExport, shareOrDownloadFile, isExportCancelled } from './export.js';
import { alertDialog, showProgressDialog } from './dialog.js';

const modal = document.getElementById('modal');
const modalBackdrop = document.getElementById('modal-backdrop');
const modalTitle = document.getElementById('modal-title');
const modalImages = document.getElementById('modal-images');

let currentModalCode = null;
let selectedForShare = new Set();
let shareSelectMode = false;
let organizeMode = false;
let draftCategories = [];
let draftUncategorizedOrder = [];
let editingCategoryIndex = null;

const HEADING_STYLE = 'color:var(--text-dim);font-size:14px;font-weight:normal;margin:16px 0 8px 0;text-align:center;border-top:1px solid var(--border);padding-top:12px;';

export function isModalOpen() { return modal.style.display === 'block'; }

// Set by app.js when a collection opens, so a shared country file can be named
// after the collection it came from.
let collectionName = '';
export function setModalCollectionName(name) { collectionName = name || ''; }
function currentCollectionName() { return collectionName; }

function updateHeaderIcons() {
    const idle = !shareSelectMode && !organizeMode;
    document.getElementById('share-icon-btn').style.display = idle ? 'flex' : 'none';
    document.getElementById('share-confirm-icon-btn').style.display = shareSelectMode ? 'flex' : 'none';
    document.getElementById('share-cancel-icon-btn').style.display = shareSelectMode ? 'flex' : 'none';
    document.getElementById('organize-icon-btn').style.display = idle ? 'flex' : 'none';
    document.getElementById('organize-confirm-icon-btn').style.display = organizeMode ? 'flex' : 'none';
    document.getElementById('organize-cancel-icon-btn').style.display = organizeMode ? 'flex' : 'none';
}

function setShareSelectMode(on) {
    shareSelectMode = on;
    updateHeaderIcons();
    renderModalContent(currentModalCode);
}

// Shown in place of a thumbnail that could not be produced. An image that
// silently never appears is impossible to report; this says what went wrong.
function thumbErrorCell(img, err) {
    const box = document.createElement('div');
    box.className = 'thumb-error';
    box.title = (img.name || '') + '\n' + ((err && err.message) ? err.message : String(err));
    const mark = document.createElement('div');
    mark.className = 'thumb-error-mark';
    mark.textContent = '!';
    const label = document.createElement('div');
    label.className = 'thumb-error-text';
    label.textContent = 'Could not load';
    box.append(mark, label);
    return box;
}

// ---------- normal view ----------
function renderImageGroup(images) {
    const grid = document.createElement('div');
    grid.className = 'thumb-grid';
    // Upper bound on columns only - auto-fill picks the real number from the
    // width available, so this just stops a 2-photo country being stretched
    // across a wide desktop modal.
    grid.style.setProperty('--cols', String(Math.min(6, Math.max(1, images.length))));

    images.forEach(img => {
        const wrapper = document.createElement('div');
        wrapper.style.cssText = 'position:relative;';

        const spinner = document.createElement('div');
        spinner.className = 'thumb-spinner';
        wrapper.appendChild(spinner);

        const el = document.createElement('img');
        el.alt = img.name || '';
        const refreshSelectedLook = () => {
            const isSelected = selectedForShare.has(img.id);
            el.style.opacity = (shareSelectMode && !isSelected) ? '0.3' : '1';
        };
        el.onclick = () => {
            if (shareSelectMode) {
                if (selectedForShare.has(img.id)) selectedForShare.delete(img.id);
                else selectedForShare.add(img.id);
                refreshSelectedLook();
            } else {
                showEnlarged(img.id);
            }
        };
        refreshSelectedLook();
        wrapper.appendChild(el);
        modalThumbUrl(img.id)
            .then(url => { el.src = url; spinner.remove(); })
            .catch(err => {
                // Say so in the cell rather than leaving a blank box or an
                // endless spinner - the reason is also kept for the info panel.
                spinner.remove();
                el.remove();
                wrapper.appendChild(thumbErrorCell(img, err));
            });

        grid.appendChild(wrapper);
    });
    return grid;
}

// ---------- organise editor ----------
function orderArrayFor(categoryIndex) {
    return categoryIndex === -1 ? draftUncategorizedOrder : draftCategories[categoryIndex].imageIds;
}

// Moves an image between categories (or to/from Uncategorized), creating a new
// category automatically if it moves past the first or last one.
function moveImageDirection(img, currentCatIndex, direction) {
    const currentArr = orderArrayFor(currentCatIndex);
    const idx = currentArr.indexOf(img.id);
    if (idx !== -1) currentArr.splice(idx, 1);

    let targetIndex = currentCatIndex + direction;
    if (direction === -1 && targetIndex < -1) {
        draftCategories.unshift({ name: 'New category', imageIds: [] });
        targetIndex = 0;
    } else if (direction === 1 && targetIndex >= draftCategories.length) {
        draftCategories.push({ name: 'New category', imageIds: [] });
        targetIndex = draftCategories.length - 1;
    }
    orderArrayFor(targetIndex).push(img.id);
    renderModalContent(currentModalCode);
}

function reorderWithin(categoryIndex, pos, direction) {
    const arr = orderArrayFor(categoryIndex);
    const newPos = pos + direction;
    if (newPos < 0 || newPos >= arr.length) return;
    [arr[pos], arr[newPos]] = [arr[newPos], arr[pos]];
    renderModalContent(currentModalCode);
}

function renderOrganizeSection(uncategorizedRaw, allOwnImages) {
    const container = modalImages;
    const uncategorized = applyOrder(draftUncategorizedOrder, uncategorizedRaw);
    // Keep draftUncategorizedOrder a COMPLETE, position-matched list (not just
    // the items manually moved) - that is what makes the left/right reorder
    // buttons work on it, the same way a category's imageIds array does.
    draftUncategorizedOrder = uncategorized.map(img => img.id);

    function buildDpad(posInCategory, categoryLength) {
        const grid = document.createElement('div');
        grid.style.cssText = 'display:grid;grid-template-columns:28px 28px 28px;grid-template-rows:26px 26px 26px;gap:3px;justify-content:center;margin:4px auto 0 auto;width:fit-content;';
        function mk(txt, row, col, disabled, title) {
            const b = document.createElement('button');
            b.textContent = txt;
            b.disabled = disabled;
            b.title = title;
            b.setAttribute('aria-label', title);
            b.style.cssText = `grid-row:${row};grid-column:${col};display:flex;align-items:center;justify-content:center;font-size:14px;line-height:1;padding:0;background:var(--panel-alt);border:1px solid var(--border);color:var(--text);border-radius:4px;cursor:pointer;${disabled ? 'opacity:0.3;' : ''}`;
            return b;
        }
        grid.appendChild(mk('▲', 1, 2, false, 'Move to previous category'));
        grid.appendChild(mk('◀', 2, 1, posInCategory === 0, 'Move earlier'));
        grid.appendChild(mk('▶', 2, 3, posInCategory === categoryLength - 1, 'Move later'));
        grid.appendChild(mk('▼', 3, 2, false, 'Move to next category'));
        return grid;
    }

    function imageCell(img, categoryIndex, posInCategory, categoryLength) {
        const wrapper = document.createElement('div');
        wrapper.style.cssText = 'display:inline-block;width:110px;margin:4px;vertical-align:top;text-align:center;';

        const imgBox = document.createElement('div');
        imgBox.style.cssText = 'position:relative;width:90px;height:90px;margin:0 auto;';
        wrapper.appendChild(imgBox);

        const spinner = document.createElement('div');
        spinner.className = 'thumb-spinner';
        imgBox.appendChild(spinner);

        const el = document.createElement('img');
        el.style.cssText = 'width:90px;height:90px;object-fit:contain;background:rgba(255,255,255,0.06);border-radius:6px;border:1px solid var(--border);padding:2px;';
        imgBox.appendChild(el);
        modalThumbUrl(img.id)
            .then(url => { el.src = url; spinner.remove(); })
            .catch(err => {
                spinner.remove();
                el.remove();
                imgBox.appendChild(thumbErrorCell(img, err));
            });

        const dpad = buildDpad(posInCategory, categoryLength);
        const buttons = dpad.querySelectorAll('button');
        buttons[0].onclick = () => moveImageDirection(img, categoryIndex, -1);
        buttons[1].onclick = () => reorderWithin(categoryIndex, posInCategory, -1);
        buttons[2].onclick = () => reorderWithin(categoryIndex, posInCategory, 1);
        buttons[3].onclick = () => moveImageDirection(img, categoryIndex, 1);
        wrapper.appendChild(dpad);
        return wrapper;
    }

    const uncatWrap = document.createElement('div');
    uncatWrap.style.cssText = 'text-align:center;';
    if (draftCategories.length > 0) {
        const uncatHeading = document.createElement('h3');
        uncatHeading.textContent = 'Uncategorized';
        uncatHeading.style.cssText = HEADING_STYLE;
        container.appendChild(uncatHeading);
    }
    uncategorized.forEach((img, pos) => uncatWrap.appendChild(imageCell(img, -1, pos, uncategorized.length)));
    if (uncategorized.length === 0 && draftCategories.length > 0) {
        const empty = document.createElement('p');
        empty.textContent = '(none)';
        empty.style.cssText = 'color:var(--text-dim);font-size:12px;';
        uncatWrap.appendChild(empty);
    }
    container.appendChild(uncatWrap);

    draftCategories.forEach((cat, catIdx) => {
        const header = document.createElement('div');
        header.style.cssText = 'display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin:18px 0 6px 0;border-top:1px solid var(--border);padding-top:12px;';

        const nameContainer = document.createElement('div');
        nameContainer.style.cssText = 'display:flex;align-items:center;gap:6px;flex:1;min-width:140px;';

        if (editingCategoryIndex === catIdx) {
            const nameInput = document.createElement('input');
            nameInput.type = 'text';
            nameInput.value = cat.name;
            nameInput.setAttribute('aria-label', 'Category name');
            nameInput.style.cssText = 'flex:1;min-width:120px;padding:6px 8px;border-radius:6px;border:1px solid var(--border);background:var(--panel-alt);color:var(--text);font-size:14px;';
            nameInput.oninput = () => { cat.name = nameInput.value; };
            nameInput.onkeydown = e => {
                if (e.key === 'Enter') { editingCategoryIndex = null; renderModalContent(currentModalCode); }
            };
            nameContainer.appendChild(nameInput);

            const saveBtn = document.createElement('button');
            saveBtn.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 12 9 17 20 6"/></svg>';
            saveBtn.title = 'Save name';
            saveBtn.setAttribute('aria-label', 'Save category name');
            saveBtn.style.cssText = 'flex-shrink:0;background:transparent;border:none;color:var(--accent-owned);cursor:pointer;padding:2px;display:flex;width:auto;margin:0;';
            saveBtn.onclick = () => { editingCategoryIndex = null; renderModalContent(currentModalCode); };
            nameContainer.appendChild(saveBtn);
        } else {
            const nameLabel = document.createElement('span');
            nameLabel.textContent = cat.name && cat.name.trim() ? cat.name : 'Untitled category';
            nameLabel.style.cssText = 'flex:1;min-width:60px;font-size:14px;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
            nameContainer.appendChild(nameLabel);

            const editBtn = document.createElement('button');
            editBtn.innerHTML = '&#9998;';
            editBtn.title = 'Rename';
            editBtn.setAttribute('aria-label', 'Rename category');
            editBtn.style.cssText = 'flex-shrink:0;background:transparent;border:none;color:var(--text-dim);cursor:pointer;font-size:13px;padding:2px;width:auto;margin:0;';
            editBtn.onclick = () => { editingCategoryIndex = catIdx; renderModalContent(currentModalCode); };
            nameContainer.appendChild(editBtn);
        }
        header.appendChild(nameContainer);

        const delBtn = document.createElement('button');
        delBtn.innerHTML = '&#128465;';
        delBtn.title = 'Delete category (images become uncategorized)';
        delBtn.setAttribute('aria-label', 'Delete category');
        delBtn.style.cssText = 'flex-shrink:0;width:26px;height:26px;padding:0;margin:0;background:transparent;border:1px solid var(--border);color:var(--accent-none);border-radius:4px;cursor:pointer;';
        delBtn.onclick = () => {
            draftUncategorizedOrder = draftUncategorizedOrder.concat(cat.imageIds);
            draftCategories.splice(catIdx, 1);
            if (editingCategoryIndex === catIdx) editingCategoryIndex = null;
            renderModalContent(currentModalCode);
        };
        header.appendChild(delBtn);
        container.appendChild(header);

        const catWrap = document.createElement('div');
        catWrap.style.cssText = 'text-align:center;';
        const imgs = cat.imageIds.map(id => allOwnImages.find(i => i.id === id)).filter(Boolean);
        imgs.forEach((img, pos) => catWrap.appendChild(imageCell(img, catIdx, pos, imgs.length)));
        if (imgs.length === 0) {
            const empty = document.createElement('p');
            empty.textContent = '(empty - use ▲ on a photo above to move it here)';
            empty.style.cssText = 'color:var(--text-dim);font-size:12px;';
            catWrap.appendChild(empty);
        }
        container.appendChild(catWrap);
    });
}

function renderModalContent(code) {
    const entry = state.cvCountryMap[code];
    if (!entry) return;
    modalTitle.textContent = COUNTRY_NAMES[code] || code;
    modalImages.innerHTML = '';

    const categories = organizeMode ? draftCategories : getCountryLayout(code).categories;
    const categorizedIds = new Set(categories.flatMap(c => c.imageIds));
    const uncategorizedRaw = entry.own.filter(img => !categorizedIds.has(img.id));
    const uncategorized = organizeMode
        ? uncategorizedRaw
        : applyOrder(getCountryLayout(code).uncategorizedOrder, uncategorizedRaw);

    if (organizeMode) {
        renderOrganizeSection(uncategorized, entry.own);
        return; // historical entries aren't editable in this pass
    }

    if (uncategorized.length > 0) {
        if (categories.length > 0) {
            const heading = document.createElement('h3');
            heading.textContent = 'Uncategorized';
            heading.style.cssText = HEADING_STYLE;
            modalImages.appendChild(heading);
        }
        modalImages.appendChild(renderImageGroup(uncategorized));
    }

    categories.forEach(cat => {
        const imgs = cat.imageIds.map(id => entry.own.find(i => i.id === id)).filter(Boolean);
        if (imgs.length === 0) return;
        const heading = document.createElement('h3');
        heading.textContent = cat.name;
        heading.style.cssText = HEADING_STYLE;
        modalImages.appendChild(heading);
        modalImages.appendChild(renderImageGroup(imgs));
    });

    Object.entries(entry.historical).forEach(([histCode, images]) => {
        if (images.length === 0) return;
        const heading = document.createElement('h3');
        heading.textContent = COUNTRY_NAMES[histCode] || histCode;
        heading.style.cssText = HEADING_STYLE;
        modalImages.appendChild(heading);
        modalImages.appendChild(renderImageGroup(images));
    });
}

export function openModal(code) {
    const entry = state.cvCountryMap[code];
    if (!entry) return;
    currentModalCode = code;
    organizeMode = false;

    const allImages = entry.own.concat(...Object.values(entry.historical));
    selectedForShare = new Set(allImages.map(img => img.id));
    shareSelectMode = false;
    updateHeaderIcons();

    renderModalContent(code);

    modal.style.display = 'block';
    modalBackdrop.style.display = 'block';
    document.getElementById('cv-main').classList.add('dimmed');
    history.pushState({ screen: 'modal' }, '');
}

export function closeModal(fromPopstate) {
    modal.style.display = 'none';
    modalBackdrop.style.display = 'none';
    document.getElementById('cv-main').classList.remove('dimmed');
    releaseModalObjectUrls(); // these belong to the modal that just closed
    clearThumbQueue();        // stop generating thumbnails for a country you left
    if (!fromPopstate) {
        // The handler must not treat this as a second "go back".
        state.suppressNextPopstate = true;
        history.back(); // consumes the 'modal' state pushed when it opened
    }
}

function showEnlarged(fileId) {
    const overlay = document.getElementById('enlarge-overlay');
    const img = document.getElementById('enlarge-img');
    overlay.style.display = 'block';
    getFullImageBlobUrl(fileId).then(url => {
        setEnlargeObjectUrl(url); // revokes the previous full-size image
        img.src = url;
    }).catch(err => console.error('Could not open full image', fileId, err));
}

// ---------- wiring ----------
export function initModal() {
    modalBackdrop.onclick = () => closeModal(false);

    document.getElementById('enlarge-overlay').onclick = function () {
        this.style.display = 'none';
        document.getElementById('enlarge-img').removeAttribute('src');
        setEnlargeObjectUrl(null);
    };

    document.getElementById('share-icon-btn').onclick = () => setShareSelectMode(true);
    document.getElementById('share-cancel-icon-btn').onclick = () => setShareSelectMode(false);

    document.getElementById('organize-icon-btn').onclick = () => {
        const layout = getCountryLayout(currentModalCode);
        draftCategories = JSON.parse(JSON.stringify(layout.categories));
        draftUncategorizedOrder = JSON.parse(JSON.stringify(layout.uncategorizedOrder));
        editingCategoryIndex = null;
        organizeMode = true;
        updateHeaderIcons();
        renderModalContent(currentModalCode);
    };

    document.getElementById('organize-cancel-icon-btn').onclick = () => {
        organizeMode = false;
        editingCategoryIndex = null;
        updateHeaderIcons();
        renderModalContent(currentModalCode);
    };

    document.getElementById('organize-confirm-icon-btn').onclick = async () => {
        const layout = getCountryLayout(currentModalCode);
        layout.categories = draftCategories;
        layout.uncategorizedOrder = draftUncategorizedOrder;
        markLayoutDirty(currentModalCode);
        try {
            await saveLayoutsToDrive();
        } catch (err) {
            console.error('Could not save categories:', err);
            await alertDialog('Could not save those categories: ' + (err.message || err), 'Save failed');
            return; // stay in organise mode so the work isn't lost
        }
        organizeMode = false;
        editingCategoryIndex = null;
        updateHeaderIcons();
        renderModalContent(currentModalCode);
    };

    document.getElementById('share-confirm-icon-btn').onclick = async () => {
        const code = currentModalCode;
        if (!state.cvCountryMap[code]) return;
        if (selectedForShare.size === 0) {
            await alertDialog('Select at least one photo to share (tap a photo to select it).');
            return;
        }

        const btn = document.getElementById('share-confirm-icon-btn');
        btn.style.opacity = '0.4';
        btn.style.pointerEvents = 'none';
        const progress = showProgressDialog('Preparing', 'Collecting photos…', { cancellable: true });
        try {
            const result = await buildCountryExport(
                code, selectedForShare,
                (done, total) => progress.setMessage(`Preparing photo ${done} of ${total}…`),
                progress.signal, currentCollectionName());
            progress.close();
            if (!result) {
                await alertDialog('None of the selected photos could be prepared.');
                return;
            }
            await shareOrDownloadFile(result.blob, result.filename);
            setShareSelectMode(false);
        } catch (err) {
            progress.close();
            if (isExportCancelled(err)) return; // the user asked to stop
            console.error('Share failed:', err);
            await alertDialog('Could not build that file: ' + (err.message || err), 'Share failed');
        } finally {
            btn.style.opacity = '1';
            btn.style.pointerEvents = 'auto';
        }
    };
}
