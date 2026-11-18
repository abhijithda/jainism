const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

// A web address typed into a block's text (for example the Google Form link in
// a "PS:" note) must be a real, clickable link in every view. It was plain text
// once: the function that makes links existed but no view called it.

const FORM = 'https://forms.gle/example123';

// The fixture, with one answer's text replaced by lines that contain the address
function dataWithLink() {
    const data = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'data.json'), 'utf8'));
    const block = data
        .flatMap(item => item.blocks || [])
        .find(b => b.type !== 'images' && b.content && b.content.en.length && b.content.kn.length);
    block.content.en = ['First line', `Share it at ${FORM} please.`];
    block.content.kn = [`ಲಿಂಕ್ ${FORM} ನಲ್ಲಿ ಹಂಚಿಕೊಳ್ಳಿ.`];
    return { data, blockId: block.id };
}

test.describe('Links in text', () => {
    let blockId;

    test.beforeEach(async ({ page, context }) => {
        const prepared = dataWithLink();
        blockId = prepared.blockId;
        await page.route('**/data.json', route => route.fulfill({
            contentType: 'application/json',
            body: JSON.stringify(prepared.data),
        }));
        // The link points at the real internet; answer it locally
        await context.route('https://forms.gle/**', route => route.fulfill({
            contentType: 'text/html', body: '<title>form</title>',
        }));
        await page.goto('/');
    });

    test('Continuous view: the address is a link that opens in a new tab', async ({ page, context }) => {
        await page.locator('.view-toggle-btn[data-view="continuous"]').click();
        const links = page.locator(`#${blockId} a.text-link`);
        await expect(links).toHaveCount(2);                          // English and Kannada
        for (const link of await links.all()) {
            await expect(link).toHaveAttribute('href', FORM);
            await expect(link).toHaveAttribute('target', '_blank');
            await expect(link).toHaveAttribute('rel', /noopener/);
        }
        // the rest of the sentence is still there, and the line break is kept
        await expect(page.locator(`#${blockId} .col-en p`)).toContainText('Share it at');
        await expect(page.locator(`#${blockId} .col-en p br`)).toHaveCount(1);

        const [popup] = await Promise.all([context.waitForEvent('page'), links.first().click()]);
        expect(popup.url()).toBe(FORM);
    });

    test('Book view: the address is a link, and its text is exactly the address', async ({ page }) => {
        await page.locator('.view-toggle-btn[data-view="book"]').click();
        const links = page.locator(`#book-${blockId} a.text-link`);
        await expect(links).toHaveCount(2);
        await expect(links.first()).toHaveAttribute('href', FORM);
        await expect(links.first()).toHaveText(FORM);
    });

    test('text around a link cannot turn into markup', async ({ page }) => {
        await page.locator('.view-toggle-btn[data-view="continuous"]').click();
        await expect(page.locator(`#${blockId} .col-en p b, #${blockId} .col-en p img`)).toHaveCount(0);
    });
});
