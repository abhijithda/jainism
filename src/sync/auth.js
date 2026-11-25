// sync/auth.js — Google sign-in through Google Identity Services (the "token" flow: no server, no secret).
//
// Google's script is loaded only when the reader asks for sign-in (or already signed in on this device), never for
// a plain reader. Tokens last about an hour and the browser-only flow has no refresh token, so after that a quiet
// re-request is tried (works while the reader is still signed in to Google and has approved the site); if the browser
// needs a click, the engine shows "Reconnect".

export const GIS_SRC = 'https://accounts.google.com/gsi/client';
export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
const EXPIRY_MARGIN_MS = 60 * 1000;

let gisPromise = null;
/** Loads Google's script once. Resolves when `google.accounts.oauth2` is usable. */
export function loadGis(doc = document, win = window) {
    if (win.google?.accounts?.oauth2) return Promise.resolve();
    if (gisPromise) return gisPromise;
    gisPromise = new Promise((resolve, reject) => {
        const s = doc.createElement('script');
        s.src = GIS_SRC;
        s.async = true;
        s.onload = () => (win.google?.accounts?.oauth2 ? resolve() : reject(new Error('Google sign-in did not load')));
        s.onerror = () => { gisPromise = null; reject(new Error('Could not reach Google (offline?)')); };
        doc.head.appendChild(s);
    });
    return gisPromise;
}

export class AuthError extends Error {
    constructor(code, message) { super(message || code); this.name = 'AuthError'; this.code = code; }
}

export function createAuth({ clientId, doc = document, win = window, now = Date.now } = {}) {
    let client = null, pending = null, token = null, expiresAt = 0, hint = '';
    let inflight = null;   // { interactive, promise } — a request already open with Google

    async function ensureClient() {
        await loadGis(doc, win);
        if (client) return client;
        client = win.google.accounts.oauth2.initTokenClient({
            client_id: clientId,
            scope: DRIVE_SCOPE,
            callback: resp => {
                const p = pending; pending = null;
                if (!p) return;
                if (resp.error) return p.reject(new AuthError(resp.error, resp.error_description));
                if (!win.google.accounts.oauth2.hasGrantedAllScopes(resp, DRIVE_SCOPE)) return p.reject(new AuthError('scope_denied', 'Permission to save to Google Drive was not given'));
                token = resp.access_token;
                // A missing lifetime means the usual hour; a lifetime of 0 really means "already expired".
                const secs = Number(resp.expires_in);
                expiresAt = now() + (Number.isFinite(secs) ? Math.max(0, secs) : 3600) * 1000;
                p.resolve(token);
            },
            error_callback: err => {
                const p = pending; pending = null;
                if (p) p.reject(new AuthError(err?.type || 'popup_failed', err?.message));
            },
        });
        return client;
    }

    return {
        /** Starts loading Google's script early (call on hover/focus of the sign-in button so the popup is not blocked). */
        preload: () => loadGis(doc, win).catch(() => {}),
        hasValidToken: () => !!token && now() < expiresAt - EXPIRY_MARGIN_MS,
        setHint: email => { hint = email || ''; },

        /**
         * A usable access token. `interactive: true` may open Google's popup (call it from a click);
         * otherwise it only tries quietly and rejects with an AuthError if that is not possible.
         */
        async getToken({ interactive = false } = {}) {
            if (token && now() < expiresAt - EXPIRY_MARGIN_MS) return token;
            // Never cancel a request that is already open (a background sync must not close the sign-in popup):
            // share it, or — if only a quiet attempt is running and this one needs the popup — let it finish first.
            if (inflight && (inflight.interactive || !interactive)) return inflight.promise;
            if (inflight) { await inflight.promise.catch(() => {}); return this.getToken({ interactive }); }
            const entry = { interactive };
            entry.promise = (async () => {
                const c = await ensureClient();
                return new Promise((resolve, reject) => {
                    pending = { resolve, reject };
                    c.requestAccessToken({ prompt: interactive ? '' : 'none', hint });
                });
            })().finally(() => { if (inflight === entry) inflight = null; });
            inflight = entry;
            return entry.promise;
        },

        /** Forget the token (e.g. Drive said 401). */
        forget() { token = null; expiresAt = 0; },

        /** Tell Google this site no longer has access, and forget the token. */
        revoke() {
            const t = token;
            token = null; expiresAt = 0;
            if (t && win.google?.accounts?.oauth2) { try { win.google.accounts.oauth2.revoke(t, () => {}); } catch (_) { /* best effort */ } }
        },
    };
}

// CommonJS shim for Jest
if (typeof module !== 'undefined' && module.exports) Object.assign(module.exports, { GIS_SRC, DRIVE_SCOPE, AuthError, loadGis, createAuth });
