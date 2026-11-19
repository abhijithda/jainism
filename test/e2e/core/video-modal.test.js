const { test, expect } = require('@playwright/test');
const path = require('path');

// Videos open in a player on the page (not a new tab), and the assistant's "Watch" button opens that same
// player at the moment in the video that an answer is about. YouTube itself is blocked here: what is checked
// is the page's own behaviour (the dialog, the address it asks the player for, focus and Esc).

const ID = 'bgldj0TMZB4';
const CLOUD = 'https://pooja-ai-proxy.abhijith-da.workers.dev/**';
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };

test.beforeEach(async ({ page }) => {
    await page.route('**/data.json', route => route.fulfill({ path: path.join(__dirname, '..', '..', 'data.json') }));
    await page.route(/youtube(-nocookie)?\.com|ytimg\.com|youtu\.be/, route => route.abort());
});

test.describe('video thumbnails', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/');
        await page.locator('.view-toggle-btn[data-view="continuous"]').click();
        await expect(page.locator('.video-card a').first()).toBeVisible();
    });

    test('a click plays the video in a dialog on this page, with a way out to YouTube', async ({ page }) => {
        const pages = [];
        page.context().on('page', p => pages.push(p));
        await page.locator('.video-card a').first().click();
        const dialog = page.locator('.video-modal');
        await expect(dialog).toBeVisible();
        await expect(dialog.locator('iframe')).toHaveAttribute('src', new RegExp(`youtube-nocookie\\.com/embed/${ID}\\?.*start=0`));
        await expect(dialog.locator('.video-modal__yt')).toHaveAttribute('href', `https://www.youtube.com/watch?v=${ID}`);
        expect(pages).toHaveLength(0);                          // no new tab
        await expect(dialog.locator('.video-modal__close')).toBeFocused();
    });

    test('Escape, the close button and the backdrop each close it, and the player is removed', async ({ page }) => {
        const thumb = page.locator('.video-card a').first();
        const dialog = page.locator('.video-modal');

        await thumb.click();
        await page.keyboard.press('Escape');
        await expect(dialog).toBeHidden();
        await expect(dialog.locator('iframe')).toHaveCount(0);
        await expect(thumb).toBeFocused();                       // back where the reader was

        await thumb.click();
        await dialog.locator('.video-modal__close').click();
        await expect(dialog).toBeHidden();

        await thumb.click();
        await dialog.click({ position: { x: 4, y: 4 } });        // the dark area, not the box
        await expect(dialog).toBeHidden();
    });

    test('the page behind cannot scroll while it is open, and can again after', async ({ page }) => {
        await page.locator('.video-card a').first().click();
        expect(await page.evaluate(() => getComputedStyle(document.body).overflow)).toBe('hidden');
        await page.keyboard.press('Escape');
        expect(await page.evaluate(() => getComputedStyle(document.body).overflow)).not.toBe('hidden');
    });

    test('the dialog is never part of a printed page', async ({ page }) => {
        await page.locator('.video-card a').first().click();
        await page.emulateMedia({ media: 'print' });
        await expect(page.locator('.video-modal')).toBeHidden();
    });
});

test.describe('the assistant\u2019s Watch button', () => {
    test.beforeEach(async ({ page }) => {
        await page.route(CLOUD, route => route.fulfill({ status: 200, headers: CORS, contentType: 'application/json', body: JSON.stringify({ text: 'The book says they are not equal [A-1.1].' }) }));
        await page.route('**/assets/transcripts/index.json', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ [ID]: {} }) }));
        await page.route(`**/assets/transcripts/${ID}.json`, route => route.fulfill({
            contentType: 'application/json',
            body: JSON.stringify({
                videoId: ID, lang: 'en', source: 'captions',
                segments: [[0, 'welcome everyone'], [754, 'here the speaker explains why shasana devata cannot be worshipped as equal to tirthankara'], [900, 'thank you']],
            }),
        }));
        await page.goto('/');
        await page.locator('#home-ai-engine-select').selectOption('cloud');
        await page.locator('#ai-btn').click();
    });

    async function ask(page, question) {
        await page.locator('#ai-input').fill(question);
        await page.locator('#ai-send').click();
    }

    test('an answer offers the moment in the video, and Watch plays it from there over the open drawer', async ({ page }) => {
        await ask(page, 'worshipping shasana devata as equal to tirthankara');
        const watch = page.locator('.ai-videos button.ai-watch').first();
        await expect(watch).toBeVisible();
        await expect(watch).toHaveText('\u25B6 12:32');                 // a couple of seconds before the line
        await expect(page.locator('.ai-moment-snippet').first()).toContainText('shasana devata cannot be worshipped');
        await expect(page.locator('.ai-moment-note').first()).toContainText('captions');

        await watch.click();
        const dialog = page.locator('.video-modal');
        await expect(dialog.locator('iframe')).toHaveAttribute('src', new RegExp(`/embed/${ID}\\?.*start=752`));
        await expect(dialog).toBeVisible();

        // The video is above the drawer, and Esc closes only the video: the conversation stays open.
        await page.keyboard.press('Escape');
        await expect(dialog).toBeHidden();
        await expect(page.locator('#ai-drawer')).toBeVisible();
        await expect(watch).toBeVisible();
    });

    test('with no transcripts at all the video that goes with the passage is still offered', async ({ page }) => {
        await page.route('**/assets/transcripts/index.json', route => route.fulfill({ status: 404, body: '' }));
        await page.reload();
        await expect(page.locator('#ai-drawer')).toBeVisible();          // a reload brings an open drawer back
        await ask(page, 'worshipping shasana devata as equal to tirthankara');
        const watch = page.locator('.ai-videos button.ai-watch').first();
        await expect(watch).toBeVisible();
        await expect(watch).toHaveText('\u25B6 Watch');
        await watch.click();
        await expect(page.locator('.video-modal iframe')).toHaveAttribute('src', new RegExp(`/embed/${ID}\\?.*start=0`));
    });
});
