// sync/icons.js — The few small line icons the Sync row uses, as inline SVG (the site loads no icon font).
// Each is a list of path strings on a 24 x 24 grid, drawn with a 2px round stroke in the current text color.

const PATHS = {
    check:   ['M5 12l5 5l10 -10'],
    refresh: ['M20 11a8.1 8.1 0 0 0 -15.5 -2m-.5 -4v4h4', 'M4 13a8.1 8.1 0 0 0 15.5 2m.5 4v-4h-4'],
    user:    ['M3 12a9 9 0 1 0 18 0a9 9 0 1 0 -18 0', 'M9 10a3 3 0 1 0 6 0a3 3 0 1 0 -6 0', 'M6.168 18.849a4 4 0 0 1 3.832 -2.849h4a4 4 0 0 1 3.834 2.855'],
    warn:    ['M12 9v4', 'M10.363 3.591l-8.106 13.534a1.914 1.914 0 0 0 1.636 2.871h16.214a1.914 1.914 0 0 0 1.636 -2.87l-8.106 -13.536a1.914 1.914 0 0 0 -3.274 0z', 'M12 16h.01'],
    off:     ['M7 18a4.6 4.4 0 0 1 0 -9a5 4.5 0 0 1 11 2h1a3.5 3.5 0 0 1 0 7h-12', 'M3 3l18 18'],
    logout:  ['M14 8v-2a2 2 0 0 0 -2 -2h-7a2 2 0 0 0 -2 2v12a2 2 0 0 0 2 2h7a2 2 0 0 0 2 -2v-2', 'M9 12h12l-3 -3', 'M18 15l3 -3'],
    trash:   ['M4 7l16 0', 'M10 11l0 6', 'M14 11l0 6', 'M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2 -2l1 -12', 'M9 7v-3a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v3'],
    lock:    ['M5 13a2 2 0 0 1 2 -2h10a2 2 0 0 1 2 2v6a2 2 0 0 1 -2 2h-10a2 2 0 0 1 -2 -2v-6z', 'M11 16a1 1 0 1 0 2 0a1 1 0 0 0 -2 0', 'M8 11v-4a4 4 0 1 1 8 0v4'],
};

export const ICON_NAMES = Object.keys(PATHS);

/** An <svg> element for `name`, hidden from screen readers (the button or state around it carries the label). */
export function icon(doc, name, size = 18) {
    const NS = 'http://www.w3.org/2000/svg';
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

// ── Status clouds: one filled cloud whose color and inner mark show the state, readable even without color ──
//   out   grey outline            sync is off
//   sync  blue, arrows (they turn while syncing)
//   ok    green, check            warn  amber, exclamation            off   grey, slash (offline)
const CLOUD = 'M7 18a4.6 4.4 0 0 1 0 -9a5 4.5 0 0 1 11 2h1a3.5 3.5 0 0 1 0 7h-12z';
const MARKS = { ok: ['M9 12.5l2.5 2.5l4.5 -5'], warn: ['M12.5 8.8v3.6', 'M12.5 15.2h.01'], off: ['M8.5 8l8 8'] };
const MARK_WIDTH = { ok: 2.2, warn: 2.4, off: 2.2 };
const ARROWS = ['M20 11a8.1 8.1 0 0 0 -15.5 -2m-.5 -4v4h4', 'M4 13a8.1 8.1 0 0 0 15.5 2m.5 4v-4h-4'];
export const CLOUD_KINDS = ['out', 'sync', 'ok', 'warn', 'off'];

/** A status cloud in the current text color (CSS sets the color per state). */
export function cloudIcon(doc, kind, size = 20) {
    const NS = 'http://www.w3.org/2000/svg';
    const make = (tag, attrs) => { const e = doc.createElementNS(NS, tag); Object.entries(attrs).forEach(([k, v]) => e.setAttribute(k, String(v))); return e; };
    const svg = make('svg', { viewBox: '0 0 24 24', width: size, height: size, 'aria-hidden': 'true', focusable: 'false' });
    svg.appendChild(kind === 'out'
        ? make('path', { d: CLOUD, fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linejoin': 'round' })
        : make('path', { d: CLOUD, fill: 'currentColor', stroke: 'currentColor', 'stroke-width': 1, 'stroke-linejoin': 'round' }));
    const white = w => ({ fill: 'none', stroke: '#fff', 'stroke-width': w, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
    if (kind === 'sync') {
        // Two groups: the outer one places and scales the arrows, the inner one (class sync-cloud-arrows) is what CSS turns.
        const place = make('g', { transform: 'translate(5.9 5.3) scale(.55)', ...white(3) });
        const spin = make('g', { class: 'sync-cloud-arrows' });
        ARROWS.forEach(d => spin.appendChild(make('path', { d })));
        place.appendChild(spin);
        svg.appendChild(place);
    } else if (MARKS[kind]) {
        MARKS[kind].forEach(d => svg.appendChild(make('path', { d, ...white(MARK_WIDTH[kind]) })));
    }
    return svg;
}

/** Google's "G" in its four colors, unmodified (Google's branding rules for sign-in buttons). */
export function googleG(doc, size = 18) {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = doc.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 48 48');
    svg.setAttribute('width', String(size));
    svg.setAttribute('height', String(size));
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    [['#EA4335', 'M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z'],
     ['#4285F4', 'M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z'],
     ['#FBBC05', 'M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z'],
     ['#34A853', 'M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z']]
        .forEach(([fill, d]) => { const p = doc.createElementNS(NS, 'path'); p.setAttribute('fill', fill); p.setAttribute('d', d); svg.appendChild(p); });
    return svg;
}

// CommonJS shim for Jest
if (typeof module !== 'undefined' && module.exports) Object.assign(module.exports, { ICON_NAMES, CLOUD_KINDS, icon, cloudIcon, googleG });
