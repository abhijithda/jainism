// lib/translit.js — how the agent writes Kannada/Sanskrit/Prakrit words in Latin letters.
//
// The book's style is Sanskrit/Kannada, not Hindi: the final "a" stays (abhisheka, rama, pushparohana), where Hindi
// drops it (abhishek, ram). Models drift to the Hindi spelling, so this is stated in every prompt that writes English
// (TRANSLIT_STYLE) and, where a Kannada word is known, checked in code (fixFinalA).

const TRANSLIT_STYLE = `Spelling of Sanskrit, Prakrit and Kannada words in Latin letters: follow the Sanskrit/Kannada form, NOT the Hindi one. Keep the final "a" (abhisheka not abhishek, Rama not Ram, Mahavira, Pushparohana, Tirthankara, Jina, Kalasha). Do not drop the inherent "a" at the end of a word. Keep the long/short distinctions the Kannada shows where the simple style allows (aa only when the word is usually written so), and do not use diacritics.`;

const WORD_SEP = /([\s:/,.;()\-–=]+)/;
const KANNADA_CONSONANT_END = /[\u0C95-\u0CB9]$/;           // a consonant letter with no sign after it: the inherent "a" is pronounced
const LATIN_CONSONANT_END = /[bcdfghjklmnpqrstvwxyz]$/i;

/**
 * Kannada word(s) and their Latin spelling: where the Kannada ends in a bare consonant (so it ends in "a") and the Latin ends
 * in a consonant, put the "a" back. Word by word when the word counts match, else the last word only.
 * @returns {{ text: string, changed: boolean }}
 */
function fixFinalA(kannada, latin) {
    const kn = String(kannada).split(WORD_SEP).filter((t, i) => i % 2 === 0 && t);
    const parts = String(latin).split(WORD_SEP);
    const wordIdx = parts.map((t, i) => (i % 2 === 0 && t ? i : -1)).filter((i) => i >= 0);
    const pairs = kn.length === wordIdx.length ? wordIdx.map((p, k) => [kn[k], p]) : wordIdx.length ? [[kn[kn.length - 1], wordIdx[wordIdx.length - 1]]] : [];
    let changed = false;
    for (const [k, p] of pairs) {
        if (k && KANNADA_CONSONANT_END.test(k) && LATIN_CONSONANT_END.test(parts[p])) {
            parts[p] += /[A-Z]$/.test(parts[p]) && !/[a-z]/.test(parts[p]) ? 'A' : 'a';
            changed = true;
        }
    }
    return { text: parts.join(''), changed };
}

/** Same word for comparing English spellings: letters only, lower case. */
const sameWord = (a, b) => {
    const n = (t) => String(t).toLowerCase().replace(/[^a-z]/g, '');
    return n(a) !== '' && n(a) === n(b);
};

module.exports = { TRANSLIT_STYLE, fixFinalA, sameWord };
