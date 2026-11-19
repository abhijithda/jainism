// core/video-time.js — Pure helpers for "a place in a YouTube video": reading
// a start time out of a link, writing one back, and the two addresses the video
// modal needs (the embedded player and the plain YouTube page). No DOM, no
// network, so the modal, the assistant's video search and the transcript
// script can all share them.

const VIDEO_ID = /^[\w-]{11}$/;

/** True for a well-formed YouTube video id (11 letters, digits, - or _). */
export function isVideoId(id) {
    return typeof id === 'string' && VIDEO_ID.test(id);
}

/**
 * A time written by hand or found in a link, as whole seconds. Accepts 90, "90",
 * "90s", "1m30s", "1h2m3s", "1:30" and "1:02:03". Returns null when it is not a
 * time at all (so a caller can tell a time of zero from something that is not a time).
 */
export function parseClock(value) {
    if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
    if (typeof value !== 'string') return null;
    const s = value.trim().toLowerCase();
    if (/^\d+$/.test(s)) return parseInt(s, 10);
    let m = s.match(/^(\d+):(\d{1,2})(?::(\d{1,2}))?$/);
    if (m) {
        const [a, b, c] = [m[1], m[2], m[3]].map(x => (x == null ? null : parseInt(x, 10)));
        return c == null ? a * 60 + b : a * 3600 + b * 60 + c;
    }
    m = s.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
    if (m && (m[1] || m[2] || m[3])) return (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0);
    return null;
}

/** Like parseClock, but anything unreadable counts as the start (0). */
export function parseTimeParam(value) {
    return parseClock(value) ?? 0;
}

/**
 * The start time written in a YouTube link: ?t=1m30s, &t=90, ?start=90 or #t=90.
 * 0 when there is none.
 */
export function parseStartSeconds(url) {
    try {
        const u = new URL(url);
        const hash = new URLSearchParams(u.hash.replace(/^#/, ''));
        return parseTimeParam(u.searchParams.get('t') ?? u.searchParams.get('start') ?? hash.get('t'));
    } catch (_) {
        return 0;
    }
}

/** 754 -> "12:34", 3723 -> "1:02:03". */
export function formatTime(seconds) {
    const n = Math.max(0, Math.floor(Number(seconds) || 0));
    const h = Math.floor(n / 3600);
    const m = Math.floor((n % 3600) / 60);
    const s = n % 60;
    const two = x => String(x).padStart(2, '0');
    return h ? `${h}:${two(m)}:${two(s)}` : `${m}:${two(s)}`;
}

/**
 * The embedded player address, or null for an id that isn't one (so nothing
 * unchecked ever ends up in an iframe's src). Uses YouTube's privacy-enhanced
 * host, which sets no cookies until the reader plays the video.
 */
export function buildEmbedUrl(videoId, start = 0) {
    if (!isVideoId(videoId)) return null;
    const t = Math.max(0, Math.floor(Number(start) || 0));
    return `https://www.youtube-nocookie.com/embed/${videoId}?autoplay=1&rel=0&playsinline=1&start=${t}`;
}

/** The plain YouTube page at a moment: the way out when a video can't be embedded. */
export function buildWatchUrl(videoId, start = 0) {
    if (!isVideoId(videoId)) return null;
    const t = Math.max(0, Math.floor(Number(start) || 0));
    return `https://www.youtube.com/watch?v=${videoId}${t ? `&t=${t}s` : ''}`;
}

// CommonJS shim for Jest
if (typeof module !== 'undefined' && module.exports) {
    Object.assign(module.exports, {
        isVideoId, parseClock, parseTimeParam, parseStartSeconds, formatTime, buildEmbedUrl, buildWatchUrl,
    });
}
