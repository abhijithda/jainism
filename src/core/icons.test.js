const { ICON_NAMES, icon, hydrateIcons } = require('./icons');
const fs = require('fs');
const path = require('path');

describe('icons', () => {
    test('icon() makes a decorative, text-sized SVG with paths', () => {
        const svg = icon(document, 'search');
        expect(svg.tagName.toLowerCase()).toBe('svg');
        expect(svg.getAttribute('aria-hidden')).toBe('true');
        expect(svg.getAttribute('width')).toBe('1em');
        expect(svg.querySelectorAll('path').length).toBeGreaterThan(0);
        expect(icon(document, 'search', 26).getAttribute('width')).toBe('26');
    });

    test('hydrateIcons fills each <span data-icon> once', () => {
        document.body.innerHTML = '<span class="ic" data-icon="home"></span><span class="ic" data-icon="x" data-size="30"></span>';
        hydrateIcons();
        hydrateIcons();
        const spans = document.querySelectorAll('[data-icon]');
        expect(spans[0].querySelectorAll('svg')).toHaveLength(1);
        expect(spans[1].querySelector('svg').getAttribute('width')).toBe('30');
    });

    test('every data-icon used in index.html exists in the icon set', () => {
        const html = fs.readFileSync(path.join(__dirname, '..', '..', 'index.html'), 'utf8');
        const used = [...html.matchAll(/data-icon="([^"]+)"/g)].map(m => m[1]);
        expect(used.length).toBeGreaterThan(20);
        used.forEach(name => expect(ICON_NAMES).toContain(name));
    });
});
