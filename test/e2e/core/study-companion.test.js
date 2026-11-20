const { test, expect } = require('@playwright/test');
const path = require('path');
const fs = require('fs');

// Study companion (src/study/): questions after a block is marked read. It lives in
// src/core + src/study and works on both views, so it is tested here, not under book/ or continuous/.
// Uses the real data.json: the Deva Moodhata / Loka Moodhata comparison comes from its tags and text.

const DATA = path.join(__dirname, '..', '..', '..', 'assets', 'data.json');
const data = JSON.parse(fs.readFileSync(DATA, 'utf8'));
// A block tagged Deva Moodhata that is not also a Shasana Devata one, so the comparison offered is the Moodhata one.
const devaBlock = data.flatMap(i => i.blocks || []).find(b => (b.tags || []).includes('Deva Moodhata') && !(b.tags || []).includes('Shasana Devata'));

// Questions only use what has been read, so the note that names Loka Moodhata counts as read in these tests
// (the tests below tick the Deva Moodhata block themselves).
const lokaNote = data.flatMap(i => i.blocks || []).find(b => /Loka Moodhata/.test((b.content?.en || []).join(' ')));

test.beforeEach(async ({ page }) => {
    await page.route('**/data.json', route => route.fulfill({ path: DATA }));
    await page.addInitScript(id => { if (!sessionStorage.getItem('seededRead')) { localStorage.setItem('readBlocks', JSON.stringify([id])); sessionStorage.setItem('seededRead', '1'); } }, lokaNote.id);
});

async function startStudy(page, view) {
    await page.goto('/');
    await page.locator(`.view-toggle-btn[data-view="${view}"]`).click();
    await page.locator('#settings-btn').click();
    await page.locator('#toggle-study').check();
    await expect(page.locator('#study-btn')).toBeVisible();
    await expect(page.locator('#toggle-read-tracking')).toBeChecked();   // Study needs the ticks
    await page.locator('#settings-btn').click();                          // close the menu
}

test('continuous view: tick a block, get a nudge, open it, see the question and the book\u2019s words', async ({ page }) => {
    await startStudy(page, 'continuous');
    const tick = page.locator(`#${devaBlock.id} .read-tick`);
    await tick.scrollIntoViewIfNeeded();
    await tick.click();

    const nudge = page.locator('#study-nudge');
    await expect(nudge).toBeVisible();
    await expect(nudge).toContainText('Deva Moodhata vs Loka Moodhata');
    await expect(page.locator('#study-drawer')).toBeHidden();             // offers, never interrupts

    await nudge.locator('.study-nudge-open').click();
    await expect(page.locator('#study-drawer')).toBeVisible();
    await expect(page.locator('#study-body')).toContainText('how it differs from Loka Moodhata');
    await page.getByRole('button', { name: 'Show what the book says' }).first().click();
    await expect(page.locator('#study-body .ai-passage').first()).toBeVisible();
    await expect(page.locator('#study-body')).toContainText('What the book says about Loka Moodhata');
    await page.screenshot({ path: 'test-results/study-continuous.png' });
});

test('book view: a chip in the panel opens that passage in the book', async ({ page }) => {
    await startStudy(page, 'book');
    // Turn pages until a tickable block of the Moodhata topic is on screen.
    const tick = page.locator(`#book-${devaBlock.id} .read-tick`);
    for (let i = 0; i < 80 && !(await tick.isVisible()); i++) await page.keyboard.press('ArrowRight');
    await tick.click();
    await page.locator('#study-btn').click();
    await page.getByRole('button', { name: 'Show what the book says' }).first().click();
    const chip = page.locator('#study-body .ai-passage .ai-cite').first();
    const label = await chip.textContent();
    await chip.click();
    await expect(page.locator('#book-container')).toContainText(label);
    await page.screenshot({ path: 'test-results/study-book.png' });
});

test('"I got it" is remembered across a reload: the same question is not asked again', async ({ page }) => {
    await startStudy(page, 'continuous');
    await page.locator(`#${devaBlock.id} .read-tick`).click();
    await page.locator('#study-btn').click();
    await page.getByRole('button', { name: 'Show what the book says' }).first().click();
    await page.getByRole('button', { name: /I got it/ }).first().click();

    await page.reload();
    await expect(page.locator('#study-drawer')).toBeVisible();            // the open panel comes back after a reload...
    await page.locator('#study-drawer .ai-close').click();                // ...close it to reach the header
    await page.locator('.view-toggle-btn[data-view="continuous"]').click();
    await page.locator('#settings-btn').click();
    await page.locator('#toggle-read-tracking').check();
    await page.locator('#settings-btn').click();
    await page.locator(`#${devaBlock.id} .read-tick`).click();            // un-tick (it was read)
    await page.locator(`#${devaBlock.id} .read-tick`).click();            // tick again
    await page.locator('#study-btn').click();
    await expect(page.locator('#study-body')).not.toContainText('differs from Loka Moodhata');
});

test('on a phone the panel and nudge fit the screen and the page does not scroll sideways', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 740 });
    await startStudy(page, 'continuous');
    await page.locator(`#${devaBlock.id} .read-tick`).click();
    const box = await page.locator('#study-nudge').boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(360);
    await page.locator('#study-nudge .study-nudge-open').click();
    const drawer = await page.locator('#study-drawer').boundingBox();
    expect(drawer.width).toBeLessThanOrEqual(360);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    await page.screenshot({ path: 'test-results/study-phone.png' });
});

test('off by default, and nothing study-related shows in print', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#study-btn')).toBeHidden();
    await page.emulateMedia({ media: 'print' });
    await expect(page.locator('#study-nudge')).toBeHidden();
    await expect(page.locator('#study-drawer')).toBeHidden();
});

test('Home page: the Study switch turns Study on, and Read tracking with it (both places show it, and it is locked)', async ({ page }) => {
    await page.goto('/');
    await page.locator('#home-btn').click();
    await page.locator('#home-toggle-study').check();
    await expect(page.locator('#home-toggle-study')).toBeChecked();
    await expect(page.locator('#home-toggle-read-tracking')).toBeChecked();
    await expect(page.locator('#home-toggle-read-tracking')).toHaveAttribute('aria-disabled', 'true');
    await expect(page.locator('#home-rt-lock-note')).toBeVisible();
    await expect(page.locator('#toggle-study')).toBeChecked();
    await expect(page.locator('#toggle-read-tracking')).toBeChecked();
    await expect(page.locator('#study-btn')).toBeVisible();
    expect(await page.evaluate(() => document.body.classList.contains('show-read-tracking'))).toBe(true);

    await page.locator('#home-toggle-study').uncheck();                    // off again: Read tracking stays on, unlocked
    await expect(page.locator('#home-toggle-read-tracking')).toHaveAttribute('aria-disabled', 'false');
    await expect(page.locator('#home-rt-lock-note')).toBeHidden();
    await expect(page.locator('#home-toggle-read-tracking')).toBeChecked();
    await expect(page.locator('#study-btn')).toBeHidden();
});

test('a saved "Study on, Read tracking off" is repaired on load: ticks show', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('settings', JSON.stringify({ studyCompanion: true, readTracking: false })));
    await page.goto('/');
    await page.locator('.view-toggle-btn[data-view="continuous"]').click();
    await expect(page.locator('.read-tick').first()).toBeVisible();
    await page.locator('#settings-btn').click();
    await expect(page.locator('#toggle-read-tracking')).toBeChecked();
    await expect(page.locator('#toggle-read-tracking')).toHaveAttribute('aria-disabled', 'true');
    await expect(page.locator('#rt-lock-note')).toBeVisible();
});

test('trying to switch Read tracking off while Study is on: it stays on and a message says why (menu and Home)', async ({ page }) => {
    await page.addInitScript(() => { if (!sessionStorage.getItem('s2')) { localStorage.setItem('settings', JSON.stringify({ studyCompanion: true, readTracking: true })); sessionStorage.setItem('s2', '1'); } });
    await page.goto('/');
    await page.locator('#settings-btn').click();
    await expect(page.locator('#rt-lock-note')).toContainText('Read tracking stays on while the study companion is on');
    await page.locator('label.switch:has(#toggle-read-tracking)').click({ force: true });
    await expect(page.locator('#toggle-read-tracking')).toBeChecked();
    await expect(page.locator('#rt-lock-note')).toHaveClass(/rt-lock-flash/);
    await page.screenshot({ path: 'test-results/study-lock-menu.png' });
    await page.locator('#settings-btn').click();
    await page.locator('#home-btn').click();
    await expect(page.locator('#home-rt-lock-note')).toBeVisible();
    await page.locator('label.switch:has(#home-toggle-read-tracking)').click({ force: true });
    await expect(page.locator('#home-toggle-read-tracking')).toBeChecked();
    await expect(page.locator('#home-rt-lock-note')).toHaveClass(/rt-lock-flash/);
});

test('the Settings menu and the Home page list Study and Offline copy in the same order', async ({ page }) => {
    await page.goto('/');
    await page.locator('#settings-btn').click();
    const menu = await page.locator('input[type="checkbox"][id^="toggle-"]').evaluateAll(els => els.map(e => e.id).filter(id => /^toggle-(videos|qrs|read-tracking|study|offline)$/.test(id)));
    await page.locator('#settings-btn').click();
    await page.locator('#home-btn').click();
    const home = await page.locator('.home-settings input[type="checkbox"]').evaluateAll(els => els.map(e => e.id).filter(id => /^home-toggle-(videos|qrs|read-tracking|study|offline)$/.test(id)));
    expect(menu.map(i => i.replace('toggle-', ''))).toEqual(['videos', 'qrs', 'read-tracking', 'study', 'offline']);
    expect(home.map(i => i.replace('home-toggle-', ''))).toEqual(menu.map(i => i.replace('toggle-', '')));
});

test('book view: arrow keys while typing an answer move the caret and do not turn the page', async ({ page }) => {
    await startStudy(page, 'book');
    const tick = page.locator(`#book-${devaBlock.id} .read-tick`);
    for (let i = 0; i < 80 && !(await tick.isVisible()); i++) await page.keyboard.press('ArrowRight');
    await tick.click();
    await page.locator('#study-btn').click();
    const box = page.locator('#study-body .study-answer').first();
    await box.click();
    await box.pressSequentially('helo');
    const before = await page.locator('#book-page-num-left').textContent();
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('PageDown');
    expect(await page.locator('#book-page-num-left').textContent()).toBe(before);
    await page.keyboard.type('l');                                        // the caret really moved: "helo" -> "hel" + "l" + "o"
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.type('l');
    expect(await box.inputValue()).toMatch(/l/);
    expect(await page.locator('#book-page-num-left').textContent()).toBe(before);
    // ...and on the page itself the arrow still turns it
    await page.locator('#study-drawer .ai-close').click();
    await page.locator('body').click({ position: { x: 5, y: 300 } });
    await page.keyboard.press('ArrowRight');
    expect(await page.locator('#book-page-num-left').textContent()).not.toBe(before);
});
