// lib/book.js — the book's numbering, for the content-agent scripts (plain CommonJS, no DOM).
//
// This repeats the label rules of src/core/blocks.js (itemNumber / computeLabel) so the scripts can say "A-11.2"
// without loading an ES module; scripts/lib/book.test.js checks that both give the same label for every block in
// the real data.json, so the two cannot drift apart unnoticed.

const BLOCK_LETTERS = { shloka: 'S', note: 'N', images: 'I', mantra: 'M' };

const byId = (data) => Object.fromEntries(data.map((item) => [item.id, item]));

/** The number shown for an item: its own `num`, or (an answer) the number of the first question it references. */
function itemNumber(item, itemById) {
    if (Number.isInteger(item.num)) return item.num;
    if (item.type === 'answer') {
        for (const ref of item.references || []) {
            const target = itemById[ref];
            if (target && target.type === 'question' && Number.isInteger(target.num)) return target.num;
        }
    }
    return undefined;
}

/** "A-3.1", "S-3.2" ... or "?" while the item or block has no number yet. */
function blockLabel(item, block, itemById) {
    const number = itemNumber(item, itemById);
    if (number === undefined || !Number.isInteger(block.num)) return '?';
    const letter = BLOCK_LETTERS[block.type] || (item.type ? item.type[0] : 'x');
    return `${letter.toUpperCase()}-${number}.${block.num}`;
}

/** Every block of the book with its label: [{ item, block, label, position }] */
function allBlocks(data) {
    const itemById = byId(data);
    const out = [];
    data.forEach((item, position) => {
        for (const block of item.blocks || []) out.push({ item, block, position, label: blockLabel(item, block, itemById) });
    });
    return out;
}

/** The highest `num` in the book (items). The next appended item takes max + 1. */
function maxNum(data) {
    return data.reduce((m, item) => (Number.isInteger(item.num) && item.num > m ? item.num : m), 0);
}

/**
 * Parse what you type for a place in the book: an item or block id ("z5xxer"), a block label ("A-11.2", "S-3.1"),
 * an item label ("A-11", "Q-11") or a bare number ("11").
 * @returns {{ kind:'id'|'block'|'item'|'number', id?:string, letter?:string, num?:number, sub?:number }|null}
 */
function parsePlace(text) {
    const s = String(text || '').trim();
    if (!s) return null;
    let m = s.match(/^([A-Za-z])-(\d+)\.(\d+)$/);
    if (m) return { kind: 'block', letter: m[1].toUpperCase(), num: +m[2], sub: +m[3] };
    m = s.match(/^([A-Za-z])-(\d+)$/);
    if (m) return { kind: 'item', letter: m[1].toUpperCase(), num: +m[2] };
    m = s.match(/^\d+$/);
    if (m) return { kind: 'number', num: +s };
    return { kind: 'id', id: s };
}

/** The block a block label ("A-11.2") or block id points at, or null. */
function findBlock(data, text) {
    const place = parsePlace(text);
    if (!place) return null;
    const blocks = allBlocks(data);
    if (place.kind === 'id') return blocks.find((b) => b.block.id === place.id) || null;
    if (place.kind === 'block') return blocks.find((b) => b.label.toUpperCase() === `${place.letter}-${place.num}.${place.sub}`) || null;
    return null;
}

/**
 * Where to insert new items: the index in `data` they should be spliced in at.
 *  - nothing, "end": at the end;
 *  - an id (item or block) or a block label: right after that item;
 *  - "A-11" / "Q-11": right after the last item of that kind with that number; "11": after the last item with that number.
 * Throws a readable error when the place does not exist.
 */
function insertIndex(data, spec) {
    const s = String(spec || '').trim();
    if (!s || s.toLowerCase() === 'end') return data.length;
    const place = parsePlace(s);
    const itemById = byId(data);
    if (place.kind === 'id') {
        const i = data.findIndex((it) => it.id === place.id || (it.blocks || []).some((b) => b.id === place.id));
        if (i < 0) throw new Error(`cannot find "${s}" in data.json (use an id, a label like A-11 or A-11.2, a number, or end)`);
        return i + 1;
    }
    if (place.kind === 'block') {
        const hit = findBlock(data, s);
        if (!hit) throw new Error(`cannot find block ${s} in data.json`);
        return hit.position + 1;
    }
    let last = -1;
    data.forEach((item, i) => {
        if (itemNumber(item, itemById) !== place.num) return;
        if (place.kind === 'item' && (item.type || '')[0].toUpperCase() !== place.letter) return;
        last = i;
    });
    if (last < 0) throw new Error(`cannot find ${s} in data.json`);
    return last + 1;
}

/** The first line of text of a block, English preferred, for short reports. */
function snippet(block, max = 80) {
    for (const lang of ['en', 'kn']) {
        const line = ((block.content || {})[lang] || []).find((l) => String(l).trim() !== '');
        if (line) {
            const t = String(line).trim().replace(/\s+/g, ' ');
            return t.length > max ? t.slice(0, max - 1) + '…' : t;
        }
    }
    return '(no text)';
}

module.exports = { itemNumber, blockLabel, allBlocks, maxNum, parsePlace, findBlock, insertIndex, snippet, byId };
