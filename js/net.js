// Live connectivity monitoring.
//
// navigator.onLine only reports whether the device believes it has a network
// interface. On a phone it stays true on a wifi that goes nowhere, and the
// 'online'/'offline' events fire on the interface rather than on reachability.
// The app previously decided "offline" once, at startup, from that flag alone -
// so losing the connection mid-session left it claiming to be signed in and
// working, and getting the connection back left the "no connection" notice up
// until the page was reloaded.
//
// So the state is polled with a real request, at a modest interval, and
// published to whoever wants to react to it.

import { state } from './state.js';

// One mutable object so the cadence is visible in a single place (and so the
// tests can shorten it), matching how cache.js exposes its timeouts.
export const POLL = {
    timeout: 6000,
    whenOnline: 20000,
    // Faster while down, so the notice clears within a few seconds of the
    // connection returning. It costs one sub-kilobyte request.
    whenOffline: 5000,
};

// Same-origin, so no CORS and no dependency on a third party being up. The
// service worker is told to leave this URL alone (see the __netprobe check in
// sw.js) - otherwise it would answer from the cache and every probe, including
// every offline one, would report success.
const PROBE_URL = './manifest.json';

const listeners = new Set();
let timer = null;
let inFlight = null;
let started = false;

export function isOnline() { return state.online; }

export function onConnectivityChange(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

function publish() {
    listeners.forEach(fn => {
        try { fn(state.online); } catch (err) { console.warn('Connectivity listener failed:', err); }
    });
}

async function probe() {
    // A device that knows it has no interface needs no request to prove it.
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return false;
    if (typeof fetch !== 'function') return true;
    const controller = (typeof AbortController === 'function') ? new AbortController() : null;
    const timeout = setTimeout(() => { if (controller) controller.abort(); }, POLL.timeout);
    try {
        const resp = await fetch(`${PROBE_URL}?__netprobe=${Date.now()}`, {
            method: 'GET',
            cache: 'no-store',
            signal: controller ? controller.signal : undefined,
        });
        return !!(resp && resp.ok);
    } catch (err) {
        return false;
    } finally {
        clearTimeout(timeout);
    }
}

function setOnline(ok) {
    const changed = ok !== state.online;
    state.online = ok;
    schedule();
    if (changed) publish();
}

function schedule() {
    clearTimeout(timer);
    // A hidden tab is not polled at all: on a phone the app spends most of its
    // life in the background, where a repeating timer is pure battery cost and
    // the answer is not being shown to anyone. It is re-checked on the way back.
    if (typeof document !== 'undefined' && document.hidden) return;
    timer = setTimeout(checkNow, state.online ? POLL.whenOnline : POLL.whenOffline);
}

// Checks immediately. Concurrent callers share the one request in flight.
export function checkNow() {
    if (inFlight) return inFlight;
    inFlight = probe().then(
        ok => { inFlight = null; setOnline(ok); return ok; },
        () => { inFlight = null; return state.online; }
    );
    return inFlight;
}

export function startConnectivityMonitor() {
    if (started) return;
    started = true;

    // The browser's own events are still worth having: they are instant, and
    // the poll then confirms (or contradicts) them.
    if (typeof window !== 'undefined' && window.addEventListener) {
        window.addEventListener('online', () => checkNow());
        window.addEventListener('offline', () => checkNow());
    }
    if (typeof document !== 'undefined' && document.addEventListener) {
        document.addEventListener('visibilitychange', () => {
            if (document.hidden) clearTimeout(timer);
            else checkNow();
        });
    }
    checkNow();
}

// Test seam: lets the smoke test drive the state without a real network.
export function __setOnlineForTest(ok) { setOnline(ok); }
