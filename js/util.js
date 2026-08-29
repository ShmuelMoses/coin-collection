// Small dependency-free helpers.

// Escapes text interpolated into an HTML string rather than set via
// textContent - notably the shared-country export, whose headings are
// category names the user types. An unescaped "&" or "<" in a category
// name used to corrupt the exported file.
export function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, ch => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
    ));
}

// Target dimensions for a resize that fits inside maxDim without upscaling.
export function resizeDims(width, height, maxDim) {
    if (width > height) {
        if (width > maxDim) return [maxDim, Math.round(height * maxDim / width)];
    } else {
        if (height > maxDim) return [Math.round(width * maxDim / height), maxDim];
    }
    return [width, height];
}

export function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
    });
}

// Merges an explicit manual order with any images not in it yet (new or
// unordered ones are appended at the end).
export function applyOrder(orderIds, images) {
    const ordered = orderIds.map(id => images.find(i => i.id === id)).filter(Boolean);
    const missing = images.filter(img => !orderIds.includes(img.id));
    return ordered.concat(missing);
}

// ---------- network failures ----------
// A dropped connection surfaces in several different shapes: fetch rejects with
// a TypeError ("Failed to fetch" / "NetworkError"), gapi rejects with status 0
// or -1, and the browser may simply report itself offline. All of them mean the
// same thing to the person using the app, and all of them used to be shown as a
// raw technical string.
export function isNetworkError(err) {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return true;
    if (!err) return false;
    const status = err.status ?? (err.result && err.result.error && err.result.error.code);
    if (status === 0 || status === -1) return true;
    const msg = String(err.message || err);
    return err.name === 'TypeError' && /fetch|network/i.test(msg)
        || /failed to fetch|networkerror|network request failed|err_internet|offline/i.test(msg);
}

// One sentence a person can act on, instead of the exception's own wording.
export function describeError(err, whatFailed) {
    if (isNetworkError(err)) {
        return `${whatFailed} because there is no internet connection. ` +
               `Your collection is still here - reconnect and try again.`;
    }
    return `${whatFailed}: ${(err && err.message) ? err.message : String(err)}`;
}
