#!/usr/bin/env node
// content-agent.js — the Automated Content Pipeline Agent (backend).
//
// You draft a new Q&A item (or a new block) straight in assets/data.json, WITHOUT an "id", and push the
// branch to staging/<anything>. The workflow .github/workflows/content-agent.yml runs this script, which:
//
//   1. gives every id-less item and block a permanent opaque id (the same rule as new-id.js --fill),
//   2. links a new answer to what it answers: the question right above it, or, when it sits right below another
//      answer as a follow-up/update to that answer, the blocks of that answer it relates to most (as in the
//      existing follow-up answers, which reference blocks of the answer they extend); and stamps each brand-new
//      item with a "timestamp" if you left it out (the "when was this added" record),
//   3. finds the existing content each new item is most related to, using the book's own search
//      (src/ai/retrieval.js: BM25 + tags + spelling folding, so no API key and the same result every time),
//   4. appends those blocks to the item's "references" (the app draws them as "Ref: A-3.1" strips),
//   5. writes a review report (the Pull Request description) that also lists what the agent could NOT decide
//      (a missing "num"), because the numbers are yours to choose when you reorder.
//
//   node scripts/content-agent.js                    process assets/data.json in place
//   node scripts/content-agent.js --dry-run          print the report, write nothing
//   node scripts/content-agent.js --report out.md    also write the report to out.md
//   node scripts/content-agent.js --max-refs 3       at most 3 cross-references per new item (default 2)
//   node scripts/content-agent.js --follow-up-blocks 2   a follow-up answer references at most 2 blocks of the answer above (default 3)
//   node scripts/content-agent.js --min-score 15     only add a cross-reference whose match score is at least 15 (default 10)
//
// Rules the agent never breaks: it only ADDS to data.json (existing ids, nums, references and text are
// untouched); it only references items that come EARLIER in the file (a "Ref:" strip points back, as the
// app expects); it never references an insert (photo/blank/title page); if nothing is new it changes nothing,
// so running it twice is harmless.
//
// The matching logic is a pure function (processDraft) that takes the retrieval module as an argument, so the
// unit tests can call it directly (retrieval.js is an ES module for the browser; the CLI loads it with import()).
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { fillMissingIds, hasId } = require('./new-id');

const ROOT = path.join(__dirname, '..');
const DATA_PATH = path.join(ROOT, 'assets', 'data.json');

const DEFAULTS = {
    maxRefs: 2,        // cross-references added per new item
    minScore: 10,      // absolute floor on the BM25 score of a match (calibration: docs/CONTENT-AGENT.md)
    relativeCut: 0.6,  // a match must also score at least this fraction of the best match
    pool: 60,          // how many ranked blocks to look through
    followUpBlocks: 3, // blocks of the answer above that a follow-up answer references (the existing one references 3)
};

/** Every id in the data, before the agent touches anything: those items/blocks are "existing". */
function isNewItem(item) { return !hasId(item); }

/** The text the agent matches on: all lines of all blocks (every language) plus the blocks' tags. */
function queryFor(item) {
    const parts = [];
    for (const block of item.blocks || []) {
        for (const lines of Object.values(block.content || {})) {
            if (Array.isArray(lines)) parts.push(...lines);
        }
        parts.push(...(block.tags || []));
    }
    return parts.join(' \n ');
}

/** A short one-line label for reports: the first non-blank line of the first block, English preferred. */
function snippetOf(item, max = 70) {
    for (const block of item.blocks || []) {
        for (const lang of ['en', 'kn']) {
            const line = (block.content?.[lang] || []).find((l) => String(l).trim() !== '');
            if (line) {
                const text = String(line).trim().replace(/\s+/g, ' ');
                return text.length > max ? text.slice(0, max - 1) + '…' : text;
            }
        }
        const caption = block.images?.[0]?.caption;
        if (caption?.en || caption?.kn) return String(caption.en || caption.kn).slice(0, max);
    }
    return '(no text)';
}

/** Put `references` right before `blocks` when the item has none yet; otherwise keep its position. */
function withReferences(item, references) {
    if (Object.prototype.hasOwnProperty.call(item, 'references')) return { ...item, references };
    const out = {};
    for (const [key, value] of Object.entries(item)) {
        if (key === 'blocks') out.references = references;
        out[key] = value;
    }
    if (!('references' in out)) out.references = references;
    return out;
}

/** Put `timestamp` after `type` (the order used in the rest of the file). */
function withTimestamp(item, timestamp) {
    const out = {};
    let placed = false;
    for (const [key, value] of Object.entries(item)) {
        out[key] = value;
        if (key === 'type' && !placed) { out.timestamp = timestamp; placed = true; }
    }
    if (!placed) out.timestamp = timestamp;
    return out;
}

/**
 * The blocks of `parent` (the answer right above a new follow-up answer) that the follow-up relates to most:
 * the best-matching ones, in the order they appear in the parent. A follow-up is anchored to its parent by
 * structure, not by a relevance guess, so there is no score floor; if nothing matches, the parent's first block.
 */
function findFollowUpBlocks(index, retrieval, item, parent, opts) {
    const own = new Set((parent.blocks || []).map((b) => b.id));
    const order = Object.fromEntries((parent.blocks || []).map((b, i) => [b.id, i]));
    const query = queryFor(item);
    const hits = query.trim()
        ? retrieval.search(index, query, { k: index.chunks.length, textOnly: true }).filter((h) => own.has(h.chunk.id))
        : [];
    let picked = [];
    if (hits.length) {
        const top = hits[0].score;
        picked = hits
            .filter((h) => h.score >= top * opts.relativeCut)
            .slice(0, Math.max(1, opts.followUpBlocks))
            .map((h) => ({ blockId: h.chunk.id, label: h.chunk.label, score: Math.round(h.score * 10) / 10 }));
    } else if ((parent.blocks || []).length) {
        const first = parent.blocks[0];
        const chunk = index.chunks.find((c) => c.id === first.id);
        picked = [{ blockId: first.id, label: chunk ? chunk.label : '?', score: 0 }];
    }
    return picked.sort((a, b) => order[a.blockId] - order[b.blockId]);
}

/**
 * The cross-references for one new item.
 * @param {Object} index   retrieval.createIndex(data) over the data that already has its ids
 * @param {Object} retrieval  the retrieval module ({ search })
 * @param {Object} item    the new item (already has its id)
 * @param {number} position  its position in the data array: only earlier items are candidates
 * @param {Object} positionOf  item id -> position
 * @returns {{blockId:string, itemId:string, label:string, score:number, snippet:string}[]}
 */
function findRelated(index, retrieval, item, position, positionOf, opts) {
    const query = queryFor(item);
    if (!query.trim()) return [];
    const alreadyLinked = new Set();
    for (const ref of item.references || []) {
        alreadyLinked.add(ref);
        const blk = index.blockById[ref];
        if (blk) {
            // a reference to a block also counts as linking its item
            for (const it of index.data) if ((it.blocks || []).includes(blk)) alreadyLinked.add(it.id);
        }
    }

    const hits = retrieval.search(index, query, { k: opts.pool, textOnly: true });
    // keep the best block of each candidate item
    const bestPerItem = new Map();
    for (const { chunk, score } of hits) {
        if (chunk.itemId === item.id) continue;                       // not itself
        if (chunk.itemType === 'insert') continue;                    // never point at photo/blank/title pages
        if (alreadyLinked.has(chunk.itemId) || alreadyLinked.has(chunk.id)) continue;
        const pos = positionOf[chunk.itemId];
        if (pos === undefined || pos >= position) continue;           // only earlier content
        if (!bestPerItem.has(chunk.itemId)) bestPerItem.set(chunk.itemId, { chunk, score });
    }
    const ranked = [...bestPerItem.values()].sort((a, b) => b.score - a.score);
    if (!ranked.length) return [];
    const top = ranked[0].score;
    return ranked
        .filter((h) => h.score >= opts.minScore && h.score >= top * opts.relativeCut)
        .slice(0, opts.maxRefs)
        .map(({ chunk, score }) => ({
            blockId: chunk.id,
            itemId: chunk.itemId,
            label: chunk.label,
            score: Math.round(score * 10) / 10,
            snippet: snippetOf(index.itemById[chunk.itemId]),
        }));
}

/**
 * Run the whole pipeline on parsed data. Pure (apart from the clock, which can be passed in).
 * @param {Array} data  parsed data.json
 * @param {{ retrieval: {createIndex:Function, search:Function}, now?: Date, maxRefs?: number, minScore?: number,
 *           relativeCut?: number, pool?: number }} options
 * @returns {{ data: Array, report: Object, changed: boolean }}
 */
function processDraft(data, options) {
    const opts = { ...DEFAULTS, ...options };
    const { retrieval } = opts;
    if (!retrieval) throw new Error('processDraft needs the retrieval module ({ createIndex, search })');
    const now = (opts.now || new Date()).toISOString().replace(/\.\d{3}Z$/, 'Z');

    // Which items are new is decided BEFORE ids are given out.
    const newPositions = data.map((item, i) => (isNewItem(item) ? i : -1)).filter((i) => i >= 0);
    const itemsWithNewBlocks = data.map((item, i) =>
        (!isNewItem(item) && (item.blocks || []).some((b) => !hasId(b)) ? i : -1)).filter((i) => i >= 0);

    // 1. ids
    const filled = fillMissingIds(data);
    let next = filled.data;

    // 2. timestamps for brand-new items
    next = next.map((item, i) => (newPositions.includes(i) && !item.timestamp ? withTimestamp(item, now) : item));

    // 3 + 4. cross-references (index built over data that now has ids; labels of new items may show "?" until they have a num)
    const report = {
        newItems: [],
        newBlocksInExistingItems: [],
        idsAdded: { items: filled.items, blocks: filled.blocks },
    };
    if (newPositions.length) {
        const index = retrieval.createIndex(next);
        const positionOf = Object.fromEntries(next.map((item, i) => [item.id, i]));
        for (const position of newPositions) {
            let item = next[position];
            // A new answer with no references, right after a question, is that question's answer. You cannot write
            // the question's id in the draft (it does not have one yet), so the agent links them; the answer then
            // takes the question's number (see itemNumber in core/blocks.js).
            // A new answer with no references right after ANOTHER answer is a follow-up/update to it (it gets
            // interleaved right below the answer it extends): it references the blocks of that answer it relates to,
            // like the existing follow-up answers do. It has no question of its own, so it needs its own `num`.
            let replyTo = null;
            let followUpOf = null;
            // `_agent: { standalone: true }` is left by notes-to-blocks on a note-style answer that is NOT a follow-up of
            // the answer above it: it keeps its own num, links to nothing by position, and the marker is removed here.
            const standalone = Boolean(item._agent && item._agent.standalone);
            if (item._agent) {
                const { _agent, ...rest } = item;
                item = rest;
                next[position] = item;
            }
            if (item.type === 'answer' && !(item.references || []).length && !standalone) {
                const previous = next[position - 1];
                if (previous && previous.type === 'question') {
                    replyTo = previous.id;
                    item = withReferences(item, [previous.id]);
                    next[position] = item;
                } else if (previous && previous.type === 'answer') {
                    const blocks = findFollowUpBlocks(index, retrieval, item, previous, opts);
                    if (blocks.length) {
                        followUpOf = { id: previous.id, snippet: snippetOf(previous), blocks };
                        item = withReferences(item, blocks.map((b) => b.blockId));
                        next[position] = item;
                    }
                }
            }
            const related = item.type === 'insert' ? [] : findRelated(index, retrieval, item, position, positionOf, opts);
            if (related.length) {
                const refs = [...(item.references || []), ...related.map((r) => r.blockId)];
                item = withReferences(item, refs);
                next[position] = item;
            }
            report.newItems.push({
                id: item.id,
                type: item.type,
                snippet: snippetOf(item),
                blockIds: (item.blocks || []).map((b) => b.id),
                replyTo,
                replyToLabel: replyTo ? snippetOf(next[position - 1]) : null,
                followUpOf,
                existingReferences: (item.references || []).filter((r) => r !== replyTo
                    && !(followUpOf && followUpOf.blocks.some((b) => b.blockId === r))
                    && !related.some((x) => x.blockId === r)),
                added: related,
                needsNum: itemNeedsNum(item, next),
                blocksNeedingNum: (item.blocks || []).filter((b) => !Number.isInteger(b.num)).map((b) => b.id),
            });
        }
    }
    for (const position of itemsWithNewBlocks) {
        const before = data[position];
        const item = next[position];
        report.newBlocksInExistingItems.push({
            itemId: item.id,
            snippet: snippetOf(item),
            blockIds: (item.blocks || []).filter((b, j) => !hasId(before.blocks[j])).map((b) => b.id),
            blocksNeedingNum: (item.blocks || []).filter((b) => !Number.isInteger(b.num)).map((b) => b.id),
        });
    }

    const changed = JSON.stringify(next) !== JSON.stringify(data);
    return { data: next, report, changed };
}

/** True when the item would show "?" as its number (no num of its own, and not an answer to a numbered question). */
function itemNeedsNum(item, data) {
    if (item.type === 'insert' && item.num === undefined) return true;
    if (Number.isInteger(item.num)) return false;
    if (item.type === 'answer') {
        const byId = Object.fromEntries(data.map((i) => [i.id, i]));
        for (const ref of item.references || []) {
            const target = byId[ref];
            if (target && target.type === 'question' && Number.isInteger(target.num)) return false;
        }
    }
    return true;
}

/** The Markdown for the Pull Request description. */
function renderReport(report) {
    const lines = [];
    const n = report.newItems.length;
    const b = report.newBlocksInExistingItems.length;
    lines.push('## Content pipeline agent');
    lines.push('');
    if (!n && !b) {
        lines.push('Nothing new to process: every item and block already has an id.');
        return lines.join('\n') + '\n';
    }
    lines.push(`Processed **${n} new item(s)**${b ? ` and **new block(s) in ${b} existing item(s)**` : ''}. `
        + `Added ${report.idsAdded.items} item id(s) and ${report.idsAdded.blocks} block id(s). Nothing existing was changed.`);
    lines.push('');
    for (const it of report.newItems) {
        lines.push(`### New ${it.type}: ${it.snippet}`);
        lines.push(`- id \`${it.id}\`; blocks ${it.blockIds.map((x) => `\`${x}\``).join(', ') || '(none)'}`);
        if (it.replyTo) lines.push(`- linked as the answer to the question right above it (\`${it.replyTo}\`: ${it.replyToLabel}); it takes that question's number`);
        if (it.followUpOf) {
            lines.push(`- linked as a follow-up to the answer right above it (\`${it.followUpOf.id}\`: ${it.followUpOf.snippet}), through the blocks it relates to most (review, and keep only the ones it really builds on):`);
            for (const b of it.followUpOf.blocks) lines.push(`  - **Ref: ${b.label}** → \`${b.blockId}\`${b.score ? ` (score ${b.score})` : ' (first block: nothing matched)'}`);
        }
        if (it.existingReferences.length) lines.push(`- kept your own references: ${it.existingReferences.map((x) => `\`${x}\``).join(', ')}`);
        if (it.added.length) {
            lines.push('- cross-references added (review these; delete any that do not fit):');
            for (const r of it.added) lines.push(`  - **Ref: ${r.label}** → \`${r.blockId}\` (score ${r.score}): ${r.snippet}`);
        } else if (it.type === 'insert') {
            lines.push('- no cross-references (inserts never get any)');
        } else {
            lines.push('- no cross-references: nothing earlier in the book matched well enough');
        }
        if (it.needsNum) {
            lines.push(it.followUpOf
                ? '- ⚠️ **needs its own `num`**: a follow-up answer is not under a question, so it cannot take one; tests fail until then'
                : '- ⚠️ **needs a `num`** (add one, or for an answer add a `references` entry pointing at its question); tests fail until then');
        }
        if (it.blocksNeedingNum.length) lines.push(`- ⚠️ block(s) without a \`num\`: ${it.blocksNeedingNum.map((x) => `\`${x}\``).join(', ')}`);
        lines.push('');
    }
    for (const it of report.newBlocksInExistingItems) {
        lines.push(`### New block(s) in existing item: ${it.snippet}`);
        lines.push(`- item \`${it.itemId}\`; new block id(s) ${it.blockIds.map((x) => `\`${x}\``).join(', ')} (cross-references are only added to brand-new items)`);
        if (it.blocksNeedingNum.length) lines.push(`- ⚠️ block(s) without a \`num\`: ${it.blocksNeedingNum.map((x) => `\`${x}\``).join(', ')}`);
        lines.push('');
    }
    lines.push('### Before merging');
    lines.push('- [ ] The cross-references above make sense (the agent matches words and tags, so it can be wrong)');
    lines.push('- [ ] Every new item/block has the right `num`, and the item sits where you want it in the file');
    lines.push('- [ ] Typos and missing translations are checked (the agent does not touch your text)');
    lines.push('- [ ] CI is green');
    return lines.join('\n') + '\n';
}

module.exports = { processDraft, findRelated, findFollowUpBlocks, renderReport, queryFor, snippetOf, itemNeedsNum, DEFAULTS };

// ── CLI ────────────────────────────────────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
    const args = { dryRun: false, report: null, maxRefs: DEFAULTS.maxRefs, minScore: DEFAULTS.minScore, followUpBlocks: DEFAULTS.followUpBlocks, data: DATA_PATH };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--dry-run') args.dryRun = true;
        else if (a === '--report') args.report = argv[++i];
        else if (a === '--max-refs') args.maxRefs = Math.max(0, parseInt(argv[++i], 10) || 0);
        else if (a === '--min-score') args.minScore = Number(argv[++i]);
        else if (a === '--follow-up-blocks') args.followUpBlocks = Math.max(1, parseInt(argv[++i], 10) || 1);
        else if (a === '--data') args.data = path.resolve(argv[++i]);
        else throw new Error(`Unknown option: ${a}`);
    }
    return args;
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const raw = fs.readFileSync(args.data, 'utf8');
    let data;
    try { data = JSON.parse(raw); } catch (e) { throw new Error(`${args.data} is not valid JSON: ${e.message}`); }
    if (!Array.isArray(data)) throw new Error('data.json must be an array of items');

    // retrieval.js is an ES module (it runs in the browser too); import() needs Node 22 (the workflow uses it).
    const retrieval = await import(pathToFileURL(path.join(ROOT, 'src', 'ai', 'retrieval.js')).href);

    const { data: next, report, changed } = processDraft(data, { retrieval, maxRefs: args.maxRefs, minScore: args.minScore, followUpBlocks: args.followUpBlocks });
    const markdown = renderReport(report);
    if (args.report) fs.writeFileSync(args.report, markdown);
    console.log(markdown);
    if (args.dryRun) { console.log('(dry run: data.json not written)'); return; }
    if (changed) {
        fs.writeFileSync(args.data, JSON.stringify(next, null, 2) + (raw.endsWith('\n') ? '\n' : ''));
        console.log('data.json updated.');
    } else {
        console.log('data.json unchanged.');
    }
    // lets the workflow know whether there is anything to commit
    if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `changed=${changed}\nhas_new=${report.newItems.length + report.newBlocksInExistingItems.length > 0}\n`);
}

if (require.main === module) {
    main().catch((e) => { console.error(`content-agent: ${e.message}`); process.exit(1); });
}
