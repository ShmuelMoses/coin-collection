// Builds self-contained HTML files with the images embedded as data URIs, so
// whoever opens one needs no Drive access, no sign-in and no waiting.

import { escapeHtml, blobToBase64, applyOrder } from './util.js';
import { fetchFullImageBlob, resizeImageBlob } from './cache.js';
import { COUNTRY_NAMES } from './countries.js';
import { getCountryLayout } from './layouts.js';
import { state } from './state.js';

// The exported page is a standalone document with no access to this app's CSS
// variables, so the palette values are necessarily written out here. This is
// the one legitimate place in the codebase for literal colours.
const EXPORT_CSS = `
body{font-family:Georgia,'Times New Roman',serif;background:#ece2c8;color:#3b2a1a;padding:24px;text-align:center;}
h1{color:#4b6b3a;}
h2{color:#4b6b3a;border-bottom:1px solid rgba(59,42,26,0.25);padding-bottom:6px;margin-top:40px;text-align:left;}
h3{color:rgba(59,42,26,0.7);font-weight:normal;border-top:1px solid rgba(59,42,26,0.25);padding-top:12px;margin-top:20px;}
.grid{display:flex;flex-wrap:wrap;gap:12px;justify-content:center;}
img{max-width:280px;max-height:280px;border-radius:6px;border:1px solid rgba(59,42,26,0.3);
    background:rgba(59,42,26,0.06);padding:4px;box-sizing:border-box;}
.toc{max-width:640px;margin:0 auto 40px auto;text-align:left;columns:2;font-size:14px;}
.toc a{color:#4b6b3a;text-decoration:none;}
.toc a:hover{text-decoration:underline;}
.meta{color:rgba(59,42,26,0.7);font-size:14px;margin-bottom:8px;}
@media print{h2{break-before:page;} img{max-width:200px;max-height:200px;}}
`;

// Groups a country's images the same way the modal shows them: uncategorised
// first, then saved categories in order, then historical entities.
export function orderedGroupsFor(code) {
    const entry = state.cvCountryMap[code];
    if (!entry) return [];
    const layout = getCountryLayout(code);
    const categorizedIds = new Set(layout.categories.flatMap(c => c.imageIds));
    const uncategorizedRaw = entry.own.filter(img => !categorizedIds.has(img.id));
    const uncategorized = applyOrder(layout.uncategorizedOrder, uncategorizedRaw);

    const groups = [];
    if (uncategorized.length > 0) {
        groups.push({ heading: layout.categories.length > 0 ? 'Uncategorized' : null, images: uncategorized });
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

// `budgetBytes` is the per-image ceiling. `signal` lets a long export be
// stopped: it is checked between images, so cancelling takes effect within one
// photo rather than at the end.
//
// Concurrency is deliberately low for the same reason as the thumbnail queue -
// decoding several full-resolution photos at once is what exhausts a phone.
const EXPORT_CONCURRENCY = 2;

async function encodeImages(images, budgetBytes, onProgress, signal) {
    const dataUrlById = {};
    let done = 0;
    let next = 0;

    async function worker() {
        while (next < images.length) {
            if (signal && signal.cancelled) throw new Error('cancelled');
            const img = images[next++];
            try {
                const fullBlob = await fetchFullImageBlob(img.id);
                const smallBlob = await encodeToBudget(fullBlob, budgetBytes);
                if (smallBlob) dataUrlById[img.id] = await blobToBase64(smallBlob);
            } catch (err) {
                if (err && err.message === 'cancelled') throw err;
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

export async function buildCountryExport(code, selectedIds, onProgress, signal) {
    const groups = orderedGroupsFor(code)
        .map(g => ({ heading: g.heading, images: g.images.filter(img => selectedIds.has(img.id)) }))
        .filter(g => g.images.length > 0);
    const all = groups.flatMap(g => g.images);
    if (!all.length) return null;

    const dataUrlById = await encodeImages(all, DEFAULT_IMAGE_BUDGET, onProgress, signal);
    const countryName = COUNTRY_NAMES[code] || code;
    const body = `<h1>${escapeHtml(countryName)}</h1>` + groupsToHtml(groups, dataUrlById, 'h3');
    return {
        blob: new Blob([wrapDocument(`${countryName} - Banknotes & Coins`, body)], { type: 'text/html' }),
        filename: `${countryName.replace(/\s+/g, '_')}.html`
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
export async function buildCollectionExport(collectionName, budgetBytes, onProgress, signal) {
    const codes = Object.keys(state.collectionData)
        .sort((a, b) => (COUNTRY_NAMES[a] || a).localeCompare(COUNTRY_NAMES[b] || b));

    const perCountry = codes.map(code => ({ code, groups: orderedGroupsFor(code) }))
        .filter(c => c.groups.length > 0);

    const allImages = [];
    const seen = new Set();
    perCountry.forEach(c => c.groups.forEach(g => g.images.forEach(img => {
        // A note shared between countries appears in several of them; encode it
        // once and reuse the data URI, or the file would carry many copies.
        if (seen.has(img.id)) return;
        seen.add(img.id);
        allImages.push(img);
    })));

    const dataUrlById = await encodeImages(allImages, budgetBytes, onProgress, signal);

    const toc = perCountry.map(c => {
        const name = COUNTRY_NAMES[c.code] || c.code;
        const n = c.groups.reduce((s, g) => s + g.images.length, 0);
        return `<div><a href="#c-${escapeHtml(c.code)}">${escapeHtml(name)}</a> (${n})</div>`;
    }).join('');

    let body = `<h1>${escapeHtml(collectionName)}</h1>`;
    body += `<p class="meta">${allImages.length} item${allImages.length === 1 ? '' : 's'} from ` +
            `${perCountry.length} countr${perCountry.length === 1 ? 'y' : 'ies'} \u2014 ` +
            `exported ${new Date().toLocaleDateString('en-GB')}</p>`;
    body += `<div class="toc">${toc}</div>`;
    perCountry.forEach(c => {
        const name = COUNTRY_NAMES[c.code] || c.code;
        body += `<h2 id="c-${escapeHtml(c.code)}">${escapeHtml(name)}</h2>`;
        body += groupsToHtml(c.groups, dataUrlById, 'h3');
    });

    const blob = new Blob([wrapDocument(collectionName, body)], { type: 'text/html' });
    return {
        blob,
        filename: `${collectionName.replace(/\s+/g, '_')}_collection.html`,
        imageCount: allImages.length,
        countryCount: perCountry.length,
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
