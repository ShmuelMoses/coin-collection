// "Auto arrange": look at a country's photos, work out which SERIES each note
// belongs to, and propose one category per series named with that series' date
// range.
//
// There is no Google Lens API - everything sold under that name is a
// third-party scraper - so this uses Gemini, which takes an image and returns
// text. The key is the user's own and is stored on the device (see cache.js
// meta), never in this repository and never in Drive: since 2026 an unrestricted
// Google API key can reach Gemini, so a key published in a static site is a key
// someone else can bill.
//
// NOTHING here writes anything. It produces a proposal; the modal shows it and
// only what the user accepts is saved.

import { setMeta, getMeta, modalThumbUrl } from './cache.js';

export const GEMINI_KEY_META = 'geminiApiKey';
export const getStoredApiKey = () => getMeta(GEMINI_KEY_META).then(v => (v && v.key) || '');
export const storeApiKey = key => setMeta(GEMINI_KEY_META, { key: String(key || '').trim() });

// Flash: this is image-in / one-short-answer-out, run once per photo, and the
// cheapest kind of model that reads a banknote reliably. Concurrency is low for
// the same reason as everywhere else in this app - a phone is the hard case.
//
// MODELS is a list, not a name, because Google retires model names on a
// schedule - gemini-2.0-flash was shut down on 1 June 2026 and took the first
// version of this feature with it. A retired name answers 404, which is
// indistinguishable from a broken photo unless it is handled: the list is tried
// in order and the first one that exists is used for the rest of the run.
export const AUTO_ARRANGE = {
    models: ['gemini-3.6-flash', 'gemini-2.5-flash', 'gemini-3.5-flash-lite'],
    concurrency: 2,
    minConfidence: 0.5,
    timeoutMs: 30000,
};

let modelIndex = 0;
export const activeModel = () => AUTO_ARRANGE.models[modelIndex];
export const resetModelChoice = () => { modelIndex = 0; };

const ENDPOINT = m => `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`;

// The dates asked for are the SERIES' dates, not this note's printed date: a
// 1985 note and a 1992 note from the same family belong in one category. Where
// denominations of one series appeared or were withdrawn at different times,
// the range is widened rather than split (earliest in, latest out).
const PROMPT = [
    'You are cataloguing a banknote or coin collection.',
    'Look at this item and identify the SERIES it belongs to - the family of notes or coins',
    'issued together - not just this single denomination.',
    '',
    'Answer with JSON only, no prose, no code fence:',
    '{"country":"","denomination":"","series":"","issued":0,"withdrawn":0,"confidence":0}',
    '',
    '- "series": a short stable identifier for the series, e.g. "IL 3rd series" or',
    '  "GBP Series F". The same series must always get the same string.',
    '- "issued": the year the SERIES first entered circulation (not the date printed',
    '  on this item). A number like 1985.',
    '- "withdrawn": the year the SERIES ceased to be legal tender. Use 0 if it is',
    '  still legal tender or you do not know.',
    '- "confidence": 0 to 1. Be honest. Use a low number if you are unsure which',
    '  series this is, or if you are guessing the dates rather than knowing them.',
].join('\n');

// Scans for the outermost braces rather than parsing the whole answer, which
// is what makes a fenced reply work: models wrap JSON in ```json more often
// than not, whatever the prompt asks for, and stripping the fence explicitly
// only covers the fences you thought of.
function extractJson(text) {
    if (!text) return null;
    const cleaned = String(text).trim();
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start === -1 || end <= start) return null;
    try { return JSON.parse(cleaned.slice(start, end + 1)); }
    catch (err) { return null; }
}

// Sends to the current model, and on a 404 - the name has been retired - moves
// to the next one in the list and tries again. The index is only advanced by
// whoever saw the failure first, so two workers hitting the same dead name
// together cost one step down the list rather than two.
async function callModel(body, apiKey, signal) {
    for (;;) {
        const attempt = modelIndex;
        const resp = await fetch(`${ENDPOINT(AUTO_ARRANGE.models[attempt])}?key=${encodeURIComponent(apiKey)}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal,
        });
        if (resp.status !== 404) return resp;
        if (attempt >= AUTO_ARRANGE.models.length - 1) return resp;
        if (modelIndex === attempt) modelIndex = attempt + 1;
    }
}

// One image. Returns null rather than throwing for anything that is merely a
// bad answer - a single unreadable photo must not abandon the whole country.
export async function identifyOne(base64Jpeg, apiKey, signal) {
    const body = {
        contents: [{
            parts: [
                { text: PROMPT },
                { inline_data: { mime_type: 'image/jpeg', data: base64Jpeg } },
            ],
        }],
        generationConfig: { temperature: 0, maxOutputTokens: 300 },
    };
    const resp = await callModel(body, apiKey, signal);
    if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        const err = new Error(`Gemini returned ${resp.status}: ${text.slice(0, 300)}`);
        err.status = resp.status;
        throw err;
    }
    const data = await resp.json();
    const text = data && data.candidates && data.candidates[0] &&
        data.candidates[0].content && data.candidates[0].content.parts &&
        data.candidates[0].content.parts.map(p => p.text || '').join('');
    return extractJson(text);
}

// ---------- naming ----------
// The category name carries the date range and nothing else, by request. An
// open range - a series still in circulation - is left open rather than being
// filled in with a word, so every category name is only digits and a dash.
export function rangeName(issued, withdrawn) {
    const from = Number(issued) > 0 ? Math.round(issued) : null;
    const to = Number(withdrawn) > 0 ? Math.round(withdrawn) : null;
    if (!from && !to) return '';
    if (!from) return `- ${to}`;
    if (!to) return `${from} -`;
    if (from === to) return String(from);
    return `${from} - ${to}`;
}

// ---------- grouping ----------
// Results are grouped by SERIES, then each group's range is widened to cover
// every denomination in it: earliest issue, latest withdrawal. A series still
// in circulation stays open even if some of its denominations were withdrawn,
// because the series as a whole has not been.
//
// Two different series that end up with the same date range become ONE
// category: the name is the range, so two categories with the same name would
// be indistinguishable.
export function groupIntoCategories(results, opts) {
    const minConfidence = (opts && opts.minConfidence != null)
        ? opts.minConfidence : AUTO_ARRANGE.minConfidence;

    const bySeries = new Map();
    const unsure = [];

    (results || []).forEach(r => {
        if (!r || !r.id) return;
        const conf = Number(r.confidence);
        const key = r.series && String(r.series).trim();
        const issued = Number(r.issued) > 0 ? Math.round(Number(r.issued)) : null;
        // Not confident, no series, or no start date: there is nothing to name a
        // category after, so it stays where it is rather than being guessed at.
        if (!key || !issued || !(conf >= minConfidence)) { unsure.push(r.id); return; }

        let g = bySeries.get(key);
        if (!g) { g = { series: key, issued, withdrawn: null, open: false, ids: [] }; bySeries.set(key, g); }
        g.ids.push(r.id);
        if (issued < g.issued) g.issued = issued;
        const withdrawn = Number(r.withdrawn) > 0 ? Math.round(Number(r.withdrawn)) : null;
        if (!withdrawn) g.open = true;                       // still current somewhere
        else if (!g.withdrawn || withdrawn > g.withdrawn) g.withdrawn = withdrawn;
    });

    // Merge series that produced the same range.
    const byName = new Map();
    [...bySeries.values()].forEach(g => {
        const name = rangeName(g.issued, g.open ? null : g.withdrawn);
        if (!name) { unsure.push(...g.ids); return; }
        const existing = byName.get(name);
        if (existing) existing.imageIds.push(...g.ids);
        else byName.set(name, { name, imageIds: g.ids.slice(), issued: g.issued });
    });

    const categories = [...byName.values()].sort((a, b) => a.issued - b.issued);
    return { categories: categories.map(c => ({ name: c.name, imageIds: c.imageIds })), unsure };
}

// ---------- the run ----------
// `images` are the country's items. Thumbnails are sent, not originals: this is
// identification, not reproduction, and a 320px JPEG costs a fraction of a
// full-size photo in both time and tokens.
export async function proposeArrangement(images, apiKey, onProgress, signal) {
    const results = [];
    const failures = [];
    let done = 0;
    let next = 0;

    async function worker() {
        while (next < images.length) {
            if (signal && signal.aborted) throw abortError();
            const img = images[next++];
            try {
                const base64 = await thumbBase64(img.id);
                const answer = await identifyOne(base64, apiKey, signal);
                if (answer) results.push(Object.assign({ id: img.id }, answer));
                else failures.push({ id: img.id, message: 'no answer could be read' });
            } catch (err) {
                if (isAutoArrangeCancelled(err) || (signal && signal.aborted)) throw abortError();
                // An invalid key, an exhausted quota, or a model name that no
                // longer exists anywhere in the list fails EVERY photo, so it
                // is worth stopping on rather than reporting 40 times.
                if (err.status === 400 || err.status === 401 || err.status === 403 ||
                    err.status === 404 || err.status === 429) throw err;
                console.warn('Could not identify', img.id, err);
                failures.push({ id: img.id, message: (err && err.message) || String(err) });
            }
            done++;
            if (onProgress) onProgress(done, images.length);
        }
    }

    await Promise.all(
        Array.from({ length: Math.min(AUTO_ARRANGE.concurrency, images.length) }, worker)
    );
    return Object.assign(groupIntoCategories(results), { results, failures });
}

function abortError() {
    const e = new Error('cancelled');
    e.name = 'AbortError';
    return e;
}
export function isAutoArrangeCancelled(err) {
    return !!err && (err.name === 'AbortError' || err.message === 'cancelled');
}

// The thumbnail is already on the device for every photo that has been viewed,
// and modalThumbUrl builds it if not. Reading it back out of the object URL is
// cheaper than a second download.
async function thumbBase64(fileId) {
    const url = await modalThumbUrl(fileId);
    const blob = await fetch(url).then(r => r.blob());
    return await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
            const s = String(reader.result);
            const comma = s.indexOf(',');
            resolve(comma === -1 ? s : s.slice(comma + 1));
        };
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
    });
}
