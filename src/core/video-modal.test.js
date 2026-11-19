const { openVideoModal, closeVideoModal, isVideoModalOpen, installVideoModal } = require('./video-modal');

const ID = 'bgldj0TMZB4';
const modal = () => document.querySelector('.video-modal');
const iframe = () => document.querySelector('.video-modal iframe');

beforeEach(() => {
    closeVideoModal();
    document.body.innerHTML = '';
    document.body.className = '';
});

describe('openVideoModal', () => {
    test('opens a dialog with the player at the given second', () => {
        expect(openVideoModal({ videoId: ID, start: 754, label: 'A-3.1' })).toBe(true);
        expect(isVideoModalOpen()).toBe(true);
        expect(modal().getAttribute('role')).toBe('dialog');
        expect(modal().getAttribute('aria-modal')).toBe('true');
        expect(iframe().src).toContain(`/embed/${ID}`);
        expect(iframe().src).toContain('start=754');
        expect(modal().querySelector('.video-modal__title').textContent).toBe('A-3.1 \u00b7 12:34');
        expect(document.body.classList.contains('video-modal-open')).toBe(true);
    });

    test('always offers a way out to YouTube at the same moment', () => {
        openVideoModal({ videoId: ID, start: 90 });
        const link = modal().querySelector('.video-modal__yt');
        expect(link.href).toBe(`https://www.youtube.com/watch?v=${ID}&t=90s`);
        expect(link.rel).toContain('noopener');
        expect(link.target).toBe('_blank');
    });

    test('refuses an id that is not a YouTube id: nothing opens, nothing is built', () => {
        expect(openVideoModal({ videoId: 'javascript:alert(1)' })).toBe(false);
        expect(openVideoModal({})).toBe(false);
        expect(modal()).toBeNull();
    });

    test('a label is shown as text, never as markup', () => {
        openVideoModal({ videoId: ID, label: '<img src=x onerror=alert(1)>' });
        expect(modal().querySelector('img')).toBeNull();
        expect(modal().querySelector('.video-modal__title').textContent).toContain('<img');
    });

    test('opening another moment replaces the player (it restarts at the new second)', () => {
        openVideoModal({ videoId: ID, start: 10 });
        openVideoModal({ videoId: ID, start: 200 });
        expect(document.querySelectorAll('.video-modal')).toHaveLength(1);
        expect(document.querySelectorAll('.video-modal iframe')).toHaveLength(1);
        expect(iframe().src).toContain('start=200');
    });

    test('the player may be told to play and go full screen, and sends a referrer (YouTube needs one)', () => {
        openVideoModal({ videoId: ID });
        expect(iframe().allow).toContain('autoplay');
        expect(iframe().allow).toContain('fullscreen');
        expect(iframe().referrerPolicy).toBe('strict-origin-when-cross-origin');
    });
});

describe('closing', () => {
    test('the close button removes the player (so the sound stops) and releases the page', () => {
        openVideoModal({ videoId: ID });
        modal().querySelector('.video-modal__close').click();
        expect(isVideoModalOpen()).toBe(false);
        expect(iframe()).toBeNull();
        expect(document.body.classList.contains('video-modal-open')).toBe(false);
    });

    test('Escape closes it and does not reach other Escape listeners (the assistant drawer stays open)', () => {
        const other = jest.fn();
        document.addEventListener('keydown', other);
        openVideoModal({ videoId: ID });
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        expect(isVideoModalOpen()).toBe(false);
        expect(other).not.toHaveBeenCalled();
        document.removeEventListener('keydown', other);
    });

    test('Escape does nothing once it is closed', () => {
        const other = jest.fn();
        document.addEventListener('keydown', other);
        openVideoModal({ videoId: ID });
        closeVideoModal();
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        expect(other).toHaveBeenCalledTimes(1);   // reaches the page again
        document.removeEventListener('keydown', other);
    });

    test('a click on the dark backdrop closes it; a click inside the box does not', () => {
        openVideoModal({ videoId: ID });
        modal().querySelector('.video-modal__box').click();
        expect(isVideoModalOpen()).toBe(true);
        modal().click();
        expect(isVideoModalOpen()).toBe(false);
    });

    test('focus goes back to what had it before', () => {
        document.body.innerHTML = '<button id="b">x</button>';
        const b = document.getElementById('b');
        b.focus();
        openVideoModal({ videoId: ID });
        expect(document.activeElement).toBe(modal().querySelector('.video-modal__close'));
        closeVideoModal();
        expect(document.activeElement).toBe(b);
    });

    test('opening a second moment while open does not lose where focus should return to', () => {
        document.body.innerHTML = '<button id="b">x</button>';
        const b = document.getElementById('b');
        b.focus();
        openVideoModal({ videoId: ID, start: 1 });
        openVideoModal({ videoId: ID, start: 2 });
        closeVideoModal();
        expect(document.activeElement).toBe(b);
    });

    test('Tab wraps inside the dialog', () => {
        openVideoModal({ videoId: ID });
        const close = modal().querySelector('.video-modal__close');
        close.focus();                                   // the last stop
        const e = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
        document.dispatchEvent(e);
        expect(e.defaultPrevented).toBe(true);
        expect(document.activeElement).toBe(modal().querySelector('.video-modal__yt'));
    });
});

describe('installVideoModal: thumbnails', () => {
    function card(href) {
        document.body.innerHTML = `<div class="media-wrap"><div class="video-card"><a href="${href}" target="_blank"><img alt="Watch Video"></a></div></div>`;
        return document.querySelector('.video-card a');
    }
    function click(el, init = {}) {
        const e = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ...init });
        el.dispatchEvent(e);
        return e;
    }

    beforeEach(() => { installVideoModal(); });

    test('a plain click on a thumbnail plays the video here instead of opening a tab', () => {
        const a = card(`https://www.youtube.com/watch?v=${ID}`);
        const e = click(a.querySelector('img'));
        expect(e.defaultPrevented).toBe(true);
        expect(isVideoModalOpen()).toBe(true);
        expect(iframe().src).toContain(`/embed/${ID}`);
    });

    test('a start time already written in the link is honoured', () => {
        const a = card(`https://youtu.be/${ID}?t=1m30s`);
        click(a);
        expect(iframe().src).toContain('start=90');
    });

    test.each([['ctrlKey'], ['metaKey'], ['shiftKey'], ['altKey']])('%s-click is left to the browser', key => {
        const a = card(`https://www.youtube.com/watch?v=${ID}`);
        const e = click(a, { [key]: true });
        expect(e.defaultPrevented).toBe(false);
        expect(isVideoModalOpen()).toBe(false);
    });

    test('a middle click is left to the browser', () => {
        const a = card(`https://www.youtube.com/watch?v=${ID}`);
        const e = click(a, { button: 1 });
        expect(e.defaultPrevented).toBe(false);
        expect(isVideoModalOpen()).toBe(false);
    });

    test('a link that is not a YouTube video still just opens', () => {
        const a = card('https://example.com/not-a-video');
        const e = click(a);
        expect(e.defaultPrevented).toBe(false);
        expect(isVideoModalOpen()).toBe(false);
    });

    test('other links are untouched, and installing twice does not open it twice', () => {
        installVideoModal();
        document.body.innerHTML = '<a id="x" href="https://example.com">x</a>';
        const e = click(document.getElementById('x'));
        expect(e.defaultPrevented).toBe(false);
        expect(isVideoModalOpen()).toBe(false);
    });
});
