// study/study-panel.js — The study companion's UI: a header "Study" button, a small
// nudge after the reader marks a block as read, and a slide-over panel of questions.
//
// It reacts to the `pooja:block-read` event that the read tick (core/read-tick.js)
// fires; it never watches scrolling, so nothing appears until the reader says "I read this".
// The nudge only offers; it never opens the panel by itself, so reading is not interrupted.
// Everything from the book or a model goes on the page as text nodes, never innerHTML.

import { loadSettings, saveSettings } from '../core/settings.js';
import { getReadBlocks } from '../core/read-tracking.js';
import { createIndex } from '../ai/retrieval.js';
import { getEngine } from '../ai/engines/index.js';
import { closeDrawer as closeAiDrawer } from '../ai/ai-panel.js';
import { buildStudyModel, buildSuggestion, suggestionsForRead, blockText } from './study-questions.js';
import { loadStudyLog, saveStudyLog, recordResult, reviewList } from './study-log.js';
import { aiAvailable, generateQuestion, checkAnswer } from './study-ai.js';

export const READ_EVENT = 'pooja:block-read';
const SESSION_KEY = 'studySession';
const NUDGE_MS = 15000;
const MAX_PENDING = 12;

const $ = id => document.getElementById(id);
const state = { data: null, onCite: null, model: null, pending: [], log: {}, lastBlockId: null, nudgeTimer: null, aiBusy: false, aiQuestions: [] };

// ── Model, log and session ───────────────────────────────────────────────
function model() {
    if (!state.model) state.model = buildStudyModel(createIndex(state.data));
    return state.model;
}
const langs = () => loadSettings().langs;
const enabled = () => loadSettings().studyCompanion;

function saveSession() {
    try {
        sessionStorage.setItem(SESSION_KEY, JSON.stringify({
            open: !!$('study-drawer') && !$('study-drawer').hidden,
            pending: state.pending.filter(e => e.sug.desc).map(e => ({ desc: e.sug.desc, blockId: e.blockId })),
        }));
    } catch (_) { /* the panel just won't survive a reload */ }
}
function readSession() {
    try { const v = JSON.parse(sessionStorage.getItem(SESSION_KEY)); return v && typeof v === 'object' ? v : null; } catch (_) { return null; }
}

const makeEntry = (sug, blockId) => ({ sug, blockId, text: '', revealed: false, feedback: null, busy: false });

function addPending(sugs, blockId) {
    const fresh = sugs.filter(s => !state.pending.some(e => e.sug.id === s.id));
    state.pending = [...fresh.map(s => makeEntry(s, blockId)), ...state.pending].slice(0, MAX_PENDING);
    return fresh;
}

// ── Reacting to a tick ───────────────────────────────────────────────────
export function onBlockRead({ blockId, read }) {
    if (!enabled() || !read) return;
    state.lastBlockId = blockId;
    const sugs = suggestionsForRead(model(), blockId, { readSet: getReadBlocks(localStorage), done: state.log, langs: langs() });
    const fresh = addPending(sugs, blockId);
    updateBadge();
    saveSession();
    if (!fresh.length) return;
    if (drawerOpen()) render(); else showNudge(fresh[0]);
}

// ── Nudge ────────────────────────────────────────────────────────────────
function hideNudge() {
    clearTimeout(state.nudgeTimer);
    const n = $('study-nudge');
    if (n) n.hidden = true;
}
function showNudge(sug) {
    const n = $('study-nudge');
    if (!n) return;
    n.querySelector('.study-nudge-open').textContent = `\u{1F393} Test yourself: ${sug.title}`;
    n.hidden = false;
    clearTimeout(state.nudgeTimer);
    state.nudgeTimer = setTimeout(hideNudge, NUDGE_MS);
}

function updateBadge() {
    const b = $('study-badge');
    if (b) b.textContent = state.pending.length ? String(state.pending.length) : '';
}

// ── Drawer ───────────────────────────────────────────────────────────────
const drawerOpen = () => !!$('study-drawer') && !$('study-drawer').hidden;

export function openStudy() {
    const d = $('study-drawer');
    if (!d) return;
    closeAiDrawer();
    hideNudge();
    d.hidden = false;
    render();
    d.querySelector('.ai-close')?.focus();
    saveSession();
}
export function closeStudy() {
    const d = $('study-drawer');
    if (d) d.hidden = true;
    saveSession();
}

function el(tag, className, text) {
    const e = document.createElement(tag);
    if (className) e.className = className;
    if (text !== undefined) e.textContent = text;
    return e;
}

function cite(label, blockId) {
    const chip = el('button', 'ai-cite', label);
    chip.type = 'button';
    chip.title = 'Open this passage in the book';
    chip.addEventListener('click', () => state.onCite && state.onCite(blockId));
    return chip;
}

/** Text with [label] citations turned into chips (only labels that were really cited). */
function citedText(container, text, citations) {
    const byLabel = new Map(citations.map(c => [c.label, c.blockId]));
    text.split(/(\[[A-Za-z]-\d+\.\d+\])/).forEach(part => {
        const label = part.slice(1, -1);
        if (byLabel.has(label) && /^\[.+\]$/.test(part)) container.appendChild(cite(label, byLabel.get(label)));
        else if (part) container.appendChild(document.createTextNode(part));
    });
}

function passagesNode(passages) {
    const wrap = el('div', 'ai-sources');
    let topic;
    passages.forEach(p => {
        if (p.topic && p.topic !== topic) { topic = p.topic; wrap.appendChild(el('div', 'study-topic', `What the book says about ${topic}`)); }
        const card = el('div', 'ai-passage');
        card.appendChild(cite(p.label, p.id));
        Object.values(p.text).forEach(t => card.appendChild(el('div', 'ai-passage-text', t.length > 500 ? `${t.slice(0, 500).trimEnd()}\u2026` : t)));
        wrap.appendChild(card);
    });
    return wrap;
}

function finish(entry, status) {
    if (entry.sug.desc) {
        state.log = recordResult(state.log, entry.sug.id, entry.sug.desc, status);
        saveStudyLog(state.log, localStorage);
    }
    state.pending = state.pending.filter(e => e !== entry);
    state.aiQuestions = state.aiQuestions.filter(q => q !== entry);
    updateBadge();
    saveSession();
    render();
}

function cardNode(entry) {
    const { sug } = entry;
    const card = el('div', 'study-card');
    card.appendChild(el('div', 'study-kind', sug.kind === 'compare' ? 'Compare' : sug.kind === 'recall' ? 'Recall' : 'Question from the AI'));
    card.appendChild(el('div', 'study-prompt', sug.prompt));

    const box = el('textarea', 'study-answer');
    box.rows = 3;
    box.placeholder = 'Your answer (optional) / ನಿಮ್ಮ ಉತ್ತರ';
    box.value = entry.text;
    box.addEventListener('input', () => { entry.text = box.value; if (check) check.disabled = entry.busy || !box.value.trim(); });
    card.appendChild(box);

    const actions = el('div', 'study-actions');
    const show = el('button', 'study-primary', entry.revealed ? 'Hide the book\u2019s words' : 'Show what the book says');
    show.type = 'button';
    show.addEventListener('click', () => { entry.revealed = !entry.revealed; render(); });
    actions.appendChild(show);

    let check = null;
    const engine = getEngine(loadSettings().aiEngine);
    if (aiAvailable(engine)) {
        check = el('button', '', entry.busy ? 'Checking\u2026' : 'Check my answer (AI)');
        check.type = 'button';
        check.disabled = entry.busy || !entry.text.trim();
        check.title = 'Sends your answer and these passages to the AI assistant you chose in Settings';
        check.addEventListener('click', () => runCheck(entry, engine));
        actions.appendChild(check);
    }
    if (entry.revealed) {
        const got = el('button', '', 'I got it \u2713');
        got.type = 'button';
        got.addEventListener('click', () => finish(entry, 'got'));
        const again = el('button', '', 'Review later \u21BB');
        again.type = 'button';
        again.addEventListener('click', () => finish(entry, 'again'));
        actions.append(got, again);
    }
    card.appendChild(actions);

    if (entry.feedback) {
        const fb = el('div', 'study-feedback');
        if (entry.feedback.error) { fb.classList.add('ai-msg--error'); fb.textContent = entry.feedback.error; }
        else citedText(fb, entry.feedback.text, entry.feedback.citations);
        card.appendChild(fb);
    }
    if (entry.revealed) {
        if (sug.modelAnswer) {
            const a = el('div', 'study-feedback');
            citedText(a, sug.modelAnswer.text, sug.modelAnswer.citations);
            card.appendChild(a);
        }
        card.appendChild(passagesNode(sug.passages));
    }
    return card;
}

async function runCheck(entry, engine) {
    entry.busy = true;
    entry.feedback = null;
    render();
    try {
        const r = await checkAnswer({ engine, question: entry.sug.prompt, learnerAnswer: entry.text.trim(), passages: entry.sug.passages.map(p => ({ ...p, label: p.label })), langs: langs() });
        entry.feedback = r || { error: 'The AI couldn\u2019t give feedback it could back up with the book\u2019s text. Compare your answer with the passages below instead.' };
        if (!r) entry.revealed = true;
    } catch (err) {
        entry.feedback = { error: err?.message || 'Something went wrong.' };
    } finally {
        entry.busy = false;
        render();
    }
}

async function askAiForQuestion() {
    const engine = getEngine(loadSettings().aiEngine);
    if (!aiAvailable(engine) || state.aiBusy || !state.lastBlockId) return;
    const m = model();
    const chunk = m.chunkById.get(state.lastBlockId);
    if (!chunk) return;
    // Passages: what was just read, plus the book's best matches for its topics.
    const query = chunk.tags.join(' ');
    const sug = suggestionsForRead(m, state.lastBlockId, { readSet: new Set(), langs: langs(), max: 3 });
    const passages = [];
    [{ id: chunk.id, label: chunk.label, text: chunk.text }, ...sug.flatMap(s => s.passages)].forEach(p => {
        if (!p.text || passages.some(q => q.id === p.id) || passages.length >= 5) return;
        passages.push({ id: p.id, label: p.label, text: p.text });
    });
    if (!passages.length || !query) return;
    state.aiBusy = true;
    state.aiNote = 'Writing a question\u2026';
    render();
    try {
        const q = await generateQuestion({ engine, passages, langs: langs(), avoid: state.aiQuestions.map(e => e.sug.prompt) });
        if (q) {
            const entry = makeEntry({ id: `ai:${Date.now()}`, kind: 'ai', prompt: q.question, passages, modelAnswer: { text: q.answer, citations: q.citations } }, state.lastBlockId);
            state.aiQuestions.push(entry);
            state.pending = [entry, ...state.pending].slice(0, MAX_PENDING);
            state.aiNote = '';
        } else {
            state.aiNote = 'The AI didn\u2019t produce a question it could back up with the book\u2019s text. Try again.';
        }
    } catch (err) {
        state.aiNote = err?.message || 'Something went wrong.';
    } finally {
        state.aiBusy = false;
        updateBadge();
        render();
    }
}

function render() {
    const body = $('study-body');
    if (!body) return;
    body.replaceChildren();
    if (!state.pending.length) {
        body.appendChild(el('p', 'study-empty', 'Mark a section as read (the \u2713 at its corner) and questions about it will appear here. They come from the book\u2019s own text, so they work without any AI.'));
    }
    state.pending.forEach(e => body.appendChild(cardNode(e)));

    const engine = getEngine(loadSettings().aiEngine);
    if (aiAvailable(engine) && state.lastBlockId) {
        const more = el('button', 'study-more', state.aiBusy ? 'Writing a question\u2026' : '\u2728 Another question from the AI');
        more.type = 'button';
        more.disabled = state.aiBusy;
        more.title = 'Sends the passage you last marked as read, and related ones, to the AI assistant you chose in Settings';
        more.addEventListener('click', askAiForQuestion);
        body.appendChild(more);
        if (state.aiNote) body.appendChild(el('div', 'study-empty', state.aiNote));
    }

    const review = reviewList(state.log).map(r => ({ r, sug: buildSuggestion(model(), r.desc, { langs: langs() }) }))
        .filter(x => x.sug && !state.pending.some(e => e.sug.id === x.sug.id));
    if (review.length) {
        body.appendChild(el('div', 'study-section', `To review (${review.length})`));
        review.forEach(({ sug }) => {
            const row = el('div', 'study-card');
            row.appendChild(el('div', 'study-prompt', sug.title));
            const b = el('button', '', 'Practise again');
            b.type = 'button';
            b.addEventListener('click', () => { state.pending = [makeEntry(sug, null), ...state.pending].slice(0, MAX_PENDING); updateBadge(); saveSession(); render(); });
            const actions = el('div', 'study-actions');
            actions.appendChild(b);
            row.appendChild(actions);
            body.appendChild(row);
        });
    }
}

// ── Building the page furniture and the setting ───────────────────────────
function buildDrawer() {
    if ($('study-drawer')) return;
    const drawer = el('aside', 'ai-drawer study-drawer');
    drawer.id = 'study-drawer';
    drawer.hidden = true;
    drawer.setAttribute('aria-label', 'Study questions');
    const head = el('div', 'ai-head');
    const close = el('button', 'ai-close', '\u2715');
    close.type = 'button';
    close.setAttribute('aria-label', 'Close');
    close.addEventListener('click', closeStudy);
    head.append(el('strong', '', 'Study companion'), close);
    const body = el('div', 'study-body');
    body.id = 'study-body';
    body.setAttribute('aria-live', 'polite');
    const note = el('div', 'ai-disclaimer', 'Questions come from this book\u2019s own text. Check your answers against the passages, and ask a guru or scholar for guidance.');
    drawer.append(head, body, note);
    document.body.appendChild(drawer);
    drawer.style.setProperty('--ai-width', `${loadSettings().aiPanelWidth}px`);

    const nudge = el('div', 'study-nudge');
    nudge.id = 'study-nudge';
    nudge.hidden = true;
    nudge.setAttribute('role', 'status');
    const open = el('button', 'study-nudge-open');
    open.type = 'button';
    open.addEventListener('click', openStudy);
    const dismiss = el('button', 'study-nudge-dismiss', '\u2715');
    dismiss.type = 'button';
    dismiss.setAttribute('aria-label', 'Dismiss');
    dismiss.addEventListener('click', hideNudge);
    nudge.append(open, dismiss);
    document.body.appendChild(nudge);
}

/** Shows or hides the Study button and syncs both switches (header and Home) to the saved setting. */
export function applyStudySetting() {
    const on = enabled();
    ['toggle-study', 'home-toggle-study'].forEach(id => { const c = $(id); if (c) c.checked = on; });
    const btn = $('study-btn');
    if (btn) btn.hidden = !on;
    if (!on) { closeStudy(); hideNudge(); }
}

/**
 * @param {{data: Array, onCite: (blockId: string) => void}} args
 */
export function initStudy({ data, onCite }) {
    state.data = data;
    state.onCite = onCite;
    buildDrawer();
    state.log = loadStudyLog(localStorage);

    document.addEventListener(READ_EVENT, e => onBlockRead(e.detail || {}));
    $('study-btn')?.addEventListener('click', () => (drawerOpen() ? closeStudy() : openStudy()));
    $('ai-btn')?.addEventListener('click', () => closeStudy());
    document.addEventListener('keydown', e => { if (e.key === 'Escape') closeStudy(); });

    $('toggle-study')?.addEventListener('change', e => {
        saveSettings({ studyCompanion: e.target.checked });
        // Questions follow ticks, so the ticks must be visible.
        const rt = $('toggle-read-tracking');
        if (e.target.checked && rt && !rt.checked) { rt.checked = true; rt.dispatchEvent(new Event('change', { bubbles: true })); }
        applyStudySetting();
    });
    applyStudySetting();

    const saved = readSession();
    if (saved && enabled()) {
        saved.pending?.forEach?.(p => {
            const s = p?.desc && buildSuggestion(model(), p.desc, { langs: langs(), blockId: p.blockId });
            if (s) addPending([s], p.blockId);
        });
        updateBadge();
        if (saved.open) openStudy();
    }
}

// CommonJS shim for Jest
if (typeof module !== 'undefined' && module.exports) {
    Object.assign(module.exports, { READ_EVENT, onBlockRead, openStudy, closeStudy, applyStudySetting, initStudy });
}
