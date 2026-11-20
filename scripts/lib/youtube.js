// lib/youtube.js — YouTube links in notes: find them, read the video id and the start time, build `videos` entries.

const LINK_RE = /https?:\/\/[^\s<>"]+/g;

/** Strip punctuation that belongs to the sentence, not the link: "see https://youtu.be/x)." */
function cleanLink(raw) {
    let url = raw;
    for (;;) {
        const before = url;
        url = url.replace(/[.,;:!?'"”’]+$/u, '');
        if (url.endsWith(')') && !url.includes('(')) url = url.slice(0, -1);
        if (url.endsWith(']') && !url.includes('[')) url = url.slice(0, -1);
        if (url === before) return url;
    }
}

/** "1h2m3s" / "10m32s" / "307s" / "307" → seconds, or null. */
function parseOffset(text) {
    const s = String(text ?? '').trim().toLowerCase();
    if (!s) return null;
    if (/^\d+$/.test(s)) return Number(s);
    let m = s.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
    if (m && (m[1] || m[2] || m[3])) return (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0);
    m = s.match(/^(?:(\d+):)?(\d{1,2}):(\d{2})$/);          // 1:02:03 or 2:03
    if (m) return (+m[1] || 0) * 3600 + (+m[2]) * 60 + (+m[3]);
    return null;
}

/** { id, start } for a YouTube link (start = the ?t= / &t= seconds, or null), or null for any other link. */
function parseYouTube(url) {
    let u;
    try { u = new URL(url); } catch { return null; }
    const host = u.hostname.replace(/^(www\.|m\.|music\.)/, '');
    let id = null;
    if (host === 'youtu.be') id = u.pathname.split('/')[1];
    else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
        if (u.pathname === '/watch') id = u.searchParams.get('v');
        else {
            const m = u.pathname.match(/^\/(?:shorts|live|embed|v)\/([^/?#]+)/);
            if (m) id = m[1];
        }
    }
    if (!id || !/^[\w-]{11}$/.test(id)) return null;
    const t = u.searchParams.get('t') ?? u.searchParams.get('start');
    return { id, start: t === null ? null : parseOffset(t) };
}

/** Every http(s) link in a line: [{ raw, url, start, end }] with positions of the cleaned link in the line. */
function findLinks(line) {
    const out = [];
    for (const m of line.matchAll(LINK_RE)) {
        const url = cleanLink(m[0]);
        out.push({ url, start: m.index, end: m.index + url.length });
    }
    return out;
}

/** The `videos` entry for a link, as in data.json: { url, youtubeId } (the link is kept as written, ?t= included). */
function videoEntry(url) {
    const yt = parseYouTube(url);
    return yt ? { url, youtubeId: yt.id } : null;
}

/** A clean link to a moment in a video, for entries the agent makes itself. */
function momentUrl(id, seconds) {
    return seconds > 0 ? `https://youtu.be/${id}?t=${Math.floor(seconds)}` : `https://youtu.be/${id}`;
}

module.exports = { findLinks, cleanLink, parseYouTube, parseOffset, videoEntry, momentUrl };
