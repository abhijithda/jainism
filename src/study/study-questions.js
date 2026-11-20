// study/study-questions.js — Builds study questions from the book itself.
// Pure functions: no DOM, no network, no AI. Everything a question shows as
// "what the book says" is the book's own text, word for word.
//
// Two kinds of question, both derived from data.json:
//
//   compare  "You just read about Deva Moodhata. Can you explain how it differs
//            from Loka Moodhata?" Topics come from the blocks' `tags`. A topic's
//            siblings are the other multi-word topics that end in the same word
//            (Nishchaya Naya / Vyavahara Naya), plus phrases of the same shape
//            that the book's English text names without tagging them (the book
//            lists "Loka Moodhata" and "Guru Moodhata" in one note, but only
//            "Deva Moodhata" is a tag). A comparison is only offered when the
//            book has a passage for BOTH sides: never ask what it doesn't cover.
//
//   recall   "Here is a question from the book: …. What does the book answer?"
//            For an answer item, once every trackable block of it is marked read.
//
// A question has a stable id, so the same one is not asked twice, and a small
// `desc` (descriptor) from which it can be rebuilt after a reload.

import { search, foldLatin, tokenize } from '../ai/retrieval.js';
import { isBlockTrackable } from '../core/read-tracking.js';

const MIN_SCORE = 0.5;                 // same floor retrieval.js uses for "relevant"
const MAX_PASSAGES_PER_TOPIC = 2;
const MAX_RECALL_PASSAGES = 4;
const QUESTION_MAX_CHARS = 300;

// Capitalised words that start a sentence rather than name something
// ("Is Moodhata ...", "The Naya ..."): never the first word of a sibling phrase.
const NOT_A_NAME = new Set((
    'a an and are as at be but by for from how i if in is it its no not of on or so that the their then there ' +
    'these this to was what when where which who why with you your here also only both each any all one two'
).split(' '));

// Titles that start a person's name ("Queen Vishalakshi", "Rani Vishalakshi", "Shri Gautama"): two
// ways of naming one person are not two topics to compare.
const TITLE_WORDS = new Set('queen king rani raja raaja prince princess shri sri lord mother father saint sage acharya muni swami'.split(' '));

const lower = s => String(s).trim().toLowerCase();
const lastWord = phrase => String(phrase).trim().split(/\s+/).pop();
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function editDistance(a, b) {
    const row = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
        let prev = row[0];
        row[0] = i;
        for (let j = 1; j <= b.length; j++) {
            const keep = row[j];
            row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
            prev = keep;
        }
    }
    return row[b.length];
}

/**
 * Two transliterations of one word (Samyag / Samyak, Abhisheka / Abhishek,
 * Ratnakaranda / Ratnakarandaka) are spellings, not two topics to compare.
 */
function sameWord(a, b) {
    const x = foldLatin(lower(a)), y = foldLatin(lower(b));
    // one name inside the other (Harivamsha / Vamsha) is the same name, shortened
    if (Math.min(x.length, y.length) >= 4 && (x.includes(y) || y.includes(x))) return true;
    return x === y || editDistance(x, y) <= Math.max(1, Math.floor(Math.min(x.length, y.length) / 5));
}

/** The first non-empty line(s) of a block, in the first of `langs` it has text in. */
export function blockText(block, langs) {
    for (const lang of [...langs, 'en', 'kn']) {
        const lines = (block?.content?.[lang] || []).filter(l => l.trim() !== '');
        if (lines.length) return lines.join(' ');
    }
    return '';
}

/**
 * Indexes what the question builders need, once per dataset.
 * @param {Object} index  from ai/retrieval.js createIndex()
 */
export function buildStudyModel(index) {
    const chunkById = new Map(index.chunks.map(c => [c.id, c]));
    const blockItem = new Map();
    index.data.forEach(item => (item.blocks || []).forEach(b => blockItem.set(b.id, item)));

    // Topics: tag name (case-insensitive) -> the blocks carrying it.
    const topics = new Map();
    index.chunks.forEach(c => c.tags.forEach(tag => {
        const key = lower(tag);
        if (!topics.has(key)) topics.set(key, { name: tag, blockIds: new Set() });
        topics.get(key).blockIds.add(c.id);
    }));

    // Sibling groups by shared last word ("head"): head -> Map(lower phrase -> {name, source}).
    const heads = new Map();
    const addPhrase = (head, name, source) => {
        const group = heads.get(lower(head)) || new Map();
        heads.set(lower(head), group);
        if (!group.has(lower(name))) group.set(lower(name), { name, source });
    };
    topics.forEach(({ name }) => {
        const words = name.trim().split(/\s+/);
        if (words.length >= 2 && words[words.length - 1].length >= 4) addPhrase(words[words.length - 1], name, 'tag');
    });
    // Phrases the English text names without tagging them: "<Capitalised word> <Head>".
    heads.forEach((group, headKey) => {
        const headWord = [...group.values()][0].name.trim().split(/\s+/).pop();
        const re = new RegExp(`(?<![\\p{L}\\p{N}])([A-Z][\\p{L}]+)\\s+${escapeRe(headWord)}(?![\\p{L}])`, 'gu');
        index.chunks.forEach(c => {
            const text = c.text.en;
            if (!text) return;
            for (const m of text.matchAll(re)) {
                if (NOT_A_NAME.has(lower(m[1]))) continue;
                addPhrase(headKey, `${m[1]} ${headWord}`, 'text');
            }
        });
    });

    // What each block says in English plus its tags, lower-cased, for "named together" checks.
    const mentions = index.chunks.map(c => lower(`${c.text.en || ''} ${c.tags.join(' ')}`));

    const phrases = [...heads.values()].flatMap(group => [...group.values()].map(v => v.name));

    return { index, chunkById, blockItem, topics, heads, mentions, phrases };
}

/**
 * The topics a block is about: its tags, then any known topic phrase its English text names
 * ("Mithya Drishti" is in the text of a passage that is not tagged with it), so reading the
 * other side of a comparison later brings the comparison up then.
 */
export function topicsOf(model, chunk) {
    const out = [...chunk.tags];
    const text = lower(chunk.text.en || '');
    model.phrases.forEach(name => {
        if (text.includes(lower(name)) && !out.some(t => lower(t) === lower(name))) out.push(name);
    });
    return out;
}

/** Whether some block of the book names both phrases (in its English text or tags). */
function namedTogether(model, a, b) {
    const x = lower(a), y = lower(b);
    return model.mentions.some(m => m.includes(x) && m.includes(y));
}

/**
 * Other topics of the same shape as `topic` that make a sensible comparison:
 *  - a tag sharing its last word (Nishchaya Naya / Vyavahara Naya), or
 *  - a phrase of the same shape that the text names but doesn't tag, but only
 *    if some block names it together with the topic (the Moodhata note lists Deva, Loka and
 *    Guru together). That keeps out stray capitalised words. A person named two ways
 *    (Rani / Queen Vishalakshi) is not a comparison: see TITLE_WORDS.
 * Spelling variants of the topic itself are left out. Best first: pairs the
 * book names together, then plain tag siblings.
 * @returns {{name: string, together: boolean}[]}
 */
export function comparisonsFor(model, topic) {
    const group = model.heads.get(lower(lastWord(topic)));
    if (!group || topic.trim().split(/\s+/).length < 2) return [];
    const firstWord = phrase => phrase.trim().split(/\s+/)[0];
    return [...group.entries()]
        .filter(([key]) => key !== lower(topic))
        .map(([, v]) => ({ ...v, together: namedTogether(model, topic, v.name) }))
        .filter(v => !sameWord(firstWord(v.name), firstWord(topic)))
        .filter(v => !TITLE_WORDS.has(lower(firstWord(v.name))) && !TITLE_WORDS.has(lower(firstWord(topic))))
        .filter(v => v.source === 'tag' || v.together)
        .sort((a, b) => Number(b.together) - Number(a.together))
        .map(({ name, together }) => ({ name, together }));
}

/** Names only; see comparisonsFor. */
export const siblingsOf = (model, topic) => comparisonsFor(model, topic).map(c => c.name);

function passageOf(chunk, langs, topic) {
    const text = {};
    langs.forEach(lang => { if (chunk.text[lang]) text[lang] = chunk.text[lang]; });
    return { id: chunk.id, label: chunk.label, text: Object.keys(text).length ? text : chunk.text, topic };
}

/** The book's best passages on a topic; `first` (a block id) goes in front if it has text. */
function topicPassages(model, topic, langs, { first, skip = new Set(), readSet } = {}) {
    const out = [];
    // A passage is about the topic only if it has every word of it ("Loka Moodhata" needs "Loka", not just
    // "Moodhata"); otherwise a topic the book never mentions would borrow another topic's passages.
    const terms = [...new Set(tokenize(topic))];
    const push = chunk => {
        if (!chunk || chunk.textless || skip.has(chunk.id) || out.some(p => p.id === chunk.id)) return;
        if (!terms.every(t => chunk.tf.has(t))) return;
        if (readSet && !readSet.has(chunk.id)) return;   // only what the reader has marked as read: never test what they haven't met
        if (out.length < MAX_PASSAGES_PER_TOPIC) out.push(passageOf(chunk, langs, topic));
    };
    if (first) push(model.chunkById.get(first));
    search(model.index, topic, { k: 30, textOnly: true })
        .filter(h => h.score >= MIN_SCORE)
        .forEach(h => push(h.chunk));
    return out;
}

export const suggestionId = desc =>
    desc.kind === 'recall'
        ? `recall:${desc.itemId}`
        : `compare:${desc.topics.map(lower).sort().join('|')}`;

/**
 * Builds one question from its descriptor, or null if the book no longer
 * supports it (content moved or removed since it was saved).
 * @param {Object} model
 * @param {{kind:'compare', topics:[string,string]}|{kind:'recall', itemId:string}} desc
 * @param {{langs?: string[], blockId?: string, readSet?: Set<string>}} [opts]  with `readSet`, a
 *   comparison only draws on blocks the reader has marked as read, on both sides
 */
export function buildSuggestion(model, desc, { langs = ['en'], blockId, readSet } = {}) {
    if (desc?.kind === 'compare' && Array.isArray(desc.topics) && desc.topics.length === 2) {
        const [a, b] = desc.topics;
        // The other topic picks first: when one note names both (Deva, Loka and Guru Moodhata in one list),
        // it must not be used up by the topic that has many other passages to choose from.
        const theirs = topicPassages(model, b, langs, { readSet });
        const mine = topicPassages(model, a, langs, { first: blockId, readSet, skip: new Set(theirs.map(p => p.id)) });
        if (!mine.length || !theirs.length) return null;
        return {
            id: suggestionId(desc), desc, kind: 'compare', title: `${a} vs ${b}`,
            prompt: `You just read about ${a}. Can you explain how it differs from ${b}?`,
            passages: [...mine, ...theirs],   // the topic just read first, then the one to compare it with
        };
    }
    if (desc?.kind === 'recall') {
        const item = model.index.itemById[desc.itemId];
        if (!item || item.type !== 'answer') return null;
        const question = questionOf(model, item, langs);
        const passages = (item.blocks || [])
            .map(b => model.chunkById.get(b.id)).filter(c => c && !c.textless)
            .slice(0, MAX_RECALL_PASSAGES).map(c => passageOf(c, langs));
        if (!question || !passages.length) return null;
        const shortQ = question.length > QUESTION_MAX_CHARS ? `${question.slice(0, QUESTION_MAX_CHARS).trimEnd()}\u2026` : question;
        return {
            id: suggestionId(desc), desc, kind: 'recall',
            title: `Recall: ${shortQ.length > 60 ? `${shortQ.slice(0, 60).trimEnd()}\u2026` : shortQ}`,
            prompt: `A question from the book: \u201C${shortQ}\u201D What does the book answer?`,
            passages,
        };
    }
    return null;
}

/** The text of the question an answer item replies to ('' if it has none). */
function questionOf(model, answerItem, langs) {
    for (const refId of answerItem.references || []) {
        const target = model.index.itemById[refId] || model.blockItem.get(refId);
        if (target?.type === 'question') {
            const text = (target.blocks || []).map(b => blockText(b, langs)).filter(Boolean).join(' ');
            if (text) return text;
        }
    }
    return '';
}

/**
 * Questions to offer right after the reader marks `blockId` as read.
 * Comparisons first (they need the topic the reader just met), then recall of
 * a whole answer once every readable block of it is read. Anything already in
 * `done` (answered before) is skipped.
 * @param {Object} model
 * @param {string} blockId
 * @param {{readSet: Set<string>, done?: Object, langs?: string[], max?: number}} opts
 */
export function suggestionsForRead(model, blockId, { readSet, done = {}, langs = ['en'], max = 2 }) {
    const chunk = model.chunkById.get(blockId);
    const item = model.blockItem.get(blockId);
    if (!chunk || !item || item.type === 'insert') return [];
    const out = [];
    const push = s => { if (s && out.length < max && !done[s.id] && !out.some(o => o.id === s.id)) out.push(s); };

    // Per topic of the block, the first sibling the reader has read about too (so both sides can be
    // answered from what they have read). Pairs the book names together first; one comparison per
    // topic, so two cards are never the same question twice.
    const candidates = [];
    topicsOf(model, chunk).forEach((tag, order) => {
        for (const sib of comparisonsFor(model, tag)) {
            const desc = { kind: 'compare', topics: [tag, sib.name] };
            if (done[suggestionId(desc)]) continue;
            const s = buildSuggestion(model, desc, { langs, blockId, readSet });
            if (s) { candidates.push({ s, together: sib.together, order }); break; }
        }
    });
    candidates.sort((a, b) => (Number(b.together) - Number(a.together)) || (a.order - b.order));
    const compares = candidates.map(c => c.s);

    // A comparison first, then recall of the whole answer (once all of it is read), then any further comparison.
    push(compares[0]);
    if (item.type === 'answer' && (item.blocks || []).filter(isBlockTrackable).every(b => readSet.has(b.id))) {
        push(buildSuggestion(model, { kind: 'recall', itemId: item.id }, { langs, blockId }));
    }
    compares.slice(1).forEach(push);
    return out;
}

// CommonJS shim for Jest
if (typeof module !== 'undefined' && module.exports) {
    Object.assign(module.exports, { blockText, buildStudyModel, topicsOf, siblingsOf, comparisonsFor, suggestionId, buildSuggestion, suggestionsForRead });
}
