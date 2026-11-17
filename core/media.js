// media.js — Pure media presentation utilities.
// No view-specific FAQ logic; provides text helpers and video card factory.

import { qrToDataUrl } from './qr.js';

/**
 * Escape HTML special characters to prevent injection.
 */
export function escapeHtml(text) {
    if (!text) return '';
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

// ── Links inside text ─────────────────────────────────────────────────────
// A web address typed in a block's text (for example the Google Form link in a
// "PS:" note) becomes a real link on screen. Only plain ASCII address
// characters count, so a Kannada letter right after an address ends the link,
// and trailing punctuation ("…see https://x.org/a.") is not swallowed by it.

const URL_PATTERN = /https?:\/\/[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+/g;

function countChar(text, ch) { return text.split(ch).length - 1; }

// Drop punctuation that belongs to the sentence, not the address. A closing
// bracket is kept only when the address itself contains the matching opening one
// (Wikipedia-style .../Foo_(bar)).
function trimTrailing(url) {
    let end = url.length;
    while (end > 0) {
        const ch = url[end - 1];
        const head = url.slice(0, end);
        if ('.,;:!?\''.includes(ch)) end--;
        else if (ch === ')' && countChar(head, ')') > countChar(head, '(')) end--;
        else if (ch === ']' && countChar(head, ']') > countChar(head, '[')) end--;
        else break;
    }
    return url.slice(0, end);
}

// Split text into [{ text } | { link }] pieces, in order, losing nothing.
export function splitLinks(text) {
    const source = String(text == null ? '' : text);
    const parts = [];
    let last = 0;
    for (const match of source.matchAll(URL_PATTERN)) {
        const url = trimTrailing(match[0]);
        if (url.length <= 'https://'.length - 1) continue;
        if (match.index > last) parts.push({ text: source.slice(last, match.index) });
        parts.push({ link: url });
        last = match.index + url.length;
    }
    if (last < source.length) parts.push({ text: source.slice(last) });
    return parts;
}

/**
 * Convert bare URLs in text to clickable <a> links (returns an HTML string).
 * The views use appendLinkedText() instead, which builds DOM nodes and so can
 * never turn text into markup; this is kept for callers that need a string.
 */
export function linkify(text) {
    return splitLinks(text).map(p => (p.link
        ? `<a href="${p.link}" target="_blank" rel="noopener noreferrer">${p.link}</a>`
        : p.text)).join('');
}

/**
 * Append `text` to `el`, turning web addresses into links. Everything else is
 * added as plain text, so nothing in the text can become markup, and line
 * breaks in it are kept.
 */
export function appendLinkedText(el, text) {
    const doc = el.ownerDocument;
    for (const part of splitLinks(text)) {
        if (part.link) {
            const a = doc.createElement('a');
            a.href = part.link;
            a.textContent = part.link;
            a.className = 'text-link';
            a.target = '_blank';
            a.rel = 'noopener noreferrer';
            // A link inside a clickable card (e.g. an expandable excerpt) should
            // just open, not also trigger the card's own click.
            a.addEventListener('click', e => e.stopPropagation());
            el.appendChild(a);
        } else {
            el.appendChild(doc.createTextNode(part.text));
        }
    }
    return el;
}

/**
 * Extract YouTube video ID from a URL (verbatim from master's createVideoCard).
 */
export function extractYouTubeId(url) {
    if (!url) return null;
    const cleanUrl = url.split('?t=')[0].split('&t=')[0];
    const regExp = /^.*(youtu.be\/|v\/|u\/\w\/|embed\/|watch\?v=|\&v=)([^#\&\?]*).*/;
    const match = cleanUrl.match(regExp);
    return (match && match[2].length === 11) ? match[2] : null;
}

/**
 * The QR code for a destination URL, as a self-contained image address
 * (an SVG data: URL) drawn right here by core/qr.js. No request is made, so it
 * works offline, and in the printed PDFs it is a crisp vector instead of a small
 * picture fetched from a third-party service when the page is built.
 */
export function buildQrUrl(destinationUrl) {
    return qrToDataUrl(destinationUrl, { ecc: 'M' });
}

/**
 * Where a video's thumbnail is kept in this project (images/thumbs/<id>.jpg,
 * fetched by scripts/fetch-thumbs.js). Same-origin, so it is part of the saved
 * offline copy and the print builds don't depend on YouTube being reachable.
 */
export const THUMBNAIL_DIR = 'images/thumbs';

export function buildLocalThumbnailUrl(videoId) {
    return `${THUMBNAIL_DIR}/${videoId}.jpg`;
}

/**
 * Build a YouTube thumbnail URL from a video ID (the original source; used as
 * the fallback when the local copy hasn't been fetched yet).
 */
export function buildYouTubeThumbnailUrl(videoId) {
    return `https://img.youtube.com/vi/${videoId}/0.jpg`;
}

/**
 * Create a media-wrap HTML string (video thumbnail + QR overlay).
 * Matches master's createVideoCard output structure exactly:
 *   .media-wrap > .video-card + .qr-code
 * so all existing CSS rules apply without change.
 *
 * The thumbnail is the local copy first; if that file doesn't exist (a video
 * added since the thumbnails were last fetched) installThumbnailFallback() below
 * tries YouTube, and if that fails too (offline, deleted video) shows a plain
 * "Video" tile instead of a broken-image box.
 */
export function createVideoCard(url) {
    const videoId = extractYouTubeId(url);
    if (!videoId) return '';
    const qrCodeUrl = buildQrUrl(url);
    return `
        <div class="media-wrap">
            <div class="video-card">
                <a href="${escapeHtml(url)}" target="_blank">
                    <img src="${buildLocalThumbnailUrl(videoId)}" data-fallback-src="${buildYouTubeThumbnailUrl(videoId)}" alt="Watch Video">
                </a>
            </div>
            <div class="qr-code">
                <img src="${qrCodeUrl}" alt="QR Code">
            </div>
        </div>
    `;
}

/**
 * Thumbnail fallback chain: local file -> YouTube -> plain tile.
 * An <img> inside .video-card that fails to load first switches to its
 * data-fallback-src (once); if it fails again the card gets .thumb-failed, which
 * media.css draws as a neutral tile. Error events don't bubble, so this listens
 * once in the capture phase for every image in the document, like the photo size
 * tracking below.
 */
export function handleThumbnailError(img) {
    if (!img || img.tagName !== 'IMG' || !img.closest) return;
    const card = img.closest('.video-card');
    if (!card) return;
    const fallback = img.getAttribute('data-fallback-src');
    if (fallback) {
        img.removeAttribute('data-fallback-src');
        img.src = fallback;
        return;
    }
    card.classList.add('thumb-failed');
}

export function installThumbnailFallback(doc = (typeof document !== 'undefined' ? document : null)) {
    if (!doc || doc.__thumbnailFallback) return;
    doc.__thumbnailFallback = true;
    doc.addEventListener('error', e => handleThumbnailError(e.target), true);
    // Thumbnails that had already failed before this ran.
    doc.querySelectorAll('.video-card img').forEach(img => {
        if (img.complete && img.naturalWidth === 0 && img.getAttribute('src')) handleThumbnailError(img);
    });
}

/**
 * Photo size tracking.
 *
 * Print CSS sizes photos as "as wide as the column/page allows, never taller
 * than a page, never stretched, and never blown up past what the photo's own
 * pixels support" (see --min-dpi in the view stylesheets). CSS can't read an
 * image's natural size, so every <img> publishes it as two custom properties
 * once it has loaded:
 *   --ar  natural width / natural height  (aspect ratio)
 *   --nw  natural width in pixels
 * Photos are created in several places (both views, some via innerHTML), so
 * instead of patching each one this listens once, in the capture phase (load
 * events don't bubble), for every image in the document.
 */
export function publishImageSize(img) {
    if (!img || !img.naturalWidth || !img.naturalHeight) return;
    img.style.setProperty('--ar', (img.naturalWidth / img.naturalHeight).toFixed(4));
    img.style.setProperty('--nw', String(img.naturalWidth));
}

export function installImageSizeTracking(doc = (typeof document !== 'undefined' ? document : null)) {
    if (!doc || doc.__imageSizeTracking) return;
    doc.__imageSizeTracking = true;
    doc.addEventListener('load', e => {
        if (e.target && e.target.tagName === 'IMG') publishImageSize(e.target);
    }, true);
    // Images that finished loading before this ran.
    doc.querySelectorAll('img').forEach(img => { if (img.complete) publishImageSize(img); });
}

installImageSizeTracking();
installThumbnailFallback();

// CommonJS shim for Jest
if (typeof module !== 'undefined' && module.exports) {
    Object.assign(module.exports, {
        escapeHtml, linkify, splitLinks, appendLinkedText, extractYouTubeId,
        buildQrUrl, buildYouTubeThumbnailUrl, buildLocalThumbnailUrl, THUMBNAIL_DIR, createVideoCard,
        handleThumbnailError, installThumbnailFallback,
        publishImageSize, installImageSizeTracking,
    });
}
