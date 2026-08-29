// The alphabetical list view and its stats line.

import { state, isOwned, passesFilters } from './state.js';
import { uniqueImageCount } from './countries.js';
import { openModal } from './modal.js';

// code -> row element. Kept so the filter pass can show/hide rows directly
// instead of re-running querySelectorAll on every keystroke.
export const countryRowEls = new Map();

export function renderList() {
    const listDiv = document.getElementById('list-view');
    listDiv.innerHTML = '';

    // Every country in the world, not just owned ones, so the "None yet"
    // filter has something to show. Owned sort to the top, rest alphabetical.
    const entries = Object.keys(state.countryNameLookup).map(code => ({
        code,
        name: state.countryNameLookup[code],
        owned: isOwned(code),
        count: state.collectionData[code] ? state.collectionData[code].count : 0
    }));
    entries.sort((a, b) => {
        if (a.owned !== b.owned) return a.owned ? -1 : 1;
        return a.name.localeCompare(b.name);
    });

    // Counts each physical note once - a note shared between countries by the
    // currency merge carries the same file id in each, so summing the
    // per-country counts would count it several times over.
    const totalItems = uniqueImageCount(state.cvCountryMap);
    const ownedCount = entries.filter(e => e.owned).length;
    const worldCount = entries.length;
    const pct = worldCount ? Math.round((ownedCount / worldCount) * 100) : 0;

    const stats = document.createElement('div');
    stats.id = 'list-stats';
    stats.textContent = `${totalItems} item${totalItems === 1 ? '' : 's'} from ${ownedCount} ` +
        `countr${ownedCount === 1 ? 'y' : 'ies'} — ${ownedCount}/${worldCount} of the world (${pct}%)`;
    listDiv.appendChild(stats);

    // Built into a fragment and appended once, rather than ~250 separate
    // appends into the live DOM.
    countryRowEls.clear();
    const frag = document.createDocumentFragment();
    entries.forEach(entry => {
        const item = document.createElement('div');
        item.className = 'country-item';
        item.dataset.code = entry.code;
        item.dataset.name = entry.name.toLowerCase();
        if (!entry.owned) item.style.opacity = '0.5';

        const nameSpan = document.createElement('span');
        nameSpan.textContent = entry.name;
        const countSpan = document.createElement('span');
        countSpan.className = 'count';
        countSpan.textContent = entry.owned ? String(entry.count) : '';
        item.append(nameSpan, countSpan);

        if (entry.owned) item.onclick = () => openModal(entry.code);
        countryRowEls.set(entry.code, item);
        frag.appendChild(item);
    });
    listDiv.appendChild(frag);

    // Apply whatever filter is currently active to the freshly built rows.
    countryRowEls.forEach((item, code) => {
        item.style.display = passesFilters(code, item.dataset.name) ? 'flex' : 'none';
    });
}
