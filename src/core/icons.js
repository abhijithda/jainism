// core/icons.js — The small line icons the header, Home and Ask panel use, as inline SVG (the site loads no icon font,
// so nothing extra is downloaded and it all works offline).
// Each is a list of path strings on a 24 x 24 grid, drawn with a 2px round stroke in the current text color.
// Shapes are from Tabler Icons (MIT licence, https://tabler.io/icons), outline set.
//
// Two ways to use them:
//   • In index.html:  <span class='ic' data-icon='home'></span>   — hydrateIcons() fills it in when the app starts.
//   • In JavaScript:  icon(document, 'search')                    — returns an <svg> element.
// Size comes from the text size around the icon (1em) unless a size is given, so they scale with the font.

const PATHS = {
    home: ['M5 12l-2 0l9 -9l9 9l-2 0', 'M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2 -2v-7', 'M9 21v-6a2 2 0 0 1 2 -2h2a2 2 0 0 1 2 2v6'],
    'book-2': ['M19 4v16h-12a2 2 0 0 1 -2 -2v-12a2 2 0 0 1 2 -2h12', 'M19 16h-12a2 2 0 0 0 -2 2', 'M9 8h6'],
    'layout-list': ['M4 6a2 2 0 0 1 2 -2h12a2 2 0 0 1 2 2v2a2 2 0 0 1 -2 2h-12a2 2 0 0 1 -2 -2l0 -2', 'M4 16a2 2 0 0 1 2 -2h12a2 2 0 0 1 2 2v2a2 2 0 0 1 -2 2h-12a2 2 0 0 1 -2 -2l0 -2'],
    search: ['M3 10a7 7 0 1 0 14 0a7 7 0 1 0 -14 0', 'M21 21l-6 -6'],
    sparkles: ['M16 18a2 2 0 0 1 2 2a2 2 0 0 1 2 -2a2 2 0 0 1 -2 -2a2 2 0 0 1 -2 2m0 -12a2 2 0 0 1 2 2a2 2 0 0 1 2 -2a2 2 0 0 1 -2 -2a2 2 0 0 1 -2 2m-7 12a6 6 0 0 1 6 -6a6 6 0 0 1 -6 -6a6 6 0 0 1 -6 6a6 6 0 0 1 6 6'],
    school: ['M22 9l-10 -4l-10 4l10 4l10 -4v6', 'M6 10.6v5.4a6 3 0 0 0 12 0v-5.4'],
    'arrows-maximize': ['M16 4l4 0l0 4', 'M14 10l6 -6', 'M8 20l-4 0l0 -4', 'M4 20l6 -6', 'M16 20l4 0l0 -4', 'M14 14l6 6', 'M8 4l-4 0l0 4', 'M4 4l6 6'],
    'arrows-minimize': ['M5 9l4 0l0 -4', 'M3 3l6 6', 'M5 15l4 0l0 4', 'M3 21l6 -6', 'M19 9l-4 0l0 -4', 'M15 9l6 -6', 'M19 15l-4 0l0 4', 'M15 15l6 6'],
    settings: ['M10.325 4.317c.426 -1.756 2.924 -1.756 3.35 0a1.724 1.724 0 0 0 2.573 1.066c1.543 -.94 3.31 .826 2.37 2.37a1.724 1.724 0 0 0 1.065 2.572c1.756 .426 1.756 2.924 0 3.35a1.724 1.724 0 0 0 -1.066 2.573c.94 1.543 -.826 3.31 -2.37 2.37a1.724 1.724 0 0 0 -2.572 1.065c-.426 1.756 -2.924 1.756 -3.35 0a1.724 1.724 0 0 0 -2.573 -1.066c-1.543 .94 -3.31 -.826 -2.37 -2.37a1.724 1.724 0 0 0 -1.065 -2.572c-1.756 -.426 -1.756 -2.924 0 -3.35a1.724 1.724 0 0 0 1.066 -2.573c-.94 -1.543 .826 -3.31 2.37 -2.37c1 .608 2.296 .07 2.572 -1.065', 'M9 12a3 3 0 1 0 6 0a3 3 0 0 0 -6 0'],
    'circle-check': ['M3 12a9 9 0 1 0 18 0a9 9 0 1 0 -18 0', 'M9 12l2 2l4 -4'],
    language: ['M9 6.371c0 4.418 -2.239 6.629 -5 6.629', 'M4 6.371h7', 'M5 9c0 2.144 2.252 3.908 6 4', 'M12 20l4 -9l4 9', 'M19.1 18h-6.2', 'M6.694 3l.793 .582'],
    typography: ['M4 20l3 0', 'M14 20l7 0', 'M6.9 15l6.9 0', 'M10.2 6.3l5.8 13.7', 'M5 20l6 -16l2 0l7 16'],
    'ruler-2': ['M17 3l4 4l-14 14l-4 -4l14 -14', 'M16 7l-1.5 -1.5', 'M13 10l-1.5 -1.5', 'M10 13l-1.5 -1.5', 'M7 16l-1.5 -1.5'],
    video: ['M15 10l4.553 -2.276a1 1 0 0 1 1.447 .894v6.764a1 1 0 0 1 -1.447 .894l-4.553 -2.276v-4', 'M3 8a2 2 0 0 1 2 -2h8a2 2 0 0 1 2 2v8a2 2 0 0 1 -2 2h-8a2 2 0 0 1 -2 -2l0 -8'],
    qrcode: ['M4 5a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v4a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1l0 -4', 'M7 17l0 .01', 'M14 5a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v4a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1l0 -4', 'M7 7l0 .01', 'M4 15a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v4a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1l0 -4', 'M17 7l0 .01', 'M14 14l3 0', 'M20 14l0 .01', 'M14 14l0 3', 'M14 20l3 0', 'M17 17l3 0', 'M20 17l0 3'],
    lock: ['M5 13a2 2 0 0 1 2 -2h10a2 2 0 0 1 2 2v6a2 2 0 0 1 -2 2h-10a2 2 0 0 1 -2 -2v-6', 'M11 16a1 1 0 1 0 2 0a1 1 0 0 0 -2 0', 'M8 11v-4a4 4 0 1 1 8 0v4'],
    adjustments: ['M4 10a2 2 0 1 0 4 0a2 2 0 0 0 -4 0', 'M6 4v4', 'M6 12v8', 'M10 16a2 2 0 1 0 4 0a2 2 0 0 0 -4 0', 'M12 4v10', 'M12 18v2', 'M16 7a2 2 0 1 0 4 0a2 2 0 0 0 -4 0', 'M18 4v1', 'M18 9v11'],
    'cloud-download': ['M19 18a3.5 3.5 0 0 0 0 -7h-1a5 4.5 0 0 0 -11 -2a4.6 4.4 0 0 0 -2.1 8.4', 'M12 13l0 9', 'M9 19l3 3l3 -3'],
    'arrow-left': ['M5 12l14 0', 'M5 12l6 6', 'M5 12l6 -6'],
    'arrow-right': ['M5 12l14 0', 'M13 18l6 -6', 'M13 6l6 6'],
    x: ['M18 6l-12 12', 'M6 6l12 12'],
    'chevron-down': ['M6 9l6 6l6 -6'],
    'chevron-right': ['M9 6l6 6l-6 6'],
    'corner-down-right': ['M6 6v6a3 3 0 0 0 3 3h10l-4 -4m0 8l4 -4'],
    'player-play': ['M7 4v16l13 -8l-13 -8'],
    'arrows-diagonal': ['M16 4l4 0l0 4', 'M14 10l6 -6', 'M8 20l-4 0l0 -4', 'M4 20l6 -6'],
    'arrow-up': ['M12 5l0 14', 'M18 11l-6 -6', 'M6 11l6 -6'],
    'message-question': ['M8 9h8', 'M8 13h6', 'M14 18h-1l-5 3v-3h-2a3 3 0 0 1 -3 -3v-8a3 3 0 0 1 3 -3h12a3 3 0 0 1 3 3v4.5', 'M19 22v.01', 'M19 19a2.003 2.003 0 0 0 .914 -3.782a1.98 1.98 0 0 0 -2.414 .483'],
    photo: ['M15 8h.01', 'M3 6a3 3 0 0 1 3 -3h12a3 3 0 0 1 3 3v12a3 3 0 0 1 -3 3h-12a3 3 0 0 1 -3 -3v-12', 'M3 16l5 -5c.928 -.893 2.072 -.893 3 0l5 5', 'M14 14l1 -1c.928 -.893 2.072 -.893 3 0l3 3'],
};

export const ICON_NAMES = Object.keys(PATHS);

const NS = 'http://www.w3.org/2000/svg';

/** An <svg> element for `name`, hidden from screen readers (the button around it carries the label). */
export function icon(doc, name, size = '1em') {
    const svg = doc.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', String(size));
    svg.setAttribute('height', String(size));
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    (PATHS[name] || []).forEach(d => {
        const p = doc.createElementNS(NS, 'path');
        p.setAttribute('d', d);
        svg.appendChild(p);
    });
    return svg;
}

/** Fills every empty <span data-icon='name'> under `root` with its icon. Safe to call again (already-filled ones are skipped). */
export function hydrateIcons(root = document) {
    root.querySelectorAll('[data-icon]').forEach(el => {
        if (el.firstElementChild) return;
        el.appendChild(icon(el.ownerDocument, el.dataset.icon, el.dataset.size || '1em'));
    });
}

// CommonJS shim for Jest
if (typeof module !== 'undefined' && module.exports) Object.assign(module.exports, { ICON_NAMES, icon, hydrateIcons });
