/** @jest-environment node */
// waitForImages() runs inside the browser, so it only uses `document` and
// setTimeout. Here `document` is a small fake with images that behave like the
// real thumbnails: first try (local file) fails, the page swaps the src to the
// YouTube address, and that second try finishes later.

const { waitForImages } = require('./wait-for-images');

function fakeImage({ steps }) {
    // steps: what happens after each load attempt, in order: 'load', 'error', or
    // 'error-then-retry' (error, then the page starts a second attempt that ends with the next step)
    const listeners = { load: [], error: [] };
    const img = {
        complete: false,
        src: 'images/thumbs/x.jpg',
        currentSrc: '',
        addEventListener(type, fn) { listeners[type].push(fn); },
        fire(type) {
            img.complete = true;
            const list = listeners[type].splice(0);
            listeners.load.length = 0; listeners.error.length = 0;
            list.forEach(fn => fn());
        },
    };
    let attempt = 0;
    const next = () => {
        const step = steps[attempt++];
        setTimeout(() => {
            if (step === 'load') img.fire('load');
            else if (step === 'error') img.fire('error');
            else if (step === 'error-then-retry') {
                img.complete = true;
                const list = listeners.error.splice(0);
                listeners.load.length = 0;
                // the page's own error handler swaps the src: loading again, before our listener looks
                img.src = 'https://img.youtube.com/vi/x/0.jpg'; img.complete = false;
                list.forEach(fn => fn());
                next();
            }
        }, 20);
    };
    next();
    return img;
}

function withImages(images, fn) {
    global.document = { images };
    return fn().finally(() => { delete global.document; });
}

test('returns at once when there are no images, or all are loaded', async () => {
    await withImages([], async () => expect(await waitForImages(1000)).toEqual([]));
    await withImages([{ complete: true, addEventListener() {} }], async () => expect(await waitForImages(1000)).toEqual([]));
});

test('waits for a plain image to load', async () => {
    const img = fakeImage({ steps: ['load'] });
    await withImages([img], async () => {
        expect(await waitForImages(2000)).toEqual([]);
        expect(img.complete).toBe(true);
    });
});

test('after an error that makes the page try another address, waits for that second try too', async () => {
    const img = fakeImage({ steps: ['error-then-retry', 'load'] });
    await withImages([img], async () => {
        expect(await waitForImages(2000)).toEqual([]);
        expect(img.src).toBe('https://img.youtube.com/vi/x/0.jpg');
        expect(img.complete).toBe(true);       // a wait for the first event only would return here with it still loading
    });
});

test('also settles when the second try fails too (the plain tile case)', async () => {
    const img = fakeImage({ steps: ['error-then-retry', 'error'] });
    await withImages([img], async () => {
        expect(await waitForImages(2000)).toEqual([]);
        expect(img.complete).toBe(true);
    });
});

test('gives up at the time limit and reports what is still loading, instead of hanging', async () => {
    const stuck = { complete: false, src: 'https://img.youtube.com/vi/stuck/0.jpg', currentSrc: '', addEventListener() {} };
    await withImages([stuck], async () => {
        const started = Date.now();
        expect(await waitForImages(200)).toEqual(['https://img.youtube.com/vi/stuck/0.jpg']);
        expect(Date.now() - started).toBeLessThan(1500);
    });
});
