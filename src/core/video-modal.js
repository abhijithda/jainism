// core/video-modal.js — Plays a linked YouTube video in a dialog over the page,
// starting at a given second, so a reader (or the assistant's "Watch" button)
// can land exactly on the moment that matters without leaving the book.
//
//   openVideoModal({ videoId, start, label })   open the player
//   closeVideoModal()                           close it (also: Esc, backdrop, ✕)
//   installVideoModal()                         make every video thumbnail open it
//
// Thumbnails stay ordinary links to YouTube, so with this off, or with a
// Ctrl/Cmd/Shift/middle click, they still open YouTube in a new tab. The dialog
// always carries an "Open on YouTube" link too: some videos forbid embedding,
// and offline there is no player at all.
//
// Not printed (media.css / video-modal.css hide it); the print builds never open it.

import { extractYouTubeId } from './media.js';
import { buildEmbedUrl, buildWatchUrl, formatTime, parseStartSeconds } from './video-time.js';

let modal = null;       // the one dialog element, created on first use
let opener = null;      // what had focus before, so it gets it back on close

function focusables(root) {
    return [...root.querySelectorAll('a[href], button:not([disabled])')];
}

function onKeydown(e) {
    if (!modal) return;
    if (e.key === 'Escape') {
        // Stop here: the assistant drawer also listens for Esc and must stay open under the video.
        e.preventDefault();
        e.stopPropagation();
        closeVideoModal();
    } else if (e.key === 'Tab') {
        // Keep Tab inside the dialog (the iframe itself is not a Tab stop we can manage).
        const items = focusables(modal);
        if (!items.length) return;
        const first = items[0];
        const last = items[items.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
}

function build() {
    const root = document.createElement('div');
    root.className = 'video-modal';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-label', 'Video');

    const box = document.createElement('div');
    box.className = 'video-modal__box';

    const bar = document.createElement('div');
    bar.className = 'video-modal__bar';
    const title = document.createElement('span');
    title.className = 'video-modal__title';
    const yt = document.createElement('a');
    yt.className = 'video-modal__yt';
    yt.target = '_blank';
    yt.rel = 'noopener noreferrer';
    yt.textContent = 'Open on YouTube';
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'video-modal__close';
    close.setAttribute('aria-label', 'Close video');
    close.textContent = '\u2715';
    close.addEventListener('click', closeVideoModal);
    bar.append(title, yt, close);

    const frame = document.createElement('div');
    frame.className = 'video-modal__frame';

    box.append(bar, frame);
    root.appendChild(box);
    // A click on the dark area around the box closes it; a click inside does not.
    root.addEventListener('click', e => { if (e.target === root) closeVideoModal(); });
    return root;
}

/**
 * Opens the player.
 * @param {{videoId: string, start?: number, label?: string, trigger?: HTMLElement}} args
 * @returns {boolean} false when the id isn't a YouTube video id (nothing opens)
 */
export function openVideoModal({ videoId, start = 0, label = '', trigger } = {}) {
    const src = buildEmbedUrl(videoId, start);
    if (!src) return false;
    const wasOpen = isVideoModalOpen();
    if (!modal) modal = build();
    if (!modal.isConnected) document.body.appendChild(modal);

    const at = Math.max(0, Math.floor(Number(start) || 0));
    modal.querySelector('.video-modal__title').textContent = [label, at ? formatTime(at) : ''].filter(Boolean).join(' \u00b7 ') || 'Video';
    modal.querySelector('.video-modal__yt').href = buildWatchUrl(videoId, at);

    // A fresh iframe each time: it restarts at the new second, and removing it on close stops the sound.
    const frame = modal.querySelector('.video-modal__frame');
    const iframe = document.createElement('iframe');
    iframe.src = src;
    iframe.title = 'YouTube video player';
    iframe.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen';
    iframe.allowFullscreen = true;
    // YouTube refuses to play an embed that sends no referrer.
    iframe.referrerPolicy = 'strict-origin-when-cross-origin';
    frame.replaceChildren(iframe);

    // Remember what to give focus back to, but only on the first open: opening another moment while the
    // dialog is already up must not replace it with the dialog's own button.
    if (!wasOpen) opener = trigger || document.activeElement;
    modal.hidden = false;
    document.body.classList.add('video-modal-open');
    document.addEventListener('keydown', onKeydown, true);
    modal.querySelector('.video-modal__close').focus();
    return true;
}

export function closeVideoModal() {
    if (!modal || modal.hidden) return;
    modal.hidden = true;
    modal.querySelector('.video-modal__frame').replaceChildren();
    document.body.classList.remove('video-modal-open');
    document.removeEventListener('keydown', onKeydown, true);
    const back = opener;
    opener = null;
    if (back && back.isConnected && typeof back.focus === 'function') back.focus();
}

export function isVideoModalOpen() {
    return !!modal && !modal.hidden && modal.isConnected;
}

/**
 * Makes a plain left click on any video thumbnail (.video-card a) open the
 * dialog instead of a new browser tab. Listens once, on the document, in the
 * capture phase, so it covers cards drawn by either view, and cards that don't
 * exist yet. Ctrl/Cmd/Shift/Alt-clicks and middle clicks are left alone.
 */
export function installVideoModal(doc = (typeof document !== 'undefined' ? document : null)) {
    if (!doc || doc.__videoModalInstalled) return;
    doc.__videoModalInstalled = true;
    doc.addEventListener('click', e => {
        if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        const link = e.target && e.target.closest ? e.target.closest('.video-card a') : null;
        if (!link) return;
        const href = link.getAttribute('href');
        const videoId = extractYouTubeId(href);
        if (!videoId) return;
        if (openVideoModal({ videoId, start: parseStartSeconds(href), trigger: link })) e.preventDefault();
    }, true);
}

// CommonJS shim for Jest
if (typeof module !== 'undefined' && module.exports) {
    Object.assign(module.exports, { openVideoModal, closeVideoModal, isVideoModalOpen, installVideoModal });
}
