// src/core/book-title.js — The book's title and subtitle, read from data.json.
//
// data.json is the one place the title is written. The cover (data[0], an
// "insert" item) has one block whose content lists lines per language; the
// first non-empty line of each language is the TITLE and the second, if there
// is one, the SUBTITLE:
//
//   "content": { "kn": ["<title>", "<subtitle>"], "en": ["<title>", "<subtitle>"] }
//
// Everything that shows the title (the Home cover, the book view's running
// head, the browser/print title, the share bar, the print file names, the
// release name) gets it from here. The only copies that cannot be read at run
// time are the link-preview tags in index.html, which chat apps read without
// running any JavaScript — scripts/sync-title.js rewrites those from data.json
// and a test (title-sync.test.js) fails if they ever drift.

/**
 * @param {Array} data  parsed data.json
 * @returns {{kn: {title: string, subtitle: string}, en: {title: string, subtitle: string}}}
 *          empty strings when the data has no cover.
 */
export function getBookTitle(data) {
    const cover = data?.[0]?.type === 'insert' ? data[0] : null;
    const content = cover?.blocks?.[0]?.content || {};
    const one = lang => {
        const lines = (Array.isArray(content[lang]) ? content[lang] : [])
            .map(line => String(line ?? '').trim())
            .filter(Boolean);
        return { title: lines[0] || '', subtitle: lines[1] || '' };
    };
    return { kn: one('kn'), en: one('en') };
}

/** "Kannada title | English title" — the plain form (continuous view, share bar, link preview). */
export function joinTitle(title) {
    return [title.kn.title, title.en.title].filter(Boolean).join(' | ');
}

// A print header is one line: the Kannada title at the left, the English title
// pushed to the right edge with em spaces. The count is chosen so the whole
// line stays about as wide whatever the two titles are (a rough width per
// character: Kannada 0.8 em, Latin 0.55 em; the total is what the original
// title used). It is an estimate, so look at the printed header after a title
// change.
const HEADER_TOTAL_EMS = 73;

/** The book view's browser/print title: Kannada, then English at the right edge. */
export function bookHeaderTitle(title) {
    const kn = title.kn.title;
    const en = title.en.title;
    if (!kn || !en) return kn || en;
    const used = Array.from(kn).length * 0.8 + Array.from(en).length * 0.55;
    const pad = Math.max(4, Math.round(HEADER_TOTAL_EMS - used));
    return `${kn} ${'\u2003'.repeat(pad)} ${en}`;
}

/** A title as a file-name part: "Jainism F.A.Q.s" -> "Jainism-FAQs", "Q & A" -> "Q-and-A". */
export function titleSlug(text) {
    return String(text ?? '')
        .replace(/\./g, '')
        .replace(/&/g, ' and ')
        .normalize('NFD').replace(/\p{M}/gu, '')
        .replace(/[^A-Za-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}
