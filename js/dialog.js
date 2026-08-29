// Themed replacements for alert() / confirm() / prompt().
//
// The native dialogs were the only part of the app that looked like a plain
// browser page - grey system chrome dropped on top of a hand-drawn antique map,
// and especially jarring on Android. prompt() is also unstyleable, blocks the
// whole page, and is disabled outright in some contexts.
//
// The markup is built on demand so no HTML changes are needed, and every entry
// point returns a promise, so callers just await instead of blocking.

let backdropEl = null;
let closeActive = null; // resolver for the dialog currently open

function ensureBackdrop() {
    if (backdropEl) return backdropEl;
    backdropEl = document.createElement('div');
    backdropEl.className = 'dialog-backdrop';
    backdropEl.addEventListener('mousedown', e => {
        if (e.target === backdropEl && closeActive) closeActive(null);
    });
    document.body.appendChild(backdropEl);
    return backdropEl;
}

function onKeyDown(e) {
    if (!closeActive) return;
    if (e.key === 'Escape') { e.preventDefault(); closeActive(null); }
}

/**
 * options: { title, message, confirmLabel, cancelLabel, showCancel, input }
 * `input` (optional): { value, placeholder } - when present the dialog
 * resolves to the typed string, or null if cancelled.
 * Without `input` it resolves true / null.
 */
export function showDialog(options) {
    const opts = options || {};
    const backdrop = ensureBackdrop();
    backdrop.innerHTML = '';

    const box = document.createElement('div');
    box.className = 'dialog-box';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');

    if (opts.title) {
        const h = document.createElement('h3');
        h.textContent = opts.title;
        box.appendChild(h);
    }
    if (opts.message) {
        const p = document.createElement('p');
        p.className = 'dialog-message';
        p.textContent = opts.message; // textContent, so no escaping needed
        box.appendChild(p);
    }

    let inputEl = null;
    if (opts.input) {
        inputEl = document.createElement('input');
        inputEl.type = 'text';
        inputEl.className = 'dialog-input';
        inputEl.value = opts.input.value || '';
        if (opts.input.placeholder) inputEl.placeholder = opts.input.placeholder;
        box.appendChild(inputEl);
    }

    const actions = document.createElement('div');
    actions.className = 'dialog-actions';

    const confirmBtn = document.createElement('button');
    confirmBtn.className = 'legend-btn dialog-confirm';
    confirmBtn.textContent = opts.confirmLabel || 'OK';

    let settle;
    const done = value => {
        if (!settle) return;
        const fn = settle;
        settle = null;
        closeActive = null;
        document.removeEventListener('keydown', onKeyDown, true);
        backdrop.classList.remove('open');
        backdrop.innerHTML = '';
        fn(value);
    };

    const showCancel = opts.showCancel !== false;
    if (showCancel) {
        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'legend-btn';
        cancelBtn.textContent = opts.cancelLabel || 'Cancel';
        cancelBtn.onclick = () => done(null);
        actions.appendChild(cancelBtn);
    }

    confirmBtn.onclick = () => done(inputEl ? inputEl.value : true);
    actions.appendChild(confirmBtn);
    box.appendChild(actions);
    backdrop.appendChild(box);
    backdrop.classList.add('open');

    if (inputEl) {
        inputEl.onkeydown = e => {
            if (e.key === 'Enter') { e.preventDefault(); done(inputEl.value); }
        };
    }

    return new Promise(resolve => {
        settle = resolve;
        closeActive = done;
        document.addEventListener('keydown', onKeyDown, true);
        // Focus after the element is in the document, so the caret lands in the
        // input rather than nowhere.
        requestAnimationFrame(() => {
            (inputEl || confirmBtn).focus();
            if (inputEl) inputEl.select();
        });
    });
}

export function alertDialog(message, title) {
    return showDialog({ title: title || null, message, confirmLabel: 'OK', showCancel: false });
}

export async function confirmDialog(message, opts) {
    const o = opts || {};
    const res = await showDialog({
        title: o.title || null,
        message,
        confirmLabel: o.confirmLabel || 'OK',
        cancelLabel: o.cancelLabel || 'Cancel'
    });
    return res === true;
}

export async function promptDialog(message, defaultValue, opts) {
    const o = opts || {};
    const res = await showDialog({
        title: o.title || null,
        message,
        confirmLabel: o.confirmLabel || 'Save',
        input: { value: defaultValue || '', placeholder: o.placeholder || '' }
    });
    return res === null ? null : String(res);
}

// A dialog offering several mutually exclusive choices, each on its own row
// with a short explanation. Resolves to the chosen option's `value`, or null if
// dismissed. Used for "share at which size" - three buttons say what the
// options actually are far better than one button plus a paragraph.
export function showChoiceDialog(options) {
    const opts = options || {};
    const backdrop = ensureBackdrop();
    backdrop.innerHTML = '';

    const box = document.createElement('div');
    box.className = 'dialog-box';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');

    if (opts.title) {
        const h = document.createElement('h3');
        h.textContent = opts.title;
        box.appendChild(h);
    }
    if (opts.message) {
        const p = document.createElement('p');
        p.className = 'dialog-message';
        p.textContent = opts.message;
        box.appendChild(p);
    }

    let settle;
    const done = value => {
        if (!settle) return;
        const fn = settle;
        settle = null;
        closeActive = null;
        document.removeEventListener('keydown', onKeyDown, true);
        backdrop.classList.remove('open');
        backdrop.innerHTML = '';
        fn(value);
    };

    const list = document.createElement('div');
    list.className = 'dialog-choices';
    (opts.options || []).forEach(o => {
        const b = document.createElement('button');
        b.className = 'legend-btn dialog-choice';
        const label = document.createElement('span');
        label.className = 'dialog-choice-label';
        label.textContent = o.label;
        b.appendChild(label);
        if (o.hint) {
            const hint = document.createElement('span');
            hint.className = 'dialog-choice-hint';
            hint.textContent = o.hint;
            b.appendChild(hint);
        }
        b.onclick = () => done(o.value);
        list.appendChild(b);
    });
    box.appendChild(list);

    const actions = document.createElement('div');
    actions.className = 'dialog-actions';
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'legend-btn';
    cancelBtn.textContent = opts.cancelLabel || 'Cancel';
    cancelBtn.onclick = () => done(null);
    actions.appendChild(cancelBtn);
    box.appendChild(actions);

    backdrop.appendChild(box);
    backdrop.classList.add('open');

    return new Promise(resolve => {
        settle = resolve;
        closeActive = done;
        document.addEventListener('keydown', onKeyDown, true);
        requestAnimationFrame(() => cancelBtn.focus());
    });
}

// A dialog that stays open while something runs, with a live status line and
// an optional Cancel. Returns { setMessage, close, signal }: `signal.cancelled`
// flips to true when Cancel is pressed, and long jobs check it between steps.
export function showProgressDialog(title, message, opts) {
    const o = opts || {};
    const backdrop = ensureBackdrop();
    backdrop.innerHTML = '';

    const box = document.createElement('div');
    box.className = 'dialog-box';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');

    const h = document.createElement('h3');
    h.textContent = title;
    const p = document.createElement('p');
    p.className = 'dialog-message';
    p.textContent = message || '';
    box.append(h, p);

    // A real AbortController, not just a flag. A flag is only noticed BETWEEN
    // steps, so on a slow connection "Cancelling…" sat there until the download
    // in flight finished or timed out - up to two minutes. Aborting tears down
    // the request itself, so Cancel takes effect at once.
    const controller = new AbortController();
    const signal = controller.signal;

    if (o.cancellable) {
        const actions = document.createElement('div');
        actions.className = 'dialog-actions';
        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'legend-btn';
        cancelBtn.textContent = o.cancelLabel || 'Cancel';
        cancelBtn.onclick = () => {
            controller.abort();
            cancelBtn.disabled = true;
            p.textContent = 'Cancelling…';
        };
        actions.appendChild(cancelBtn);
        box.appendChild(actions);
    }

    backdrop.appendChild(box);
    backdrop.classList.add('open');
    // Deliberately not dismissable by backdrop or Escape - Cancel is the way out.
    closeActive = null;

    return {
        signal,
        setMessage: text => { if (!signal.aborted) p.textContent = text; },
        close: () => { backdrop.classList.remove('open'); backdrop.innerHTML = ''; }
    };
}
