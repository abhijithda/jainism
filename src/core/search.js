// core/search.js — Finds the blocks of the book that contain some text. Pure: data in, matches out.
// The header's search box uses it to list matches as you type (the views still filter / jump as before).

import { buildBlockIndex, formatIdForDisplay } from './blocks.js';
import { LANG_CODES } from './langs.js';

/** The shortest search that lists matches (one letter would match almost everything). */
export const MIN_QUERY_LENGTH = 2;

/**
 * A short piece of `line` around the match, split so the page can highlight the hit.
 * @returns {{before: string, hit: string, after: string}}
 */
export function excerptAround(line, index, length, before = 24, after = 48) {
    const start = Math.max(0, index - before);
    const end = Math.min(line.length, index + length + after);
    return {
        before: (start > 0 ? '…' : '') + line.slice(start, index),
        hit: line.slice(index, index + length),
        after: line.slice(index + length, end) + (end < line.length ? '…' : ''),
    };
}

/**
 * Blocks whose text contains `query` (case-insensitive), in book order.
 * The languages the reader has on are looked at first, so the excerpt is in a language they can read.
 * @param {Array} data      the book (data.json)
 * @param {string} query
 * @param {string[]} langs  the reader's active language codes
 * @param {number} limit    how many to return (the total is always counted)
 * @returns {{total: number, results: Array<{blockId: string, label: string, before: string, hit: string, after: string}>}}
 */
export function searchBlocks(data, query, langs = [], limit = 5) {
    const q = (query || '').trim().toLowerCase();
    if ([...q].length < MIN_QUERY_LENGTH || !Array.isArray(data)) return { total: 0, results: [] };

    buildBlockIndex(data);   // computes the display labels (A-3.1 …)
    const order = [...langs, ...LANG_CODES.filter(c => !langs.includes(c))];
    const results = [];
    let total = 0;

    for (const item of data) {
        if (item.type === 'insert') continue;
        for (const block of item.blocks || []) {
            let found = null;
            for (const lang of order) {
                for (const line of (block.content && block.content[lang]) || []) {
                    const at = typeof line === 'string' ? line.toLowerCase().indexOf(q) : -1;
                    if (at >= 0) { found = { line, at }; break; }
                }
                if (found) break;
            }
            if (!found) continue;
            total += 1;
            if (results.length < limit) {
                results.push({ blockId: block.id, label: formatIdForDisplay(block), ...excerptAround(found.line, found.at, q.length) });
            }
        }
    }
    return { total, results };
}

// CommonJS shim for Jest
if (typeof module !== 'undefined' && module.exports) Object.assign(module.exports, { MIN_QUERY_LENGTH, excerptAround, searchBlocks });
