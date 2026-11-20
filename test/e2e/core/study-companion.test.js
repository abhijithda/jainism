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

test.beforeEach(async ({ page }) => {
    await page.route('**/data.json', route => route.fulfill({ path: DATA }));
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
