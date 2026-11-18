// core/qr.js — Draws QR codes in the browser, no network and no library.
//
// Used for the QR code that sits on each video thumbnail. The code is made from
// the video link already in data.json, so there are no image files to keep in
// step, it works offline and in the saved offline copy, and the printed PDFs get
// a crisp vector code instead of a small picture fetched from a third-party
// service at print time.
//
// Supports what a link needs: byte mode (UTF-8), error correction L/M/Q/H,
// versions 1-20 (see MAX_VERSION). The algorithm is the standard one from ISO/IEC 18004: pick the
// smallest version that fits, add Reed-Solomon error correction, interleave the
// blocks, draw the function patterns, then choose the mask with the lowest
// penalty. Verified by decoding the output with OpenCV for every version/level
// and for every link in data.json (see core/qr.test.js for the fixed cases).

const ECC_LEVELS = { L: 0, M: 1, Q: 2, H: 3 };
const ECC_FORMAT_BITS = [1, 0, 3, 2];     // L, M, Q, H as written into the format info

// Error-correction codewords per block, and number of blocks, per level and
// version (index 0 is unused). From the QR specification tables.
const ECC_CODEWORDS_PER_BLOCK = [
    [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
    [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
    [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
    [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
];
const NUM_ERROR_CORRECTION_BLOCKS = [
    [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
    [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
    [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
    [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
];

const MIN_VERSION = 1;
// Versions above 20 are not used and not verified (a link needs version 10 at the
// very most), so longer text is refused instead of risking a code that won't
// scan. 20 holds 858 characters at level L and 424 at level H.
const MAX_VERSION = 20;

// ── Small helpers ─────────────────────────────────────────────────────────

function utf8Bytes(text) {
    if (typeof TextEncoder !== 'undefined') return Array.from(new TextEncoder().encode(text));
    return Array.from(Buffer.from(text, 'utf8'));            // Node without TextEncoder
}

function appendBits(value, length, bits) {
    for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
}

function getBit(x, i) { return ((x >>> i) & 1) !== 0; }

// Number of data modules (bits) in a version, after the function patterns.
function numRawDataModules(ver) {
    let result = (16 * ver + 128) * ver + 64;
    if (ver >= 2) {
        const numAlign = Math.floor(ver / 7) + 2;
        result -= (25 * numAlign - 10) * numAlign - 55;
        if (ver >= 7) result -= 36;
    }
    return result;
}

function numDataCodewords(ver, ecl) {
    return Math.floor(numRawDataModules(ver) / 8)
        - ECC_CODEWORDS_PER_BLOCK[ecl][ver] * NUM_ERROR_CORRECTION_BLOCKS[ecl][ver];
}

// ── Reed-Solomon over GF(2^8) with the QR polynomial 0x11D ────────────────

function gfMultiply(x, y) {
    let z = 0;
    for (let i = 7; i >= 0; i--) {
        z = (z << 1) ^ ((z >>> 7) * 0x11d);
        z ^= ((y >>> i) & 1) * x;
    }
    return z;
}

function reedSolomonDivisor(degree) {
    const result = new Array(degree).fill(0);
    result[degree - 1] = 1;
    let root = 1;
    for (let i = 0; i < degree; i++) {
        for (let j = 0; j < result.length; j++) {
            result[j] = gfMultiply(result[j], root);
            if (j + 1 < result.length) result[j] ^= result[j + 1];
        }
        root = gfMultiply(root, 0x02);
    }
    return result;
}

function reedSolomonRemainder(data, divisor) {
    const result = divisor.map(() => 0);
    for (const b of data) {
        const factor = b ^ result.shift();
        result.push(0);
        divisor.forEach((coef, i) => { result[i] ^= gfMultiply(coef, factor); });
    }
    return result;
}

// ── The matrix ────────────────────────────────────────────────────────────

class Matrix {
    constructor(version) {
        this.version = version;
        this.size = version * 4 + 17;
        this.modules = Array.from({ length: this.size }, () => new Array(this.size).fill(false));
        this.isFunction = Array.from({ length: this.size }, () => new Array(this.size).fill(false));
    }

    setFunction(x, y, dark) {
        this.modules[y][x] = dark;
        this.isFunction[y][x] = true;
    }

    drawFunctionPatterns(eclIndex) {
        const size = this.size;
        for (let i = 0; i < size; i++) {                       // timing patterns
            this.setFunction(6, i, i % 2 === 0);
            this.setFunction(i, 6, i % 2 === 0);
        }
        this.drawFinder(3, 3);
        this.drawFinder(size - 4, 3);
        this.drawFinder(3, size - 4);
        const align = this.alignmentPatternPositions();
        const n = align.length;
        for (let i = 0; i < n; i++) {
            for (let j = 0; j < n; j++) {
                if (!((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0))) {
                    this.drawAlignment(align[i], align[j]);
                }
            }
        }
        this.drawFormatBits(eclIndex, 0);                      // reserve the area; redrawn with the real mask
        this.drawVersion();
    }

    drawFinder(cx, cy) {
        for (let dy = -4; dy <= 4; dy++) {
            for (let dx = -4; dx <= 4; dx++) {
                const dist = Math.max(Math.abs(dx), Math.abs(dy));
                const x = cx + dx, y = cy + dy;
                if (x >= 0 && x < this.size && y >= 0 && y < this.size) {
                    this.setFunction(x, y, dist !== 2 && dist !== 4);
                }
            }
        }
    }

    drawAlignment(cx, cy) {
        for (let dy = -2; dy <= 2; dy++) {
            for (let dx = -2; dx <= 2; dx++) {
                this.setFunction(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
            }
        }
    }

    alignmentPatternPositions() {
        if (this.version === 1) return [];
        const numAlign = Math.floor(this.version / 7) + 2;
        const step = this.version === 32 ? 26
            : Math.ceil((this.version * 4 + 4) / (numAlign * 2 - 2)) * 2;
        const result = [6];
        for (let pos = this.size - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
        return result;
    }

    drawFormatBits(eclIndex, mask) {
        const data = (ECC_FORMAT_BITS[eclIndex] << 3) | mask;
        let rem = data;
        for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
        const bits = ((data << 10) | rem) ^ 0x5412;
        for (let i = 0; i <= 5; i++) this.setFunction(8, i, getBit(bits, i));
        this.setFunction(8, 7, getBit(bits, 6));
        this.setFunction(8, 8, getBit(bits, 7));
        this.setFunction(7, 8, getBit(bits, 8));
        for (let i = 9; i < 15; i++) this.setFunction(14 - i, 8, getBit(bits, i));
        for (let i = 0; i < 8; i++) this.setFunction(this.size - 1 - i, 8, getBit(bits, i));
        for (let i = 8; i < 15; i++) this.setFunction(8, this.size - 15 + i, getBit(bits, i));
        this.setFunction(8, this.size - 8, true);              // the always-dark module
    }

    drawVersion() {
        if (this.version < 7) return;
        let rem = this.version;
        for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
        const bits = (this.version << 12) | rem;
        for (let i = 0; i < 18; i++) {
            const bit = getBit(bits, i);
            const a = this.size - 11 + (i % 3);
            const b = Math.floor(i / 3);
            this.setFunction(a, b, bit);
            this.setFunction(b, a, bit);
        }
    }

    drawCodewords(data) {
        let i = 0;
        for (let right = this.size - 1; right >= 1; right -= 2) {
            if (right === 6) right = 5;
            for (let vert = 0; vert < this.size; vert++) {
                for (let j = 0; j < 2; j++) {
                    const x = right - j;
                    const upward = ((right + 1) & 2) === 0;
                    const y = upward ? this.size - 1 - vert : vert;
                    if (!this.isFunction[y][x] && i < data.length * 8) {
                        this.modules[y][x] = getBit(data[i >>> 3], 7 - (i & 7));
                        i++;
                    }
                }
            }
        }
    }

    applyMask(mask) {
        for (let y = 0; y < this.size; y++) {
            for (let x = 0; x < this.size; x++) {
                let invert;
                switch (mask) {
                    case 0: invert = (x + y) % 2 === 0; break;
                    case 1: invert = y % 2 === 0; break;
                    case 2: invert = x % 3 === 0; break;
                    case 3: invert = (x + y) % 3 === 0; break;
                    case 4: invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
                    case 5: invert = (x * y) % 2 + (x * y) % 3 === 0; break;
                    case 6: invert = ((x * y) % 2 + (x * y) % 3) % 2 === 0; break;
                    default: invert = ((x + y) % 2 + (x * y) % 3) % 2 === 0; break;
                }
                if (!this.isFunction[y][x] && invert) this.modules[y][x] = !this.modules[y][x];
            }
        }
    }

    // How bad a mask looks to a scanner (long runs, 2x2 blocks, finder-like
    // patterns, imbalance). The lowest score wins.
    penaltyScore() {
        const size = this.size, m = this.modules;
        let result = 0;
        const finderPenalty = runHistory => {
            const n = runHistory[1];
            const core = n > 0 && runHistory[2] === n && runHistory[3] === n * 3 && runHistory[4] === n && runHistory[5] === n;
            return (core && runHistory[0] >= n * 4 && runHistory[6] >= n ? 1 : 0)
                 + (core && runHistory[6] >= n * 4 && runHistory[0] >= n ? 1 : 0);
        };
        const addHistory = (len, h) => { if (h[0] === 0) len += size; h.pop(); h.unshift(len); };
        const terminate = (color, len, h) => {
            if (color) { addHistory(len, h); len = 0; }
            len += size;
            addHistory(len, h);
            return finderPenalty(h);
        };
        for (let y = 0; y < size; y++) {
            let color = false, runLen = 0;
            const h = [0, 0, 0, 0, 0, 0, 0];
            for (let x = 0; x < size; x++) {
                if (m[y][x] === color) {
                    runLen++;
                    if (runLen === 5) result += 3; else if (runLen > 5) result++;
                } else {
                    addHistory(runLen, h);
                    if (!color) result += finderPenalty(h) * 40;
                    color = m[y][x];
                    runLen = 1;
                }
            }
            result += terminate(color, runLen, h) * 40;
        }
        for (let x = 0; x < size; x++) {
            let color = false, runLen = 0;
            const h = [0, 0, 0, 0, 0, 0, 0];
            for (let y = 0; y < size; y++) {
                if (m[y][x] === color) {
                    runLen++;
                    if (runLen === 5) result += 3; else if (runLen > 5) result++;
                } else {
                    addHistory(runLen, h);
                    if (!color) result += finderPenalty(h) * 40;
                    color = m[y][x];
                    runLen = 1;
                }
            }
            result += terminate(color, runLen, h) * 40;
        }
        for (let y = 0; y < size - 1; y++) {
            for (let x = 0; x < size - 1; x++) {
                const c = m[y][x];
                if (c === m[y][x + 1] && c === m[y + 1][x] && c === m[y + 1][x + 1]) result += 3;
            }
        }
        let dark = 0;
        for (const row of m) for (const c of row) if (c) dark++;
        const total = size * size;
        const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
        return result + k * 10;
    }
}

// ── Public API ────────────────────────────────────────────────────────────

// Returns { version, size, modules } where modules[y][x] is true for a dark module.
export function encodeQr(text, ecc = 'M') {
    const eclIndex = ECC_LEVELS[ecc];
    if (eclIndex === undefined) throw new Error(`Unknown error correction level: ${ecc}`);
    const bytes = utf8Bytes(String(text));

    // Smallest version that fits: 4 mode bits + character count + the bytes
    let version = MIN_VERSION, dataBits = 0;
    for (;; version++) {
        if (version > MAX_VERSION) throw new Error('Text is too long for a QR code (version 20 is the largest supported)');
        const countBits = version < 10 ? 8 : 16;
        dataBits = 4 + countBits + bytes.length * 8;
        if (dataBits <= numDataCodewords(version, eclIndex) * 8) break;
    }

    const bits = [];
    appendBits(0x4, 4, bits);                                  // byte mode
    appendBits(bytes.length, version < 10 ? 8 : 16, bits);
    for (const b of bytes) appendBits(b, 8, bits);
    const capacityBits = numDataCodewords(version, eclIndex) * 8;
    appendBits(0, Math.min(4, capacityBits - bits.length), bits);      // terminator
    appendBits(0, (8 - (bits.length % 8)) % 8, bits);                  // pad to a byte
    for (let pad = 0xec; bits.length < capacityBits; pad ^= 0xec ^ 0x11) appendBits(pad, 8, bits);
    const dataCodewords = [];
    for (let i = 0; i < bits.length; i += 8) {
        let v = 0;
        for (let j = 0; j < 8; j++) v = (v << 1) | bits[i + j];
        dataCodewords.push(v);
    }

    // Split into blocks, add error correction to each, interleave
    const numBlocks = NUM_ERROR_CORRECTION_BLOCKS[eclIndex][version];
    const blockEccLen = ECC_CODEWORDS_PER_BLOCK[eclIndex][version];
    const rawCodewords = Math.floor(numRawDataModules(version) / 8);
    const numShortBlocks = numBlocks - (rawCodewords % numBlocks);
    const shortBlockLen = Math.floor(rawCodewords / numBlocks);
    const blocks = [];
    const divisor = reedSolomonDivisor(blockEccLen);
    for (let i = 0, k = 0; i < numBlocks; i++) {
        const len = shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1);
        const dat = dataCodewords.slice(k, k + len);
        k += len;
        const ecc2 = reedSolomonRemainder(dat, divisor);
        if (i < numShortBlocks) dat.push(0);                   // placeholder so all blocks line up
        blocks.push(dat.concat(ecc2));
    }
    const interleaved = [];
    for (let i = 0; i < blocks[0].length; i++) {
        blocks.forEach((block, j) => {
            if (i !== shortBlockLen - blockEccLen || j >= numShortBlocks) interleaved.push(block[i]);
        });
    }

    // Draw, then try all 8 masks and keep the best
    const matrix = new Matrix(version);
    matrix.drawFunctionPatterns(eclIndex);
    matrix.drawCodewords(interleaved);
    let bestMask = 0, bestPenalty = Infinity;
    for (let mask = 0; mask < 8; mask++) {
        matrix.applyMask(mask);
        matrix.drawFormatBits(eclIndex, mask);
        const penalty = matrix.penaltyScore();
        if (penalty < bestPenalty) { bestPenalty = penalty; bestMask = mask; }
        matrix.applyMask(mask);                                // XOR again = undo
    }
    matrix.applyMask(bestMask);
    matrix.drawFormatBits(eclIndex, bestMask);
    return { version, size: matrix.size, modules: matrix.modules, mask: bestMask };
}

// A self-contained SVG: white background (the code sits on top of a video
// thumbnail, so it needs its own quiet zone to scan) and one path for the dark
// modules. `quiet` is the border in modules (the spec asks for 4, 2 still scans
// reliably and keeps the printed code bigger).
export function qrToSvg(text, { ecc = 'M', quiet = 2, dark = '#000', light = '#fff' } = {}) {
    const { size, modules } = encodeQr(text, ecc);
    const total = size + quiet * 2;
    const parts = [];
    for (let y = 0; y < size; y++) {
        let x = 0;
        while (x < size) {
            if (!modules[y][x]) { x++; continue; }
            let run = 1;
            while (x + run < size && modules[y][x + run]) run++;
            parts.push(`M${x + quiet} ${y + quiet}h${run}v1h-${run}z`);
            x += run;
        }
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges">`
        + `<rect width="${total}" height="${total}" fill="${light}"/>`
        + `<path d="${parts.join('')}" fill="${dark}"/></svg>`;
}

// For <img src="…">: no file, no request, works offline.
export function qrToDataUrl(text, options) {
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(qrToSvg(text, options));
}

// CommonJS shim for Jest
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { encodeQr, qrToSvg, qrToDataUrl };
}
