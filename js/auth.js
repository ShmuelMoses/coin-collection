// Google access-token lifecycle.
//
// Tokens are valid for about an hour. The token used to be captured once at
// sign-in and then used forever, so leaving the app open meant every Drive
// call started failing with a raw 401 and the only way back was a reload.
// Expiry is now tracked, refreshed pre-emptively, and any 401 that still
// slips through triggers one silent re-auth and a retry.

import { CLIENT_ID, SCOPES } from './config.js';

const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000; // refresh this long before expiry
const TOKEN_REFRESH_TIMEOUT_MS = 20 * 1000;    // give up waiting on a silent refresh

let tokenClient = null;
let accessToken = null;
let tokenExpiresAt = 0;
let pendingTokenResolve = null; // set only while a refresh is in flight
let refreshInFlight = null;
let onFirstSignIn = null;       // called once, when a NEW sign-in succeeds
let onSignedOut = null;         // called when a silent refresh genuinely fails
let onSignInError = null;       // called when the sign-in window never opened

export function getAccessToken() { return accessToken; }

export function initAuth({ onSignIn, onExpired, onError }) {
    onFirstSignIn = onSignIn;
    onSignedOut = onExpired;
    onSignInError = onError;
    tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: CLIENT_ID,
        scope: SCOPES,
        callback: handleTokenResponse,
        // Without this, a sign-in window the browser refuses to open (the usual
        // cause: requestAccessToken was called after an await, so it is no
        // longer inside the click that asked for it) fails in complete silence -
        // no callback, no error, nothing on screen. That is what "pressing sign
        // in does nothing" was.
        error_callback: handleTokenError,
    });
    return tokenClient;
}

function handleTokenError(err) {
    const type = (err && err.type) || 'unknown';
    console.warn('Google sign-in did not complete:', type, err);
    // A window the user closed themselves is not a fault worth reporting.
    if (type === 'popup_closed') return;
    if (pendingTokenResolve) {
        const resolve = pendingTokenResolve;
        pendingTokenResolve = null;
        resolve(false);
        return;
    }
    if (onSignInError) onSignInError(type);
}

// True once initAuth has run. Offline, it never had: initAuth was reached only
// through the online boot path, so the offline "Sign in" button called
// promptSignIn() on a null client and died with a TypeError before Google was
// ever contacted. Callers check this (or let the throw below tell them).
export function isAuthReady() { return !!tokenClient; }

// Shows Google's account chooser.
export function promptSignIn() {
    if (!tokenClient) throw new Error('Google sign-in has not been set up yet.');
    tokenClient.requestAccessToken();
}

// Tries to sign in with no UI at all, using an existing Google session.
export function trySilentSignIn() {
    if (!tokenClient) throw new Error('Google sign-in has not been set up yet.');
    tokenClient.requestAccessToken({ prompt: '' });
}

// The token client has ONE callback, used both for the initial sign-in and for
// every later silent refresh. It must not restart the app UI on a refresh -
// that would throw the user back to the collections list mid-browse - so a
// refresh is detected by there being a waiter.
function handleTokenResponse(response) {
    const token = response && response.access_token;
    if (token) {
        accessToken = token;
        // expires_in is seconds; default to the documented 1 hour.
        tokenExpiresAt = Date.now() + (Number(response.expires_in) || 3600) * 1000;
        gapi.client.setToken({ access_token: accessToken });
    }
    if (pendingTokenResolve) {
        const resolve = pendingTokenResolve;
        pendingTokenResolve = null;
        resolve(!!token);
        return; // a refresh, not a fresh sign-in - leave the UI alone
    }
    if (!token) return; // startup's silent attempt found no session; wait for the button
    if (onFirstSignIn) onFirstSignIn();
}

// Requests a new token without showing any UI. Resolves true if we got one.
// Concurrent callers share a single in-flight request.
export function refreshAccessToken() {
    if (refreshInFlight) return refreshInFlight;
    refreshInFlight = new Promise(resolve => {
        let settled = false;
        const finish = ok => {
            if (settled) return;
            settled = true;
            if (pendingTokenResolve === finish) pendingTokenResolve = null;
            resolve(ok);
        };
        pendingTokenResolve = finish;
        // If Google never calls back (offline, popup blocked), don't hang
        // every pending Drive call forever.
        setTimeout(() => finish(false), TOKEN_REFRESH_TIMEOUT_MS);
        try {
            tokenClient.requestAccessToken({ prompt: '' });
        } catch (err) {
            console.warn('Silent token refresh could not start:', err);
            finish(false);
        }
    });
    refreshInFlight.then(() => { refreshInFlight = null; },
                         () => { refreshInFlight = null; });
    return refreshInFlight;
}

export function tokenLooksExpired() {
    return !accessToken || Date.now() > (tokenExpiresAt - TOKEN_REFRESH_MARGIN_MS);
}

export function isAuthError(err) {
    if (!err) return false;
    // gapi rejects with the response object; the fetch helper attaches .status
    // itself. 403 is deliberately NOT treated as an auth error - it is normally
    // quota or permission, and retrying will not help.
    const status = err.status ||
        (err.result && err.result.error && err.result.error.code);
    return status === 401;
}

export function clearToken() {
    accessToken = null;
    tokenExpiresAt = 0;
}

// Every Drive call goes through here: refreshes first if the token is about to
// expire, and retries exactly once after a silent re-auth if the call still
// comes back 401.
export async function withAuth(run) {
    if (tokenLooksExpired()) await refreshAccessToken();
    try {
        return await run();
    } catch (err) {
        if (!isAuthError(err)) throw err;
        const ok = await refreshAccessToken();
        if (!ok) { if (onSignedOut) onSignedOut(); throw err; }
        return await run();
    }
}

// fetch() against Drive with the same refresh-and-retry behaviour. Throws an
// Error carrying .status so isAuthError (and the thumbnail 404 self-heal) can
// see it.
export async function driveFetch(url, init) {
    return withAuth(async () => {
        const opts = Object.assign({}, init);
        opts.headers = Object.assign({}, opts.headers, {
            Authorization: 'Bearer ' + accessToken
        });
        const resp = await fetch(url, opts);
        if (!resp.ok) {
            const text = await resp.text().catch(() => '');
            const err = new Error(`Drive returned ${resp.status}: ${text.slice(0, 300)}`);
            err.status = resp.status;
            throw err;
        }
        return resp;
    });
}
