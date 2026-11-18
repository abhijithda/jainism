const {
    escapeHtml,
    linkify,
    splitLinks,
    appendLinkedText,
    extractYouTubeId,
    buildQrUrl,
    buildYouTubeThumbnailUrl,
    buildLocalThumbnailUrl,
    handleThumbnailError,
    installThumbnailFallback,
    createVideoCard,
    publishImageSize,
    installImageSizeTracking,
} = require('./media');

describe('escapeHtml', () => {
    test('escapes the five HTML special characters', () => {
        expect(escapeHtml(`<a href="x">Tom & Jerry's</a>`))
            .toBe('&lt;a href=&quot;x&quot;&gt;Tom &amp; Jerry&#039;s&lt;/a&gt;');
    });

    test('returns an empty string for falsy input', () => {
        expect(escapeHtml('')).toBe('');
        expect(escapeHtml(null)).toBe('');
        expect(escapeHtml(undefined)).toBe('');
    });
});

describe('linkify', () => {
    test('wraps a bare URL in a target=_blank link', () => {
        const out = linkify('See https://example.com/page for more');
        expect(out).toBe(
            'See <a href="https://example.com/page" target="_blank" rel="noopener noreferrer">https://example.com/page</a> for more'
        );
    });

    test('leaves text with no URL unchanged', () => {
        expect(linkify('no links here')).toBe('no links here');
    });
});

describe('splitLinks', () => {
    test('splits text around an address and loses nothing', () => {
        expect(splitLinks('See https://example.com/page for more')).toEqual([
            { text: 'See ' }, { link: 'https://example.com/page' }, { text: ' for more' },
        ]);
    });

    test('does not swallow the punctuation that ends a sentence or a bracket', () => {
        expect(splitLinks('(see https://example.com/a.)')).toEqual([
            { text: '(see ' }, { link: 'https://example.com/a' }, { text: '.)' },
        ]);
        expect(splitLinks('go to https://example.com/a, then b')[1]).toEqual({ link: 'https://example.com/a' });
    });

    test('keeps a closing bracket that belongs to the address', () => {
        expect(splitLinks('https://en.wikipedia.org/wiki/Foo_(bar)')).toEqual([{ link: 'https://en.wikipedia.org/wiki/Foo_(bar)' }]);
    });

    test('a Kannada letter right after the address ends the link', () => {
        expect(splitLinks('https://forms.gle/abc123ನಲ್ಲಿ ಹಂಚಿಕೊಳ್ಳಿ')).toEqual([
            { link: 'https://forms.gle/abc123' }, { text: 'ನಲ್ಲಿ ಹಂಚಿಕೊಳ್ಳಿ' },
        ]);
    });

    test('keeps query strings, and finds several addresses', () => {
        const parts = splitLinks('a https://youtu.be/x?si=1&t=2 b https://forms.gle/q c');
        expect(parts.filter(p => p.link).map(p => p.link)).toEqual(['https://youtu.be/x?si=1&t=2', 'https://forms.gle/q']);
    });

    test('text with no address comes back as one piece, and empty input as none', () => {
        expect(splitLinks('no links here')).toEqual([{ text: 'no links here' }]);
        expect(splitLinks('')).toEqual([]);
        expect(splitLinks(null)).toEqual([]);
    });

    test('a bare "https://" is not a link', () => {
        expect(splitLinks('see https:// later').some(p => p.link)).toBe(false);
    });
});

describe('appendLinkedText', () => {
    test('adds a real link that opens in a new tab, and plain text around it', () => {
        const p = document.createElement('p');
        appendLinkedText(p, 'Share it at https://forms.gle/abc123 please.');
        const a = p.querySelector('a');
        expect(a.getAttribute('href')).toBe('https://forms.gle/abc123');
        expect(a.textContent).toBe('https://forms.gle/abc123');
        expect(a.target).toBe('_blank');
        expect(a.rel).toBe('noopener noreferrer');
        expect(a.className).toBe('text-link');
        expect(p.textContent).toBe('Share it at https://forms.gle/abc123 please.');
    });

    test('text can never turn into markup', () => {
        const p = document.createElement('p');
        appendLinkedText(p, '<img src=x onerror=alert(1)> & <b>bold</b> https://example.com/a');
        expect(p.querySelector('img')).toBeNull();
        expect(p.querySelector('b')).toBeNull();
        expect(p.textContent).toContain('<img src=x onerror=alert(1)> & <b>bold</b>');
        expect(p.querySelectorAll('a')).toHaveLength(1);
    });

    test('keeps line breaks in the text', () => {
        const p = document.createElement('p');
        appendLinkedText(p, 'one\ntwo https://example.com/a');
        expect(p.textContent).toBe('one\ntwo https://example.com/a');
    });

    test('clicking the link does not also click the card around it', () => {
        const card = document.createElement('div');
        const p = document.createElement('p');
        card.appendChild(p);
        document.body.appendChild(card);
        const outer = jest.fn();
        card.addEventListener('click', outer);
        appendLinkedText(p, 'https://example.com/a');
        p.querySelector('a').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        expect(outer).not.toHaveBeenCalled();
        card.remove();
    });
});

describe('extractYouTubeId', () => {
    test.each([
        ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
        ['https://youtu.be/dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
        ['https://www.youtube.com/embed/dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
        ['https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s', 'dQw4w9WgXcQ'],
    ])('extracts the 11-char id from %s', (url, expected) => {
        expect(extractYouTubeId(url)).toBe(expected);
    });

    test('returns null for a non-YouTube URL', () => {
        expect(extractYouTubeId('https://example.com/video')).toBeNull();
    });

    test('returns null for falsy input', () => {
        expect(extractYouTubeId(null)).toBeNull();
        expect(extractYouTubeId('')).toBeNull();
    });
});

describe('buildQrUrl / thumbnail urls', () => {
    test('draws the QR code itself: an SVG data URL, no request to any service', () => {
        const url = buildQrUrl('https://example.com/a?b=c');
        expect(url.startsWith('data:image/svg+xml')).toBe(true);
        expect(url).not.toContain('qrserver');
        expect(decodeURIComponent(url)).toContain('<svg');
    });

    test('the same link gives the same code, and different links differ', () => {
        expect(buildQrUrl('https://example.com/a')).toBe(buildQrUrl('https://example.com/a'));
        expect(buildQrUrl('https://example.com/a')).not.toBe(buildQrUrl('https://example.com/b'));
    });

    test('the local thumbnail is assets/images/thumbs/<id>.jpg', () => {
        expect(buildLocalThumbnailUrl('dQw4w9WgXcQ')).toBe('assets/images/thumbs/dQw4w9WgXcQ.jpg');
    });

    test('builds the standard YouTube thumbnail url from a video id', () => {
        expect(buildYouTubeThumbnailUrl('dQw4w9WgXcQ'))
            .toBe('https://img.youtube.com/vi/dQw4w9WgXcQ/0.jpg');
    });
});

describe('createVideoCard', () => {
    const watch = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';

    test('renders a media-wrap with a video thumbnail and a QR overlay for a valid YouTube URL', () => {
        const html = createVideoCard(watch);
        expect(html).toContain('class="media-wrap"');
        expect(html).toContain('class="video-card"');
        expect(html).toContain('class="qr-code"');
    });

    test('the thumbnail is the local copy first, with YouTube as the fallback', () => {
        const html = createVideoCard(watch);
        expect(html).toContain('src="assets/images/thumbs/dQw4w9WgXcQ.jpg"');
        expect(html).toContain('data-fallback-src="https://img.youtube.com/vi/dQw4w9WgXcQ/0.jpg"');
    });

    test('the QR code is drawn locally — both views share this one card', () => {
        const html = createVideoCard(watch);
        expect(html).toContain('<img src="data:image/svg+xml');
        expect(html).not.toContain('qrserver');
    });

    test('the thumbnail is wrapped in a link to the video, opened in a new tab (the play badge hangs off this anchor)', () => {
        const html = createVideoCard(watch);
        expect(html).toMatch(/<a href="https:\/\/www\.youtube\.com\/watch\?v=dQw4w9WgXcQ" target="_blank">\s*<img src="assets\/images\/thumbs\//);
    });

    test('returns an empty string for a non-YouTube URL', () => {
        expect(createVideoCard('https://example.com/not-youtube')).toBe('');
    });
});

describe('thumbnail fallback (local file -> YouTube -> plain tile)', () => {
    function cardInDom() {
        document.body.innerHTML = '<div id="host"></div>';
        document.getElementById('host').innerHTML = createVideoCard('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
        return document.querySelector('.video-card img');
    }

    test('first failure: switches to the YouTube address, once', () => {
        const img = cardInDom();
        handleThumbnailError(img);
        expect(img.getAttribute('src')).toBe('https://img.youtube.com/vi/dQw4w9WgXcQ/0.jpg');
        expect(img.hasAttribute('data-fallback-src')).toBe(false);
        expect(document.querySelector('.video-card').classList.contains('thumb-failed')).toBe(false);
    });

    test('second failure: the card becomes the plain "thumb-failed" tile', () => {
        const img = cardInDom();
        handleThumbnailError(img);
        handleThumbnailError(img);
        expect(document.querySelector('.video-card').classList.contains('thumb-failed')).toBe(true);
    });

    test('images that are not video thumbnails are left alone', () => {
        document.body.innerHTML = '<img id="photo" src="assets/images/x.jpg" data-fallback-src="y.jpg">';
        const photo = document.getElementById('photo');
        handleThumbnailError(photo);
        expect(photo.getAttribute('src')).toBe('assets/images/x.jpg');
    });

    test('installThumbnailFallback listens for failed loads anywhere in the document', () => {
        document.body.innerHTML = '';
        const doc = document.implementation.createHTMLDocument('t');
        installThumbnailFallback(doc);
        doc.body.innerHTML = createVideoCard('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
        const img = doc.querySelector('.video-card img');
        img.dispatchEvent(new Event('error'));
        expect(img.getAttribute('src')).toContain('img.youtube.com');
    });
});

describe('publishImageSize', () => {
    function fakeImg(w, h) {
        const img = document.createElement('img');
        Object.defineProperty(img, 'naturalWidth', { value: w });
        Object.defineProperty(img, 'naturalHeight', { value: h });
        return img;
    }

    test('publishes the natural aspect ratio and pixel width as CSS custom properties', () => {
        const img = fakeImg(1249, 2048);
        publishImageSize(img);
        expect(img.style.getPropertyValue('--ar')).toBe((1249 / 2048).toFixed(4));
        expect(img.style.getPropertyValue('--nw')).toBe('1249');
    });

    test('does nothing until the image has real dimensions (not loaded / broken)', () => {
        const img = fakeImg(0, 0);
        publishImageSize(img);
        expect(img.style.getPropertyValue('--ar')).toBe('');
        expect(img.style.getPropertyValue('--nw')).toBe('');
        expect(() => publishImageSize(null)).not.toThrow();
    });

    test('a capture-phase load listener covers images created later, including from innerHTML', () => {
        document.body.innerHTML = '';
        installImageSizeTracking(document);
        const holder = document.createElement('div');
        holder.innerHTML = '<img src="x.jpg">';
        document.body.appendChild(holder);
        const img = holder.querySelector('img');
        Object.defineProperty(img, 'naturalWidth', { value: 800 });
        Object.defineProperty(img, 'naturalHeight', { value: 400 });
        img.dispatchEvent(new Event('load'));   // load doesn't bubble: only a capture listener sees it
        expect(img.style.getPropertyValue('--ar')).toBe('2.0000');
        expect(img.style.getPropertyValue('--nw')).toBe('800');
    });
});
