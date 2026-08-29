// Builds self-contained HTML files with the images embedded as data URIs, so
// whoever opens one needs no Drive access, no sign-in and no waiting.

import { escapeHtml, blobToBase64, applyOrder } from './util.js';
import { fetchFullImageBlob, resizeImageBlobByFactor } from './cache.js';
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

// Fetches, shrinks and base64-encodes images in parallel, reporting progress.
// `factor` 4 means quarter width and height.
async function encodeImages(images, factor, onProgress) {
    const dataUrlById = {};
    let done = 0;
    await Promise.all(images.map(async img => {
        try {
            const fullBlob = await fetchFullImageBlob(img.id);
            const smallBlob = await resizeImageBlobByFactor(fullBlob, factor);
            dataUrlById[img.id] = await blobToBase64(smallBlob);
        } catch (err) {
            console.warn('Skipping image that could not be exported:', img.id, err);
        }
        done++;
        if (onProgress) onProgress(done, images.length);
    }));
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
export async function buildCountryExport(code, selectedIds, onProgress) {
    const groups = orderedGroupsFor(code)
        .map(g => ({ heading: g.heading, images: g.images.filter(img => selectedIds.has(img.id)) }))
        .filter(g => g.images.length > 0);
    const all = groups.flatMap(g => g.images);
    if (!all.length) return null;

    const dataUrlById = await encodeImages(all, 4, onProgress);
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
export async function buildCollectionExport(collectionName, factor, onProgress) {
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

    const dataUrlById = await encodeImages(allImages, factor, onProgress);

    const toc = perCountry.map(c => {
        const name = COUNTRY_NAMES[c.code] || c.code;
        const n = c.groups.reduce((s, g) => s + g.images.length, 0);
        return `<div><a href="#c-${escapeHtml(c.code)}">${escapeHtml(name)}</a> (${n})</div>`;
    }).join('');

    let body = `<h1>${escapeHtml(collectionName)}</h1>`;
    body += `<p class="meta">${allImages.length} item${allImages.length === 1 ? '' : 's'} from ` +
            `${perCountry.length} countr${perCountry.length === 1 ? 'y' : 'ies'} — ` +
            `exported ${new Date().toLocaleDateString()}</p>`;
    body += `<div class="toc">${toc}</div>`;

    perCountry.forEach(c => {
        const name = COUNTRY_NAMES[c.code] || c.code;
        body += `<h2 id="c-${escapeHtml(c.code)}">${escapeHtml(name)}</h2>`;
        body += groupsToHtml(c.groups, dataUrlById, 'h3');
    });

    return {
        blob: new Blob([wrapDocument(collectionName, body)], { type: 'text/html' }),
        filename: `${collectionName.replace(/\s+/g, '_')}_collection.html`,
        imageCount: allImages.length,
        countryCount: perCountry.length
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
