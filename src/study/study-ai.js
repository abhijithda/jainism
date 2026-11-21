// study/study-ai.js — The optional AI part of the study companion. Everything
// works without it (see study-questions.js); this only adds, on request:
//   - a new question written from the passages the reader just met, and
//   - feedback on the reader's own answer.
//
// Same rules as the "Ask the book" assistant (ai/rag.js): the model may only use
// the passages it is given, must cite them by label, and anything that cites no
// real passage is thrown away rather than shown. Only hosted engines (Cloud, or
// the reader's own service) are used: small on-device models have been seen to
// reverse a passage's meaning (see ai/rag.js), and a wrong "you got it right" on
// religious content is worse than no feedback.

import { formatPassage, parseCitations } from '../ai/prompt.js';
import { KNOWN_LANGS } from '../core/langs.js';

const langName = code => KNOWN_LANGS.find(l => l.code === code)?.name || code;

/** English whenever the reader has it selected (the study panel's own words are English); else their first language. */
export const studyLang = langs => (!langs?.length || langs.includes('en') ? 'en' : langs[0]);

/** Hosted engines only, and only when usable (set up, key present...). */
export function aiAvailable(engine) {
    return !!engine && (engine.id === 'cloud' || engine.id === 'custom') && engine.available().ok;
}

const RULES = `Rules:
1. Use ONLY the passages in the user's message. Never add facts from general knowledge.
2. Never reverse, soften or strengthen what a passage says. A question that appears in a passage is a question, not the book's view.
3. Cite every claim with the passage label in square brackets exactly as given, e.g. [A-3.1]. Cite only labels that appear in the passages.
4. Do not copy language labels (such as "Kannada:") into your reply. {LANGRULE}`;

// Feedback goes back in the language the reader answered in (they may type English although Kannada is
// their first selected language); a new question uses studyLang().
const system = (task, langs, { matchReader = false } = {}) => `${task}\n\n${RULES.replace('{LANGRULE}', matchReader
    ? `Reply in the same language as the reader's answer; if that is unclear, write in ${langName(studyLang(langs))}.`
    : `Write in ${langName(studyLang(langs))}.`)}`;
const passageBlock = passages => passages.map(formatPassage).join('\n\n');

/** @returns {{role:string,content:string}[]} */
export function buildQuestionMessages({ passages, langs, avoid = [] }) {
    const task = 'You help a reader of a Jaina pooja FAQ book test their understanding. Write ONE question that checks understanding of the passages (not a yes/no question, not a request to recite). ' +
        'Reply with only a JSON object: {"question": "...", "answer": "..."}. "answer" is a short model answer that cites the passages it uses.';
    const avoidNote = avoid.length ? `\nDo not repeat these questions:\n${avoid.map(q => `- ${q}`).join('\n')}` : '';
    return [
        { role: 'system', content: system(task, langs) },
        { role: 'user', content: `Passages:\n\n${passageBlock(passages)}${avoidNote}` },
    ];
}

/**
 * Reads a model's reply to buildQuestionMessages. Null unless it is a usable question
 * whose answer cites at least one real passage.
 * @returns {{question: string, answer: string, citations: {label:string,blockId:string}[]}|null}
 */
export function parseQuestion(text, passages) {
    const m = String(text).replace(/```(?:json)?/gi, '').match(/\{[\s\S]*\}/);
    if (!m) return null;
    let obj;
    try { obj = JSON.parse(m[0]); } catch (_) { return null; }
    const question = typeof obj?.question === 'string' ? obj.question.trim() : '';
    const answer = typeof obj?.answer === 'string' ? obj.answer.trim() : '';
    if (!question || question.length > 400 || !answer) return null;
    const citations = parseCitations(answer, passages);
    return citations.length ? { question, answer, citations } : null;
}

export async function generateQuestion({ engine, passages, langs, avoid, signal }) {
    const reply = await engine.generate(buildQuestionMessages({ passages, langs, avoid }), { signal });
    return parseQuestion(reply, passages);
}

export function buildCheckMessages({ question, learnerAnswer, passages, langs }) {
    const task = 'A reader of a Jaina pooja FAQ book answered a study question. In at most four short sentences, say what their answer gets right and what it leaves out or gets wrong, judged only against the passages. ' +
        'Be encouraging and plain. If the passages do not settle part of the question, say so instead of guessing.';
    return [
        { role: 'system', content: system(task, langs, { matchReader: true }) },
        { role: 'user', content: `Passages:\n\n${passageBlock(passages)}\n\nQuestion: ${question}\n\nReader's answer: ${learnerAnswer}` },
    ];
}

/** @returns {Promise<{text: string, citations: {label:string,blockId:string}[]}|null>} null if it cites no real passage */
export async function checkAnswer({ engine, question, learnerAnswer, passages, langs, signal }) {
    const text = String(await engine.generate(buildCheckMessages({ question, learnerAnswer, passages, langs }), { signal })).trim();
    const citations = parseCitations(text, passages);
    return text && citations.length ? { text, citations } : null;
}

// CommonJS shim for Jest
if (typeof module !== 'undefined' && module.exports) {
    Object.assign(module.exports, { studyLang, aiAvailable, buildQuestionMessages, parseQuestion, generateQuestion, buildCheckMessages, checkAnswer });
}
