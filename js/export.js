// Builds self-contained HTML files with the images embedded as data URIs, so
// whoever opens one needs no Drive access, no sign-in and no waiting.

import { escapeHtml, blobToBase64, applyOrder } from './util.js';
import { fetchFullImageBlob, resizeImageBlob } from './cache.js';
import { COUNTRY_NAMES, filterEntry, kindCounts, KIND_BANKNOTE, KIND_COIN } from './countries.js';
import { getCountryLayout, uncategorizedLabel } from './layouts.js';
import { buildWorldSvg } from './geo.js';
import { OWNED_COLOR, NONE_COLOR } from './config.js';
import { state } from './state.js';

// The exported page is a standalone document with no access to this app's CSS
// variables, so the palette values are necessarily written out here. This is
// the one legitimate place in the codebase for literal colours.
const EXPORT_CSS = `
body{font-family:Georgia,'Times New Roman',serif;background:#ded0ab;color:#3b2a1a;margin:0;padding:24px 12px;}
/* Each section is a leaf of the book: its own sheet on screen, its own sheet
   on paper. The old export was one continuous scroll with a page break before
   every country, which printed correctly but never looked like anything. */
.page{background:#ece2c8;max-width:900px;margin:0 auto 26px auto;padding:34px 30px 22px 30px;
      border:1px solid rgba(59,42,26,0.25);border-radius:3px;
      box-shadow:0 2px 10px rgba(59,42,26,0.18);text-align:center;}
h1{color:#4b6b3a;font-size:34px;margin:0 0 4px 0;letter-spacing:0.01em;}
h2{color:#4b6b3a;border-bottom:1px solid rgba(59,42,26,0.25);padding-bottom:6px;margin:0 0 18px 0;text-align:left;}
h3{color:rgba(59,42,26,0.7);font-weight:normal;border-top:1px solid rgba(59,42,26,0.25);
   padding-top:12px;margin-top:20px;text-align:left;}
.grid{display:flex;flex-wrap:wrap;gap:12px;justify-content:center;}
img{max-width:280px;max-height:280px;border-radius:6px;border:1px solid rgba(59,42,26,0.3);
    background:rgba(59,42,26,0.06);padding:4px;box-sizing:border-box;}
.cover{padding-top:46px;}
.cover .sub{color:rgba(59,42,26,0.7);font-size:15px;font-style:italic;margin:0 0 26px 0;}
.cover svg{display:block;margin:0 auto;max-width:100%;height:auto;}
.toc{text-align:left;columns:4;column-gap:24px;font-size:13px;line-height:1.7;}
.toc div{break-inside:avoid;}
.toc a{color:#4b6b3a;text-decoration:none;}
.toc a:hover{text-decoration:underline;}
.toc .count{color:rgba(59,42,26,0.55);}
.stats{text-align:left;max-width:560px;margin:0;font-size:15px;line-height:1.9;}
.stats dt{color:rgba(59,42,26,0.55);font-size:11px;letter-spacing:0.08em;text-transform:uppercase;margin-top:14px;}
.stats dd{margin:0;}
.meta{color:rgba(59,42,26,0.7);font-size:14px;margin:6px 0 0 0;}
.shared-note{text-align:left;font-size:13px;color:rgba(59,42,26,0.7);
             border-top:1px solid rgba(59,42,26,0.25);padding-top:12px;margin-top:20px;font-style:italic;}
.shared-note a{color:#4b6b3a;}
.back{margin:26px 0 0 0;padding-top:12px;border-top:1px solid rgba(59,42,26,0.18);
      font-size:12px;text-align:center;}
.back a{color:rgba(59,42,26,0.6);text-decoration:none;}
.back a:hover{text-decoration:underline;}
@media (max-width:700px){.toc{columns:2;}}
@media print{
  body{background:#fff;padding:0;}
  .page{break-after:page;box-shadow:none;border:none;margin:0;max-width:none;min-height:0;}
  .page:last-child{break-after:auto;}
  img{max-width:200px;max-height:200px;}
  .back{display:none;}
}
`;


// Groups a country's images the same way the modal shows them: uncategorised
// first, then saved categories in order, then historical entities.
export function orderedGroupsFor(code) {
    // Shares what is on screen: with coins selected, a shared file holds the
    // coins, not the whole country.
    const entry = filterEntry(state.cvCountryMap[code], state.itemType);
    if (!entry) return [];
    const layout = getCountryLayout(code);
    const categorizedIds = new Set(layout.categories.flatMap(c => c.imageIds));
    const uncategorizedRaw = entry.own.filter(img => !categorizedIds.has(img.id));
    const uncategorized = applyOrder(layout.uncategorizedOrder, uncategorizedRaw);

    const groups = [];
    if (uncategorized.length > 0) {
        groups.push({
            heading: layout.categories.length > 0 ? uncategorizedLabel(layout) : null,
            images: uncategorized
        });
    }
    layout.categories.forEach(cat => {
        const imgs = cat.imageIds.map(id => entry.own.find(i => i.id === id)).filter(Boolean);
        if (imgs.length > 0) groups.push({ heading: cat.name, images: imgs });
    });
    Object.entries(entry.historical).forEach(([histCode, images]) => {
        if (images.length > 0) groups.push({ heading: COUNTRY_NAMES[histCode] || histCode, images });
    });
    return groups;
}

// Encodes ONE image to at most `maxBytes`, by shrinking and re-encoding until
// it fits. Area scales with the square of the linear factor, so sqrt(overshoot)
// is the right correction and this converges in two or three passes. A
// per-image budget is what makes the total size predictable: N photos at 0.5 MB
// is about N/2 MB, which is something you can actually reason about, unlike
// "a tenth of the original".
const MAX_ENCODE_PASSES = 4;
const START_MAX_DIM = 1600;

async function encodeToBudget(fullBlob, maxBytes) {
    let maxDim = START_MAX_DIM;
    let quality = 0.82;
    let best = null;

    for (let pass = 0; pass < MAX_ENCODE_PASSES; pass++) {
        const blob = await resizeImageBlob(fullBlob, Math.round(maxDim), quality);
        if (!blob) break;
        best = blob;
        if (blob.size <= maxBytes) break;
        const overshoot = blob.size / maxBytes;
        if (quality > 0.55 && overshoot < 1.6) {
            // Only a little over: drop quality before losing resolution.
            quality = Math.max(0.5, quality - 0.15);
        } else {
            maxDim = Math.max(120, maxDim / Math.sqrt(overshoot) * 0.95);
        }
    }
    return best;
}

// `budgetBytes` is the per-image ceiling. `signal` is an AbortSignal: it is
// both checked between photos AND handed to the download itself, so pressing
// Cancel tears down the transfer in flight instead of waiting for it.
//
// Concurrency is deliberately low for the same reason as the thumbnail queue -
// decoding several full-resolution photos at once is what exhausts a phone.
const EXPORT_CONCURRENCY = 2;

function abortError() {
    const e = new Error('cancelled');
    e.name = 'AbortError';
    return e;
}
function isAbort(err) {
    return !!err && (err.name === 'AbortError' || err.message === 'cancelled');
}
export { isAbort as isExportCancelled };

async function encodeImages(images, budgetBytes, onProgress, signal) {
    const dataUrlById = {};
    let done = 0;
    let next = 0;

    async function worker() {
        while (next < images.length) {
            if (signal && signal.aborted) throw abortError();
            const img = images[next++];
            try {
                const fullBlob = await fetchFullImageBlob(img.id, signal);
                const smallBlob = await encodeToBudget(fullBlob, budgetBytes);
                if (smallBlob) dataUrlById[img.id] = await blobToBase64(smallBlob);
            } catch (err) {
                if (isAbort(err) || (signal && signal.aborted)) throw abortError();
                console.warn('Skipping image that could not be exported:', img.id, err);
            }
            done++;
            if (onProgress) onProgress(done, images.length);
        }
    }

    await Promise.all(
        Array.from({ length: Math.min(EXPORT_CONCURRENCY, images.length) }, worker)
    );
    return dataUrlById;
}

function groupsToHtml(groups, dataUrlById, headingTag) {
    let html = '';
    groups.forEach(group => {
        const imgs = group.images.filter(img => dataUrlById[img.id]);
        if (!imgs.length) return;
        if (group.heading) html += `<${headingTag}>${escapeHtml(group.heading)}</${headingTag}>`;
        html += '<div class="grid">';
        imgs.forEach(img => { html += `<img src="${dataUrlById[img.id]}">`; });
        html += '</div>';
    });
    return html;
}

// Filenames carry the collection name and the export date, so a folder of
// these stays sortable and you can tell two exports of the same thing apart.
// ISO order (YYYY-MM-DD) because it sorts correctly as text.
function exportDateStamp() {
    const d = new Date();
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function safeName(text) {
    return String(text).trim().replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, '_') || 'collection';
}

function wrapDocument(title, bodyHtml) {
    return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${EXPORT_CSS}</style></head>
<body>
${bodyHtml}
</body></html>`;
}

// ---------- one country ----------
export const DEFAULT_IMAGE_BUDGET = 512 * 1024; // 0.5 MB per photo

export async function buildCountryExport(code, selectedIds, onProgress, signal, collectionName) {
    const groups = orderedGroupsFor(code)
        .map(g => ({ heading: g.heading, images: g.images.filter(img => selectedIds.has(img.id)) }))
        .filter(g => g.images.length > 0);
    const all = groups.flatMap(g => g.images);
    if (!all.length) return null;

    const dataUrlById = await encodeImages(all, DEFAULT_IMAGE_BUDGET, onProgress, signal);
    const countryName = COUNTRY_NAMES[code] || code;
    // One country, so shared issues stay in place: there is no other section
    // here to send the reader to.
    const body = `<section class="page"><h1>${escapeHtml(countryName)}</h1>` +
        groupsToHtml(groups, dataUrlById, 'h3') + `</section>`;
    const prefix = collectionName ? safeName(collectionName) + '_' : '';
    return {
        blob: new Blob([wrapDocument(`${countryName} - Banknotes & Coins`, body)], { type: 'text/html' }),
        filename: `${prefix}${safeName(countryName)}_${exportDateStamp()}.html`
    };
}

// ---------- the whole collection ----------
// One document with a table of contents and every owned country in order. The
// per-country export shrinks by 4; this one shrinks harder by default because
// a large collection would otherwise run to hundreds of megabytes.
// `budgetBytes` is the ceiling for EACH photo, so the finished file lands near
// (number of photos x budget) and the user can predict it from the option they
// picked. The previous "full size" option built one enormous string and could
// fail outright with "Invalid string length" once the document passed the
// engine's maximum string size - a per-image budget removes that cliff.
// Splits a country's groups into its OWN images and the ones it shares with
// other countries through a currency pool. The shared ones are listed once, in
// the pool's own section, instead of being repeated in all 27 euro countries.
function splitShared(groups) {
    const own = [];
    const shared = [];
    groups.forEach(g => {
        const mine = g.images.filter(img => !img.sharedGroup);
        g.images.forEach(img => { if (img.sharedGroup) shared.push(img); });
        if (mine.length) own.push({ heading: g.heading, images: mine });
    });
    return { own, shared };
}

const groupLabel = code => COUNTRY_NAMES[code] || code;
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

export async function buildCollectionExport(collectionName, budgetBytes, onProgress, signal) {
    const codes = Object.keys(state.collectionData)
        .sort((a, b) => (COUNTRY_NAMES[a] || a).localeCompare(COUNTRY_NAMES[b] || b));

    // Pools first: a country's section needs to know where to send the reader.
    const pools = new Map(); // group code -> {images in order, ids}
    const perCountry = [];
    codes.forEach(code => {
        const { own, shared } = splitShared(orderedGroupsFor(code));
        const groupsUsed = new Set();
        shared.forEach(img => {
            groupsUsed.add(img.sharedGroup);
            let pool = pools.get(img.sharedGroup);
            if (!pool) { pool = { images: [], ids: new Set() }; pools.set(img.sharedGroup, pool); }
            // The first country to mention it sets the order. Since arranging
            // one country now arranges the shared notes in all of them, every
            // country would give the same answer anyway.
            if (!pool.ids.has(img.id)) { pool.ids.add(img.id); pool.images.push(img); }
        });
        perCountry.push({
            code, groups: own,
            sharedCount: shared.length,
            sharedGroups: [...groupsUsed].sort(),
        });
    });

    const sections = perCountry
        .filter(c => c.groups.length > 0 || c.sharedCount > 0)
        .map(c => ({
            kind: 'country', id: 'c-' + c.code, name: COUNTRY_NAMES[c.code] || c.code,
            // Everything the country holds, shared issues included: those are
            // printed under the pool, but they are still Greece's notes.
            count: c.groups.reduce((s, g) => s + g.images.length, 0) + c.sharedCount,
            groups: c.groups, sharedCount: c.sharedCount, sharedGroups: c.sharedGroups,
        }))
        .concat([...pools.entries()].map(([code, pool]) => ({
            kind: 'pool', id: 'g-' + code, name: groupLabel(code),
            count: pool.images.length,
            groups: [{ heading: null, images: pool.images }],
            sharedCount: 0, sharedGroups: [],
        })))
        .sort((a, b) => a.name.localeCompare(b.name));

    const allImages = [];
    const seen = new Set();
    sections.forEach(sec => sec.groups.forEach(g => g.images.forEach(img => {
        if (seen.has(img.id)) return;
        seen.add(img.id);
        allImages.push(img);
    })));

    const dataUrlById = await encodeImages(allImages, budgetBytes, onProgress, signal);

    // ---------- cover ----------
    // The same map the app draws, from the same boundaries and the same
    // projection, with the colours frozen in - the file is opened without this
    // app, so it can carry no stylesheet of ours and no Leaflet.
    let coverMap = '';
    try {
        const owned = new Set(Object.keys(state.collectionData));
        const built = await buildWorldSvg(code => owned.has(code)
            ? { fill: OWNED_COLOR, opacity: 0.65 }
            : { fill: NONE_COLOR, opacity: 0.65 });
        coverMap = built.svg;
    } catch (err) {
        console.warn('Could not draw the cover map:', err);
    }

    const countryCount = perCountry.filter(c => c.groups.length || c.sharedCount).length;
    const worldCount = Object.keys(state.countryNameLookup).length;
    const pct = worldCount ? Math.round((countryCount / worldCount) * 100) : 0;
    const kinds = kindCounts(state.cvCountryMap);
    const exported = new Date().toLocaleDateString('en-GB',
        { year: 'numeric', month: 'long', day: 'numeric' });

    let body = '<div class="book">';

    body += `<section class="page cover">
<h1>${escapeHtml(collectionName)}</h1>
<p class="sub">${escapeHtml(exported)}</p>
${coverMap}
</section>`;

    const fact = (label, value) => `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd>`;
    body += `<section class="page">
<h2>At a glance</h2>
<dl class="stats">
${fact('Items in this file', String(allImages.length))}
${fact('Countries', `${countryCount} of ${worldCount} on the map — ${pct}%`)}
${fact('Banknotes and coins', `${plural(kinds[KIND_BANKNOTE], 'banknote')}, ${plural(kinds[KIND_COIN], 'coin')}`)}
${pools.size ? fact('Shared issues',
    `${[...pools.keys()].map(groupLabel).join(', ')} — listed once, under ${pools.size === 1 ? 'its own heading' : 'their own headings'}`) : ''}
${fact('Exported', exported)}
</dl>
<p class="back"><a href="#toc">Contents &rarr;</a></p>
</section>`;

    const toc = sections.map(sec =>
        `<div><a href="#${sec.id}">${escapeHtml(sec.name)}</a> ` +
        `<span class="count">(${sec.count})</span></div>`).join('');
    body += `<section class="page" id="toc"><h2>Contents</h2><div class="toc">${toc}</div></section>`;

    sections.forEach(sec => {
        body += `<section class="page" id="${sec.id}"><h2>${escapeHtml(sec.name)}</h2>`;
        body += groupsToHtml(sec.groups, dataUrlById, 'h3');
        if (sec.sharedCount) {
            const links = sec.sharedGroups
                .map(g => `<a href="#g-${escapeHtml(g)}">${escapeHtml(groupLabel(g))}</a>`)
                .join(', ');
            body += `<p class="shared-note">${sec.sharedCount} shared ` +
                    `item${sec.sharedCount === 1 ? '' : 's'} \u2014 shown once under ${links}.</p>`;
        }
        body += `<p class="back"><a href="#toc">Contents</a></p></section>`;
    });
    body += '</div>';

    const blob = new Blob([wrapDocument(collectionName, body)], { type: 'text/html' });
    return {
        blob,
        filename: `${safeName(collectionName)}_${exportDateStamp()}.html`,
        imageCount: allImages.length,
        countryCount,
        bytes: blob.size
    };
}

// Uses the device's native share sheet where available, otherwise a download.
export async function shareOrDownloadFile(blob, filename) {
    if (navigator.share) {
        const file = new File([blob], filename, { type: 'text/html' });
        // Some Android browsers report canShare() false for text/html even
        // though sharing works, so that check doesn't block us - only a real
        // failure from navigator.share falls back to a download.
        const canTry = !navigator.canShare || navigator.canShare({ files: [file] });
        if (canTry) {
            try {
                await navigator.share({ files: [file], title: filename });
                return;
            } catch (err) {
                if (err.name === 'AbortError') return; // user cancelled the sheet
                console.error('Share failed, falling back to download:', err);
            }
        }
    }
    const a = document.createElement('a');
    const url = URL.createObjectURL(blob);
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
}
