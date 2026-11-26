// The real index.html plus the real start-up code: with a client ID configured, the Sync row must appear in
// Settings and on Home; without one, nothing is added. (The unit tests build their own little pages, so this
// is the test that catches a mismatch between index.html and the script that fills it.)

const fs = require('fs');
const path = require('path');
const { initSync } = require('../../src/sync/index');

const ROOT = path.join(__dirname, '..', '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'assets', 'data.json'), 'utf8'));
const data = Array.isArray(raw) ? raw : raw.items || raw.data || Object.values(raw);
const ID = '1234567890-abc123def.apps.googleusercontent.com';

const config = body => { global.fetch = jest.fn(async () => ({ ok: true, json: async () => body })); };

beforeEach(() => { localStorage.clear(); document.documentElement.innerHTML = html; });
afterEach(() => { delete global.fetch; });

test('with a client ID, the row appears in both places and offers Sign in', async () => {
    config({ googleClientId: ID });
    const engine = await initSync({ data });
    expect(engine).not.toBeNull();
    const mounts = [...document.querySelectorAll('[data-sync]')];
    expect(mounts).toHaveLength(2);
    mounts.forEach(m => {
        expect(m.hidden).toBe(false);
        expect(m.querySelector('.sync-row')).not.toBeNull();
        const signin = m.querySelector('[data-sync-action="signin"]');
        expect(signin.hidden).toBe(false);
        expect(signin.textContent).toBe('Sign in');
        expect(signin.getAttribute('aria-label')).toBe('Sign in with Google');
        expect(m.querySelector('.sync-hint a').getAttribute('href')).toBe('privacy.html');
    });
});

test('without a client ID, nothing is built and nothing is revealed', async () => {
    config({ googleClientId: '' });
    expect(await initSync({ data })).toBeNull();
    document.querySelectorAll('[data-sync]').forEach(m => { expect(m.hidden).toBe(true); expect(m.children).toHaveLength(0); });
});

test('the stylesheet cannot un-hide an unused mount point (a bare display rule would beat [hidden])', () => {
    const css = fs.readFileSync(path.join(ROOT, 'src', 'sync', 'sync.css'), 'utf8');
    expect(css).toMatch(/\.menu-section\[data-sync\]:not\(\[hidden\]\)/);
    expect(css).not.toMatch(/\.menu-section\[data-sync\]\s*\{\s*display/);
});
