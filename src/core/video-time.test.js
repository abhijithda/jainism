const { isVideoId, parseClock, parseTimeParam, parseStartSeconds, formatTime, buildEmbedUrl, buildWatchUrl } = require('./video-time');

describe('parseClock', () => {
    test.each([
        [90, 90], ['90', 90], ['90s', 90], ['1m30s', 90], ['1h2m3s', 3723], ['2m', 120], ['1h', 3600],
        ['1:30', 90], ['12:34', 754], ['1:02:03', 3723], ['  1:30  ', 90], [0, 0], ['0', 0],
    ])('reads %p as %p seconds', (input, expected) => {
        expect(parseClock(input)).toBe(expected);
    });

    test.each([[''], ['abc'], ['1:2:3:4'], [-5], [NaN], [null], [undefined], [{}], ['m30s']])('%p is not a time', input => {
        expect(parseClock(input)).toBeNull();
    });

    test('a fractional number of seconds is cut to whole seconds', () => {
        expect(parseClock(12.9)).toBe(12);
    });

    test('parseTimeParam turns anything unreadable into the start', () => {
        expect(parseTimeParam('nonsense')).toBe(0);
        expect(parseTimeParam('1m5s')).toBe(65);
    });
});

describe('parseStartSeconds', () => {
    test.each([
        ['https://www.youtube.com/watch?v=bgldj0TMZB4', 0],
        ['https://www.youtube.com/watch?v=bgldj0TMZB4&t=95s', 95],
        ['https://youtu.be/3Z3uwIGj_VM?t=1m30s', 90],
        ['https://youtu.be/3Z3uwIGj_VM?feature=shared', 0],
        ['https://www.youtube.com/watch?v=bgldj0TMZB4&start=42', 42],
        ['https://www.youtube.com/watch?v=bgldj0TMZB4#t=7', 7],
        ['not a url', 0],
        ['', 0],
    ])('%s starts at %p', (url, expected) => {
        expect(parseStartSeconds(url)).toBe(expected);
    });
});

describe('formatTime', () => {
    test.each([[0, '0:00'], [5, '0:05'], [754, '12:34'], [3600, '1:00:00'], [3723, '1:02:03'], [-4, '0:00'], ['x', '0:00']])('%p -> %p', (s, out) => {
        expect(formatTime(s)).toBe(out);
    });
});

describe('addresses', () => {
    test('the embed address carries the start second and uses the privacy-enhanced host', () => {
        const url = buildEmbedUrl('bgldj0TMZB4', 754);
        expect(url).toMatch(/^https:\/\/www\.youtube-nocookie\.com\/embed\/bgldj0TMZB4\?/);
        expect(url).toContain('start=754');
        expect(url).toContain('autoplay=1');
    });

    test('an id that is not a YouTube id gives no address at all (nothing unchecked reaches an iframe)', () => {
        for (const bad of ['', 'short', 'has space!!', '../../etc/passwd', 'bgldj0TMZB4/../x', null, undefined, 12345678901]) {
            expect(isVideoId(bad)).toBe(false);
            expect(buildEmbedUrl(bad, 1)).toBeNull();
            expect(buildWatchUrl(bad, 1)).toBeNull();
        }
    });

    test('the watch address only adds a time when there is one', () => {
        expect(buildWatchUrl('bgldj0TMZB4', 0)).toBe('https://www.youtube.com/watch?v=bgldj0TMZB4');
        expect(buildWatchUrl('bgldj0TMZB4', 90)).toBe('https://www.youtube.com/watch?v=bgldj0TMZB4&t=90s');
    });

    test('a negative or odd start is treated as the beginning', () => {
        expect(buildEmbedUrl('bgldj0TMZB4', -3)).toContain('start=0');
        expect(buildEmbedUrl('bgldj0TMZB4', 'x')).toContain('start=0');
    });
});
