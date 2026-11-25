// sync/sync-config.js — The one setting the sign-in needs: the site's Google OAuth client ID, read from
// assets/sync-config.json (next to data.json). It is a public identifier, not a secret, so it lives in the repo.
//
// With no file, an empty ID, or one that does not look like a Google client ID, sign-in is simply not offered:
// the "Save progress" section stays hidden, nothing from Google is ever loaded, and the site behaves as before.
// Setup steps: docs/SYNC.md.

export const CLIENT_ID_RE = /^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$/i;

/** @param {Object} [raw] the parsed sync-config.json (anything else is treated as empty) */
export function createSyncConfig(raw) {
    const problems = [];
    const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    Object.keys(src).forEach(key => { if (key !== 'googleClientId') problems.push(`unknown key "${key}"`); });

    let clientId = '';
    const id = typeof src.googleClientId === 'string' ? src.googleClientId.trim() : '';
    if (id) {
        if (CLIENT_ID_RE.test(id)) clientId = id;
        else problems.push('"googleClientId" does not look like a Google client ID (…apps.googleusercontent.com)');
    } else if (src.googleClientId !== undefined && src.googleClientId !== '') {
        problems.push('"googleClientId" should be text');
    }
    return { clientId, enabled: !!clientId, problems };
}

/** Fetches the config. Never fails: no file, a network error or bad JSON all mean "sign-in not offered". */
export async function loadSyncConfig({ url = 'assets/sync-config.json', fetchFn } = {}) {
    try {
        const res = await (fetchFn || fetch)(url);
        if (!res.ok) return createSyncConfig({});
        return createSyncConfig(await res.json());
    } catch (_) {
        return createSyncConfig({});
    }
}

// CommonJS shim for Jest
if (typeof module !== 'undefined' && module.exports) Object.assign(module.exports, { CLIENT_ID_RE, createSyncConfig, loadSyncConfig });
