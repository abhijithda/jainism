/** @jest-environment node */
// The script uses Node's own fetch, which the default jsdom environment doesn't have.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const {
    collectVideoIds, jpegSize, isRealThumbnail, readUnavailable, writeUnavailable,
    missingThumbnails, run,
} = require('./fetch-thumbs');

// A JPEG with a valid header (so its size can be read) padded to `bytes`
function fakeJpeg(width, height, bytes) {
    const head = Buffer.from([
        0xff, 0xd8,
        0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
        0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 255, width >> 8, width & 255, 0x03,
        0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
    ]);
    return Buffer.concat([head, Buffer.alloc(Math.max(0, bytes - head.length - 2), 0x11), Buffer.from([0xff, 0xd9])]);
}

describe('collectVideoIds', () => {
    test('gathers every video id once, sorted, from all the data given', () => {
        const a = [{ blocks: [{ videos: [{ youtubeId: 'bbb' }, { youtubeId: 'aaa' }] }, { videos: [] }, {}] }, {}];
        const b = [{ blocks: [{ videos: [{ youtubeId: 'aaa' }, { youtubeId: 'ccc' }] }] }];
        expect(collectVideoIds([a, b])).toEqual(['aaa', 'bbb', 'ccc']);
    });

    test('ignores entries without an id, and data that is not a list', () => {
        expect(collectVideoIds([[{ blocks: [{ videos: [{}, { youtubeId: '' }, null] }] }], {}, null])).toEqual([]);
    });
});

describe('telling a real thumbnail from YouTube\'s stand-in', () => {
    test('reads the size of a JPEG', () => {
        expect(jpegSize(fakeJpeg(480, 360, 5000))).toEqual({ width: 480, height: 360 });
        expect(jpegSize(Buffer.from('not a jpeg at all'))).toBeNull();
        expect(jpegSize(null)).toBeNull();
    });

    test('a 480x360 picture of reasonable size is real', () => {
        expect(isRealThumbnail(fakeJpeg(480, 360, 30000))).toBe(true);
    });

    test('the small grey stand-in (120x90) is not', () => {
        expect(isRealThumbnail(fakeJpeg(120, 90, 5000))).toBe(false);
    });

    test('a tiny file, or something that is not a JPEG, is not', () => {
        expect(isRealThumbnail(fakeJpeg(480, 360, 1000))).toBe(false);
        expect(isRealThumbnail(Buffer.alloc(9000, 1))).toBe(false);
    });
});

describe('the list of unavailable videos', () => {
    let dir;
    beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thumbs-')); });
    afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

    test('round-trips, sorted', () => {
        const file = path.join(dir, 'u.json');
        writeUnavailable(file, new Set(['zzz', 'aaa']));
        expect([...readUnavailable(file)]).toEqual(['aaa', 'zzz']);
    });

    test('a missing or broken file means "none"', () => {
        expect(readUnavailable(path.join(dir, 'nope.json')).size).toBe(0);
        fs.writeFileSync(path.join(dir, 'bad.json'), '{ not json');
        expect(readUnavailable(path.join(dir, 'bad.json')).size).toBe(0);
    });

    test('videos listed as unavailable are not counted as missing', () => {
        fs.mkdirSync(path.join(dir, 'thumbs'));
        fs.writeFileSync(path.join(dir, 'thumbs', 'have.jpg'), 'x');
        expect(missingThumbnails(['have', 'gone', 'new'], path.join(dir, 'thumbs'), new Set(['gone']))).toEqual(['new']);
    });
});

describe('run (against a local stand-in for YouTube)', () => {
    let server, baseUrl, root;
    const requests = [];

    beforeAll(done => {
        server = http.createServer((req, res) => {
            const id = req.url.split('/')[1];
            requests.push(id);
            if (id === 'GONE0000000') { res.statusCode = 404; return res.end(); }
            if (id === 'BROKEN00000') { res.statusCode = 500; return res.end(); }
            const body = id === 'GREY0000000' ? fakeJpeg(120, 90, 5000) : fakeJpeg(480, 360, 30000);
            res.setHeader('Content-Type', 'image/jpeg');
            res.end(body);
        }).listen(0, '127.0.0.1', () => {
            baseUrl = `http://127.0.0.1:${server.address().port}`;
            done();
        });
    });
    afterAll(done => { server.close(done); });

    beforeEach(() => {
        requests.length = 0;
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'thumbs-run-'));
        fs.mkdirSync(path.join(root, 'test'));
        const video = id => ({ blocks: [{ videos: [{ youtubeId: id, url: `https://youtu.be/${id}` }] }] });
        fs.writeFileSync(path.join(root, 'data.json'), JSON.stringify([
            video('GOOD0000001'), video('GOOD0000002'), video('GONE0000000'), video('GREY0000000'), video('BROKEN00000'),
        ]));
        fs.writeFileSync(path.join(root, 'test', 'data.json'), JSON.stringify([video('FIXT0000001'), video('GOOD0000001')]));
    });
    afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

    const go = (args = []) => run({ rootDir: root, baseUrl, args, log: () => {} });
    const saved = () => fs.readdirSync(path.join(root, 'images', 'thumbs')).sort();

    test('saves real thumbnails (including the test fixture\'s), records deleted and grey ones, and reports a server error without recording it', async () => {
        const s = await go();
        expect(saved()).toEqual(['FIXT0000001.jpg', 'GOOD0000001.jpg', 'GOOD0000002.jpg']);
        expect(s.downloaded.sort()).toEqual(['FIXT0000001', 'GOOD0000001', 'GOOD0000002']);
        expect([...readUnavailable(path.join(root, 'thumbs-unavailable.json'))].sort()).toEqual(['GONE0000000', 'GREY0000000']);
        expect(s.failed).toEqual(['BROKEN00000']);                    // a server error says nothing about the video
        expect(fs.statSync(path.join(root, 'images', 'thumbs', 'GOOD0000001.jpg')).size).toBe(30000);
    });

    test('a second run downloads nothing it already has, and does not ask again about unavailable ones', async () => {
        await go();
        requests.length = 0;
        await go();
        expect(requests).toEqual(['BROKEN00000']);                    // only the one that failed is tried again
    });

    test('--retry-unavailable looks at the unavailable ones again', async () => {
        await go();
        requests.length = 0;
        await go(['--retry-unavailable']);
        expect(requests.sort()).toEqual(['BROKEN00000', 'GONE0000000', 'GREY0000000']);
    });

    test('--force downloads everything again', async () => {
        await go();
        requests.length = 0;
        await go(['--force']);
        expect(requests).toHaveLength(6);
    });

    test('--check makes no requests and lists what is missing', async () => {
        const before = await go(['--check']);
        expect(before.missing.sort()).toEqual(['BROKEN00000', 'FIXT0000001', 'GONE0000000', 'GOOD0000001', 'GOOD0000002', 'GREY0000000']);
        expect(requests).toHaveLength(0);
        await go();
        const after = await go(['--check']);
        expect(after.missing).toEqual(['BROKEN00000']);                // the unavailable ones are accepted
    });
});
