// The per-country modal: viewing photos, the organise editor, and sharing.

import { state } from './state.js';
import { COUNTRY_NAMES, filterEntry } from './countries.js';
import { applyOrder, describeError } from './util.js';
import { modalThumbUrl, releaseModalObjectUrls, getFullImageBlobUrl, setEnlargeObjectUrl, clearThumbQueue } from './cache.js';
import {
    getCountryLayout, saveLayoutsToDrive, markLayoutDirty, propagateSharedLayout,
    uncategorizedLabel, DEFAULT_SECTION_NAME
} from './layouts.js';
import { buildCountryExport, shareOrDownloadFile, isExportCancelled } from './export.js';
import { alertDialog, confirmDialog, promptDialog, showProgressDialog } from './dialog.js';
import {
    proposeArrangement, isAutoArrangeCancelled,
    getStoredApiKey, storeApiKey
} from './autoarrange.js';

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
let draftUncategorizedName = '';
// The auto-arrange proposal currently on screen, or null. Holding it here
// rather than applying it straight away is the whole point: it is a suggestion
// until the tick is pressed.
let proposal = null;
// Which section's name is being typed into. A category is its index; the
// default section is -1, the same number that already means "uncategorized"
// everywhere else in this file (see moveImageDirection).
let editingCategoryIndex = null;

// The tick, the pencil and the bin were 16px icons with 2px of padding, so
// only a ~20px square actually took the click and the edges of the button did
// nothing. 32px is a real target, and centring the icon means every pixel of
// it counts rather than just the glyph.
const ICON_BTN_STYLE =
    'flex-shrink:0;width:32px;height:32px;padding:0;margin:0;' +
    'display:flex;align-items:center;justify-content:center;' +
    'background:transparent;border:none;cursor:pointer;line-height:1;';

const HEADING_STYLE = 'color:var(--text-dim);font-size:14px;font-weight:normal;margin:16px 0 8px 0;text-align:center;border-top:1px solid var(--border);padding-top:12px;';

export function isModalOpen() { return modal.style.display === 'block'; }

// Set by app.js when a collection opens, so a shared country file can be named
// after the collection it came from.
let collectionName = '';
export function setModalCollectionName(name) { collectionName = name || ''; }
function currentCollectionName() { return collectionName; }

function updateHeaderIcons() {
    const idle = !shareSelectMode && !organizeMode && !proposal;
    const auto = document.getElementById('auto-arrange-btn');
    if (auto) {
        auto.style.display = idle ? 'flex' : 'none';
        // It writes categories to Drive and needs the network, so it is off
        // for the same reasons organising is.
        auto.classList.toggle('offline-disabled', state.offline || !state.online);
    }
    // Organising writes categories back to Drive, so it is unavailable offline.
    document.getElementById('organize-icon-btn').classList.toggle('offline-disabled', state.offline);
    document.getElementById('share-icon-btn').style.display = idle ? 'flex' : 'none';
    document.getElementById('share-confirm-icon-btn').style.display = shareSelectMode ? 'flex' : 'none';
    document.getElementById('share-cancel-icon-btn').style.display = shareSelectMode ? 'flex' : 'none';
    document.getElementById('organize-icon-btn').style.display = idle ? 'flex' : 'none';
    // The proposal borrows organise mode's tick and cross rather than adding a
    // second pair that mean the same thing.
    const editing = organizeMode || !!proposal;
    document.getElementById('organize-confirm-icon-btn').style.display = editing ? 'flex' : 'none';
    document.getElementById('organize-cancel-icon-btn').style.display = editing ? 'flex' : 'none';
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

// Writes the draft to the layout and saves it. A tick means SAVED, wherever it
// is pressed: the tick beside a section name used to do nothing but close the
// text box, so a rename typed there was lost unless the top tick was pressed as
// well - and nothing said so. `exit` is what separates the two: the top tick
// finishes organising, a section's tick saves and leaves you in it.
//
// Saving the whole draft rather than just the name is deliberate. A tick that
// saved only the name would leave the arrangement unsaved behind it, so Cancel
// would then discard half of what was on screen and keep the other half.
async function commitOrganize(opts) {
    const exit = !!(opts && opts.exit);
    const code = currentModalCode;
    const layout = getCountryLayout(code);
    layout.categories = draftCategories;
    layout.uncategorizedOrder = draftUncategorizedOrder;
    layout.uncategorizedName = draftUncategorizedName.trim();
    markLayoutDirty(code);
    // Notes shared with other countries take this arrangement with them, so a
    // currency group only has to be organised once.
    const alsoChanged = propagateSharedLayout(code);
    if (alsoChanged.length) {
        console.log(`[layout] shared notes re-ordered in ${alsoChanged.length} other ` +
                    `countr${alsoChanged.length === 1 ? 'y' : 'ies'}: ${alsoChanged.join(', ')}`);
    }
    try {
        await saveLayoutsToDrive();
    } catch (err) {
        console.error('Could not save categories:', err);
        await alertDialog(describeError(err, 'Those categories could not be saved'), 'Save failed');
        return false; // stay in organise mode so the work isn't lost
    }
    if (exit) organizeMode = false;
    editingCategoryIndex = null;
    updateHeaderIcons();
    renderModalContent(code);
    return true;
}

// The name row for one section, used for the categories AND for the default
// section that holds everything not filed into one. They were different things
// - a category had a pencil and an editable name, the default section had the
// word "Uncategorized" written into the markup - so the one section people
// actually wanted to name was the only one that could not be.
function buildSectionHeader(opts) {
    const header = document.createElement('div');
    header.style.cssText = 'display:flex;flex-wrap:wrap;align-items:center;gap:8px;' +
        'margin:18px 0 6px 0;border-top:1px solid var(--border);padding-top:12px;';

    const nameContainer = document.createElement('div');
    nameContainer.style.cssText = 'display:flex;align-items:center;gap:6px;flex:1;min-width:140px;';

    // Saves, rather than just closing the text box. Not awaited by the click
    // handlers: commitOrganize re-renders when it is done, and the name is
    // already in the draft, so the row updates immediately either way.
    const finishEditing = () => { commitOrganize({ exit: false }); };

    if (editingCategoryIndex === opts.index) {
        const nameInput = document.createElement('input');
        nameInput.type = 'text';
        nameInput.value = opts.name || '';
        nameInput.placeholder = opts.fallback;
        nameInput.setAttribute('aria-label', 'Section name');
        nameInput.style.cssText = 'flex:1;min-width:120px;padding:6px 8px;border-radius:6px;' +
            'border:1px solid var(--border);background:var(--panel-alt);color:var(--text);font-size:14px;';
        nameInput.oninput = () => opts.onChange(nameInput.value);
        nameInput.onkeydown = e => { if (e.key === 'Enter') finishEditing(); };
        nameContainer.appendChild(nameInput);

        const saveBtn = document.createElement('button');
        saveBtn.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 12 9 17 20 6"/></svg>';
        saveBtn.title = 'Save name';
        saveBtn.setAttribute('aria-label', 'Save section name');
        saveBtn.style.cssText = ICON_BTN_STYLE + 'color:var(--accent-owned);';
        saveBtn.onclick = finishEditing;
        nameContainer.appendChild(saveBtn);
    } else {
        const nameLabel = document.createElement('span');
        const shown = (opts.name && opts.name.trim()) ? opts.name.trim() : opts.fallback;
        nameLabel.textContent = shown;
        nameLabel.style.cssText = 'flex:1;min-width:60px;font-size:14px;color:var(--text);' +
            'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
        nameContainer.appendChild(nameLabel);

        const editBtn = document.createElement('button');
        editBtn.innerHTML = '&#9998;';
        editBtn.title = 'Rename';
        editBtn.setAttribute('aria-label', 'Rename ' + shown);
        editBtn.style.cssText = ICON_BTN_STYLE + 'color:var(--text-dim);font-size:15px;';
        editBtn.onclick = () => { editingCategoryIndex = opts.index; renderModalContent(currentModalCode); };
        nameContainer.appendChild(editBtn);
    }
    header.appendChild(nameContainer);

    // The default section cannot be deleted - it is where everything not in a
    // category lives, so there is nowhere for its photos to go.
    if (opts.onDelete) {
        const delBtn = document.createElement('button');
        delBtn.innerHTML = '&#128465;';
        delBtn.title = 'Delete category (images become uncategorized)';
        delBtn.setAttribute('aria-label', 'Delete category');
        delBtn.style.cssText = ICON_BTN_STYLE +
            'color:var(--accent-none);border:1px solid var(--border);border-radius:4px;';
        delBtn.onclick = opts.onDelete;
        header.appendChild(delBtn);
    }
    return header;
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

    // The default section is renamed with exactly the same control as any
    // other, so there is nothing to learn twice - and it is offered even
    // before a category exists, so the name is ready when one is added.
    container.appendChild(buildSectionHeader({
        index: -1,
        name: draftUncategorizedName,
        fallback: DEFAULT_SECTION_NAME,
        onChange: value => { draftUncategorizedName = value; },
    }));

    const uncatWrap = document.createElement('div');
    uncatWrap.style.cssText = 'text-align:center;';
    uncategorized.forEach((img, pos) => uncatWrap.appendChild(imageCell(img, -1, pos, uncategorized.length)));
    if (uncategorized.length === 0 && draftCategories.length > 0) {
        const empty = document.createElement('p');
        empty.textContent = '(none)';
        empty.style.cssText = 'color:var(--text-dim);font-size:12px;';
        uncatWrap.appendChild(empty);
    }
    container.appendChild(uncatWrap);

    draftCategories.forEach((cat, catIdx) => {
        const header = buildSectionHeader({
            index: catIdx,
            name: cat.name,
            fallback: 'Untitled category',
            onChange: value => { cat.name = value; },
            onDelete: () => {
                draftUncategorizedOrder = draftUncategorizedOrder.concat(cat.imageIds);
                draftCategories.splice(catIdx, 1);
                if (editingCategoryIndex === catIdx) editingCategoryIndex = null;
                renderModalContent(currentModalCode);
            },
        });
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

// The country as the current banknotes/coins/both selection sees it. Organise
// mode is the one exception and deliberately gets the WHOLE country: it saves
// the category lists and the manual order wholesale, so arranging a country
// while half of it was filtered out of view would drop the hidden half from
// the saved layout.
function entryFor(code, whole) {
    const entry = state.cvCountryMap[code];
    if (!entry) return null;
    return whole ? entry : filterEntry(entry, state.itemType);
}

// ---------- auto arrange ----------
// Runs the country's photos through Gemini and shows what it worked out. The
// proposal is rendered into the modal like organise mode, so the photos are
// visible under each proposed name: the whole judgement is "do these belong
// together, and is that date range right", which cannot be made from a list of
// names alone.
function renderProposal(code) {
    modalTitle.textContent = COUNTRY_NAMES[code] || code;
    modalImages.innerHTML = '';

    const note = document.createElement('p');
    note.className = 'proposal-note';
    note.textContent = proposal.categories.length
        ? 'Suggested categories. Nothing is saved until you press the tick - ' +
          'edit any name first, or press the cross to throw it away.'
        : 'Nothing could be identified confidently enough to suggest a category.';
    modalImages.appendChild(note);

    proposal.categories.forEach((cat, idx) => {
        const head = document.createElement('div');
        head.className = 'proposal-head';

        const input = document.createElement('input');
        input.type = 'text';
        input.value = cat.name;
        input.setAttribute('aria-label', 'Suggested category name');
        input.oninput = () => { proposal.categories[idx].name = input.value; };
        head.appendChild(input);

        const count = document.createElement('span');
        count.className = 'count';
        count.textContent = `${cat.imageIds.length} item${cat.imageIds.length === 1 ? '' : 's'}`;
        head.appendChild(count);
        modalImages.appendChild(head);

        const imgs = cat.imageIds.map(id => proposal.byId.get(id)).filter(Boolean);
        modalImages.appendChild(renderImageGroup(imgs));
    });

    if (proposal.unsure.length) {
        const left = document.createElement('div');
        left.className = 'proposal-unsure';
        left.textContent = `${proposal.unsure.length} item` +
            `${proposal.unsure.length === 1 ? '' : 's'} left where they are - ` +
            `the series or its dates could not be established.`;
        modalImages.appendChild(left);
    }
    if (proposal.failures && proposal.failures.length) {
        const f = document.createElement('div');
        f.className = 'proposal-unsure';
        // The reason, not just the count. A bare "4 photos could not be read"
        // is the same sentence whether one photo is blurred or the whole
        // feature is broken, and there is no way to tell them apart without
        // opening the console - which is how a retired model name spent a
        // release looking like four unreadable photos.
        const why = commonFailure(proposal.failures);
        f.textContent = `${proposal.failures.length} photo` +
            `${proposal.failures.length === 1 ? '' : 's'} could not be read at all` +
            (why ? `: ${why}` : '.');
        modalImages.appendChild(f);
    }
}

// If every failure says the same thing, it is not the photos - it is the
// connection, the key or the service, and that one sentence is worth showing.
function commonFailure(failures) {
    const messages = failures.map(f => (f && f.message) || '');
    const first = messages[0];
    if (!first || !messages.every(m => m === first)) return '';
    return first.length > 160 ? first.slice(0, 157) + '…' : first;
}

// Asks once and remembers, on this device only. The key is the user's own: an
// unrestricted Google API key can reach Gemini, so one published in a static
// site is a key anyone can bill.
async function ensureApiKey() {
    let key = await getStoredApiKey().catch(() => '');
    if (key) return key;
    const typed = await promptDialog(
        'Paste a Google AI Studio API key (aistudio.google.com/apikey).\n\n' +
        'It is stored on this device only - never in the app, never in Drive - ' +
        'so it is yours and it is not published anywhere.',
        '', { title: 'Auto arrange' });
    key = (typed || '').trim();
    if (!key) return '';
    await storeApiKey(key).catch(err => console.warn('Could not store the key:', err));
    return key;
}

async function runAutoArrange() {
    const code = currentModalCode;
    const entry = entryFor(code, false);
    if (!entry) return;
    const images = entry.own.concat(...Object.values(entry.historical));
    if (!images.length) { await alertDialog('There is nothing here to arrange.'); return; }

    const key = await ensureApiKey();
    if (!key) return;

    const progress = showProgressDialog('Auto arrange',
        `Looking at ${images.length} item${images.length === 1 ? '' : 's'}…`, { cancellable: true });
    let result;
    try {
        result = await proposeArrangement(images, key,
            (done, total) => progress.setMessage(`Looking at item ${done} of ${total}…`),
            progress.signal);
        progress.close();
    } catch (err) {
        progress.close();
        if (isAutoArrangeCancelled(err)) return;
        console.error('Auto arrange failed:', err);
        // A rejected key is the one failure worth offering to fix on the spot.
        if (err.status === 400 || err.status === 401 || err.status === 403) {
            const again = await confirmDialog(
                'Google rejected that API key. Enter a different one?',
                { title: 'Auto arrange', confirmLabel: 'Change key' });
            if (again) { await storeApiKey(''); runAutoArrange(); }
            return;
        }
        await alertDialog(describeError(err, 'Those items could not be identified'), 'Auto arrange');
        return;
    }

    proposal = {
        categories: result.categories,
        unsure: result.unsure,
        failures: result.failures,
        byId: new Map(images.map(i => [i.id, i])),
    };
    updateHeaderIcons();
    renderProposal(code);
}

// Accepting it: the proposed categories are laid OVER whatever is there, and
// anything not placed keeps its position. Existing categories are kept - this
// adds to the arrangement rather than replacing it - except where a name
// collides, which is merged rather than duplicated.
function applyProposal() {
    const code = currentModalCode;
    const layout = getCountryLayout(code);
    const placed = new Set();

    proposal.categories.forEach(cat => {
        const name = (cat.name || '').trim();
        if (!name || !cat.imageIds.length) return;
        let target = layout.categories.find(c => c.name === name);
        if (!target) { target = { name, imageIds: [] }; layout.categories.push(target); }
        cat.imageIds.forEach(id => {
            if (!target.imageIds.includes(id)) target.imageIds.push(id);
            placed.add(id);
        });
    });
    // A photo can only be in one category, so take it out of any other.
    layout.categories.forEach(c => {
        if (proposal.categories.some(p => (p.name || '').trim() === c.name)) return;
        c.imageIds = c.imageIds.filter(id => !placed.has(id));
    });
    layout.uncategorizedOrder = layout.uncategorizedOrder.filter(id => !placed.has(id));
    return placed.size;
}

function renderModalContent(code) {
    if (proposal) { renderProposal(code); return; }
    const entry = entryFor(code, organizeMode);
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
            heading.textContent = organizeMode
                ? (draftUncategorizedName.trim() || DEFAULT_SECTION_NAME)
                : uncategorizedLabel(getCountryLayout(code));
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
    const entry = entryFor(code, false);
    if (!entry) return;
    currentModalCode = code;
    organizeMode = false;
    proposal = null;

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
        draftUncategorizedName = layout.uncategorizedName || '';
        editingCategoryIndex = null;
        organizeMode = true;
        updateHeaderIcons();
        renderModalContent(currentModalCode);
    };

    document.getElementById('organize-cancel-icon-btn').onclick = () => {
        // Throwing away a proposal changes nothing: it was never applied.
        if (proposal) {
            proposal = null;
            updateHeaderIcons();
            renderModalContent(currentModalCode);
            return;
        }
        organizeMode = false;
        editingCategoryIndex = null;
        updateHeaderIcons();
        renderModalContent(currentModalCode);
    };

    document.getElementById('auto-arrange-btn').onclick = () => {
        if (document.getElementById('auto-arrange-btn').classList.contains('offline-disabled')) return;
        runAutoArrange();
    };

    document.getElementById('organize-confirm-icon-btn').onclick = async () => {
        // The same tick accepts a proposal. Applying it writes into the layout,
        // and commitOrganize is then what actually saves it - so accepting a
        // suggestion goes through exactly the same save as arranging by hand.
        if (proposal) {
            const placed = applyProposal();
            proposal = null;
            draftCategories = JSON.parse(JSON.stringify(getCountryLayout(currentModalCode).categories));
            draftUncategorizedOrder =
                JSON.parse(JSON.stringify(getCountryLayout(currentModalCode).uncategorizedOrder));
            draftUncategorizedName = getCountryLayout(currentModalCode).uncategorizedName || '';
            const ok = await commitOrganize({ exit: true });
            if (ok && !placed) await alertDialog('Nothing was placed into a category.');
            return;
        }
        commitOrganize({ exit: true });
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
            await alertDialog(describeError(err, 'That file could not be built'), 'Share failed');
        } finally {
            btn.style.opacity = '1';
            btn.style.pointerEvents = 'auto';
        }
    };
}
