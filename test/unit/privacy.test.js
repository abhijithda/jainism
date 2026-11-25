// privacy.html is what Google's consent screen links to, so it has to exist at the address the docs give,
// say what the sign-in really does, and stay a single self-contained page (the offline copy saves it).

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const page = fs.readFileSync(path.join(ROOT, 'privacy.html'), 'utf8');
const index = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const sync = fs.readFileSync(path.join(ROOT, 'docs', 'SYNC.md'), 'utf8');
const scope = fs.readFileSync(path.join(ROOT, 'src', 'sync', 'auth.js'), 'utf8').match(/DRIVE_SCOPE = '([^']+)'/)[1];

test('it says where the account address shows and that the last one is remembered', () => {
    expect(page).toMatch(/top of the account menu/);
    expect(page).toMatch(/preselect/);
    const engine = fs.readFileSync(path.join(ROOT, 'src', 'sync', 'sync-engine.js'), 'utf8');
    expect(engine).toContain("LAST_EMAIL_KEY = 'syncLastEmail'");
});

test('it states what Google requires: the scope used, where data lives, and that the owner never receives it', () => {
    expect(page).toContain(scope);
    expect(page).toContain('appDataFolder');
    expect(page).toMatch(/never receives, collects, reads or stores/);
    expect(page).toMatch(/Limited Use/);
    expect(page).toContain('https://developers.google.com/terms/api-services-user-data-policy#limited-use');
    expect(page).toMatch(/not sold, shared, rented or transferred/);
});

test('it names the file really written to Drive, and the real ways to sign out and delete', () => {
    const drive = fs.readFileSync(path.join(ROOT, 'src', 'sync', 'drive.js'), 'utf8');
    expect(page).toContain(drive.match(/FILE_NAME = '([^']+)'/)[1]);
    expect(page).toContain('Delete synced data');
    expect(page).toContain('Sign out');
    expect(page).toContain('myaccount.google.com/permissions');
});

test('every setting it says is synced is one that really syncs, and device-only ones are called out', () => {
    const { SYNCED_PREFS } = require('../../src/sync/sync-merge');
    expect(SYNCED_PREFS).toEqual(['langs', 'videos', 'qrs', 'readTracking', 'studyCompanion', 'paperSize', 'fontScale']);
    ['languages', 'videos', 'QR codes', 'read tracking', 'study companion', 'paper size', 'font size'].forEach(w => expect(page).toContain(w));
    expect(page).toMatch(/offline copy switch and everything about the AI assistant/);
});

test('it is one self-contained page: no scripts, no external stylesheets or images', () => {
    expect(page).not.toMatch(/<script\b/i);
    expect(page).not.toMatch(/<link[^>]+rel=["']stylesheet/i);
    expect(page).not.toMatch(/<img\b/i);
});

test('the app links to it (Settings, Home, and the offline copy), and the setup guide gives its address', () => {
    expect(index).toContain('<link rel="privacy-policy" href="privacy.html">');
    expect((index.match(/data-sync hidden><\/div>/g) || []).length).toBe(2);   // Settings and Home mount points; the script builds the row (and its privacy links)
    expect(index).not.toMatch(/<a [^>]*href="privacy\.html"/);                // no link in a page where sign-in is off
    expect(sync).toContain('https://abhijithda.github.io/jainism/privacy.html');
});
