// sync/drive.js — The few Google Drive calls sync needs, and nothing more.
//
// Everything goes to the hidden "app data" folder of the reader's own Drive (scope drive.appdata): a folder only
// this site can see, that never shows up in their Drive list. The site's server sees none of it — there is no server.
// `fetchFn` is injectable so the tests run without a network.

export const FILE_NAME = 'jainism-progress.json';
const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';

export class DriveError extends Error {
    constructor(status, message) { super(message || `Google Drive error ${status}`); this.name = 'DriveError'; this.status = status; }
}

export function createDrive(fetchFn) {
    const doFetch = (...args) => (fetchFn || fetch)(...args);

    async function call(url, token, init = {}) {
        const res = await doFetch(url, { ...init, headers: { ...(init.headers || {}), Authorization: `Bearer ${token}` } });
        if (!res.ok) throw new DriveError(res.status);
        return res;
    }

    return {
        /** The id of the progress file, or null. If two devices ever created one at once, the oldest is the one used. */
        async findFile(token) {
            const q = encodeURIComponent(`name='${FILE_NAME}' and trashed=false`);
            const url = `${API}/files?spaces=appDataFolder&q=${q}&orderBy=createdTime&pageSize=10&fields=files(id)`;
            const { files } = await (await call(url, token)).json();
            return files && files.length ? files[0].id : null;
        },

        /** The parsed file, or null if it is empty or unreadable (the merge then simply starts from this device). */
        async readFile(token, id) {
            const res = await call(`${API}/files/${encodeURIComponent(id)}?alt=media`, token);
            try { return await res.json(); } catch (_) { return null; }
        },

        /** Creates the file (id null) or replaces its content. Returns the id. */
        async writeFile(token, id, doc) {
            const body = JSON.stringify(doc);
            if (id) {
                await call(`${UPLOAD}/files/${encodeURIComponent(id)}?uploadType=media`, token,
                    { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body });
                return id;
            }
            const boundary = `jainism${Math.random().toString(36).slice(2)}`;
            const meta = JSON.stringify({ name: FILE_NAME, parents: ['appDataFolder'], mimeType: 'application/json' });
            const multipart = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n` +
                `--${boundary}\r\nContent-Type: application/json\r\n\r\n${body}\r\n--${boundary}--`;
            const res = await call(`${UPLOAD}/files?uploadType=multipart&fields=id`, token,
                { method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body: multipart });
            return (await res.json()).id;
        },

        async deleteFile(token, id) {
            await call(`${API}/files/${encodeURIComponent(id)}`, token, { method: 'DELETE' });
        },

        /** Who is signed in, for the status line. Best effort: null on any failure. */
        async whoAmI(token) {
            try {
                const { user } = await (await call(`${API}/about?fields=user(displayName,emailAddress)`, token)).json();
                return user ? { name: user.displayName || '', email: user.emailAddress || '' } : null;
            } catch (_) { return null; }
        },
    };
}

// CommonJS shim for Jest
if (typeof module !== 'undefined' && module.exports) Object.assign(module.exports, { FILE_NAME, DriveError, createDrive });
