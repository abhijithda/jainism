// langs.js — Shared language registry. One place to add a language so it
// shows up everywhere it's needed (header.js's language picker, the views, the content agent's language list).

export const KNOWN_LANGS = [
    { code: 'kn', label: 'ಕನ್ನಡ', name: 'Kannada' },
    { code: 'en', label: 'English', name: 'English' },
    { code: 'hi', label: 'हिन्दी', name: 'Hindi' },
];

export const LANG_CODES = KNOWN_LANGS.map(l => l.code);

/**
 * The most languages a reader can have on screen at once. A row of text in
 * three or more languages is unreadable on a phone and on a printed page, so
 * the picker stops at two (a main language and one to compare with). What is
 * on screen is what gets printed, so this limit holds for prints too.
 */
export const MAX_ACTIVE_LANGS = 2;

/**
 * Valid language codes from a list, in registry order, at most MAX_ACTIVE_LANGS.
 * @param {string[]} codes
 * @returns {string[]}
 */
export function limitLangs(codes) {
    const wanted = Array.isArray(codes) ? codes : [];
    return LANG_CODES.filter(code => wanted.includes(code)).slice(0, MAX_ACTIVE_LANGS);
}

/**
 * The language codes a selection stands for, in registry order. The selection
 * is a list of codes (what the picker saves, e.g. ['kn', 'hi']), or, for older
 * callers, one code or 'all' (every known language).
 * @param {string|string[]} selection
 * @returns {string[]}
 */
export function activeLangCodes(selection = 'all') {
    if (Array.isArray(selection)) return LANG_CODES.filter(code => selection.includes(code));
    return LANG_CODES.filter(code => selection === code || selection === 'all');
}

// CommonJS shim for Jest
if (typeof module !== 'undefined' && module.exports) {
    Object.assign(module.exports, { KNOWN_LANGS, LANG_CODES, MAX_ACTIVE_LANGS, limitLangs, activeLangCodes });
}
