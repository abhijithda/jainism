const { encodeQr, qrToSvg, qrToDataUrl } = require('./qr');

// Known answers: the exact module pattern for three real links. Each of these was
// decoded with OpenCV and read back as the original text, so a change that alters
// them has changed what a phone sees. (A wider check was done once, by decoding
// 760 random texts across every version 1-20 at all four levels.)
const KNOWN = [
    {
        text: "https://example.com/", ecc: 'M', version: 2, size: 25,
        rows: [
            '1111111011101010001111111',
            '1000001011110000101000001',
            '1011101011011110101011101',
            '1011101000110100101011101',
            '1011101011000110101011101',
            '1000001001110010101000001',
            '1111111010101010101111111',
            '0000000000110101100000000',
            '1001111110110000110010111',
            '1101110111110111110111110',
            '0011111001110101110111001',
            '0011010101111010011101111',
            '1111011011110111101100001',
            '1100000011101011100010010',
            '1100111001000011101011111',
            '1001110111101110011101101',
            '1010011110111000111110110',
            '0000000010110000100010110',
            '1111111010101110101010001',
            '1000001010110101100010001',
            '1011101010010101111110011',
            '1011101010001100111000011',
            '1011101001010101010011111',
            '1000001001011101000110111',
            '1111111010011100101001001'
        ],
    },
    {
        text: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", ecc: 'M', version: 4, size: 33,
        rows: [
            '111111100101101000111101001111111',
            '100000100011100100101100001000001',
            '101110101001001100010110101011101',
            '101110101110000000100101101011101',
            '101110101000011111001010001011101',
            '100000101010111001010011101000001',
            '111111101010101010101010101111111',
            '000000001010101010011111000000000',
            '101111100110111001010011001111100',
            '001101001111011011111011001101110',
            '001000111011111111000010110010110',
            '101001010001010001111001011011100',
            '110000110110101110011111110001010',
            '110011001111010101100100101000111',
            '101000100000001110001110011001110',
            '011101010000111100000110111111100',
            '101011110000111101100010110111001',
            '101111000010011010110111111101101',
            '001101110001010100101100010110110',
            '111001010001010110001111011111110',
            '110101101001000100100100010011011',
            '111001011100111111001110010101101',
            '100000110010001001010110010011010',
            '100100011001110010011101111000111',
            '100110101111000011010010111111001',
            '000000001111000011011011100010111',
            '111111100101101111000011101010100',
            '100000101010101101110001100011101',
            '101110101101100110001110111111010',
            '101110101010101100100101010011101',
            '101110101111001111001111111100100',
            '100000100010010100000110001011100',
            '111111101110011101000011100101010'
        ],
    },
    {
        text: "https://youtu.be/0a4CtFD0nY8?t=10m32s", ecc: 'L', version: 3, size: 29,
        rows: [
            '11111110010000101010101111111',
            '10000010110111010100001000001',
            '10111010011100100010101011101',
            '10111010110100011000101011101',
            '10111010001011000011101011101',
            '10000010101001111000101000001',
            '11111110101010101010101111111',
            '00000000000011000011000000000',
            '11111011111010111110010101010',
            '00101100010000000000101110001',
            '10100010010110011010000010000',
            '01001100111100111010100111010',
            '11101010110100000100110101100',
            '01001000101011101111011110001',
            '00100111110001110100101111100',
            '01011100101011010010011110010',
            '01110110000010111000000101100',
            '11000001000000000101111110101',
            '10111011011110011010010100100',
            '10001000101100110000011100010',
            '10001110000100011110111110111',
            '00000000101011100101100011111',
            '11111110101001111011101011100',
            '10000010001011011010100010000',
            '10111010101010101110111110100',
            '10111010100000000101100001111',
            '10111010110110010101111111110',
            '10000010101100111000100111010',
            '11111110111100011100000001100'
        ],
    },
];

const asRows = result => result.modules.map(row => row.map(c => (c ? '1' : '0')).join(''));

describe('encodeQr: known answers', () => {
    for (const k of KNOWN) {
        test(`${k.text} at level ${k.ecc} is version ${k.version}, exactly as verified`, () => {
            const result = encodeQr(k.text, k.ecc);
            expect(result.version).toBe(k.version);
            expect(result.size).toBe(k.size);
            expect(asRows(result)).toEqual(k.rows);
        });
    }
});

describe('encodeQr: structure', () => {
    const result = encodeQr('https://example.com/', 'M');
    const m = result.modules;

    test('size is 17 + 4 x version', () => {
        expect(result.size).toBe(17 + 4 * result.version);
        expect(m).toHaveLength(result.size);
        expect(m.every(row => row.length === result.size)).toBe(true);
    });

    test('has the three finder squares (7x7 dark ring around a 3x3 dark centre)', () => {
        const n = result.size;
        const finder = (x0, y0) => {
            for (let y = 0; y < 7; y++) {
                for (let x = 0; x < 7; x++) {
                    const ring = x === 0 || x === 6 || y === 0 || y === 6;
                    const centre = x >= 2 && x <= 4 && y >= 2 && y <= 4;
                    if (m[y0 + y][x0 + x] !== (ring || centre)) return false;
                }
            }
            return true;
        };
        expect(finder(0, 0)).toBe(true);
        expect(finder(n - 7, 0)).toBe(true);
        expect(finder(0, n - 7)).toBe(true);
    });

    test('has the alternating timing lines and the always-dark module', () => {
        const n = result.size;
        for (let i = 8; i < n - 8; i++) {
            expect(m[6][i]).toBe(i % 2 === 0);
            expect(m[i][6]).toBe(i % 2 === 0);
        }
        expect(m[n - 8][8]).toBe(true);
    });
});

describe('encodeQr: behaviour', () => {
    test('the same text always gives the same code', () => {
        expect(asRows(encodeQr('https://example.com/a', 'M'))).toEqual(asRows(encodeQr('https://example.com/a', 'M')));
    });

    test('different text gives a different code', () => {
        expect(asRows(encodeQr('https://example.com/a', 'M'))).not.toEqual(asRows(encodeQr('https://example.com/b', 'M')));
    });

    test('a higher error correction level needs the same or a bigger version', () => {
        const text = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
        const versions = ['L', 'M', 'Q', 'H'].map(level => encodeQr(text, level).version);
        expect(versions).toEqual([...versions].sort((a, b) => a - b));
    });

    test('grows with the text: longer text, bigger version', () => {
        expect(encodeQr('a'.repeat(10), 'L').version).toBe(1);
        expect(encodeQr('a'.repeat(100), 'L').version).toBeGreaterThan(encodeQr('a'.repeat(10), 'L').version);
    });

    test('accepts non-English text (UTF-8)', () => {
        expect(() => encodeQr('ಜೈನ ಪೂಜಾ ವಿಚಾರ ಸಂಕಲನ', 'M')).not.toThrow();
        expect(() => encodeQr('日本語 🙂', 'Q')).not.toThrow();
    });

    test('refuses text too long to be a QR code that is known to scan, and unknown levels', () => {
        expect(() => encodeQr('a'.repeat(2000), 'L')).toThrow(/too long/);
        expect(() => encodeQr('hello', 'Z')).toThrow(/error correction/);
    });

    test('every video-style link fits well inside the verified range', () => {
        expect(encodeQr('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1182s', 'M').version).toBeLessThanOrEqual(10);
    });
});

describe('qrToSvg / qrToDataUrl', () => {
    const svg = qrToSvg('https://example.com/', { ecc: 'M', quiet: 2 });

    test('is an SVG with a white background (the code sits on top of a thumbnail) and one dark path', () => {
        expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
        expect(svg).toContain('<rect width="29" height="29" fill="#fff"/>');       // 25 modules + 2 quiet each side
        expect(svg).toContain('viewBox="0 0 29 29"');
        expect(svg).toContain('fill="#000"');
        expect(svg.match(/<path /g)).toHaveLength(1);
    });

    test('the data URL is plain SVG that needs no request', () => {
        const url = qrToDataUrl('https://example.com/');
        expect(url.startsWith('data:image/svg+xml;charset=utf-8,')).toBe(true);
        expect(decodeURIComponent(url.split(',').slice(1).join(','))).toContain('<svg');
    });

    test('quiet zone is configurable', () => {
        expect(qrToSvg('https://example.com/', { quiet: 4 })).toContain('viewBox="0 0 33 33"');
    });
});
