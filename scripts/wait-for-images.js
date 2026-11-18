// scripts/wait-for-images.js — Waits until every <img> on a page has settled.
//
// "Settled" is not the same as "the first load or error event happened": a video
// thumbnail whose local file (images/thumbs/<id>.jpg) is missing fires an error,
// the page (core/media.js) answers by switching the image to its YouTube address,
// and THAT is loaded next, and may fail too (then the card becomes the plain
// "Video" tile). Waiting only for the first event would print the page while the
// second load is still under way, so the PDF would show a missing thumbnail.
//
// waitForImages() therefore looks again after every round, and only returns once
// two scans in a row find nothing still loading. It is written to run INSIDE the
// page (Playwright's page.evaluate sends its source to the browser), so it uses
// only browser globals and nothing from this file.
//
// Returns the addresses of images still loading when `maxMs` ran out (an empty
// list = all settled). A stalled request must not hang a print run forever.

async function waitForImages(maxMs) {
    const deadline = Date.now() + maxMs;
    const loading = () => [...document.images].filter(img => !img.complete);
    const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
    let cleanScans = 0;
    while (cleanScans < 2) {
        const pending = loading();
        if (!pending.length) {
            cleanScans++;
            await pause(50);       // let an error handler that is about to run swap a src
            continue;
        }
        cleanScans = 0;
        const left = deadline - Date.now();
        if (left <= 0) return pending.map(img => img.currentSrc || img.src);
        await Promise.race([
            Promise.all(pending.map(img => new Promise(resolve => {
                img.addEventListener('load', resolve, { once: true });
                img.addEventListener('error', resolve, { once: true });
            }))),
            pause(left),
        ]);
        await pause(0);            // the page's own error handler runs before we look again
    }
    return [];
}

module.exports = { waitForImages };
