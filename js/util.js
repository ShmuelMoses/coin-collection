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
