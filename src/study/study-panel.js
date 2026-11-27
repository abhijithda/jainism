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
import { closeDrawer as closeAiDrawer, buildResizeHandle, setPanelWidth, currentPanelWidth, WIDE_PANEL } from '../ai/ai-panel.js';
import { AI_PANEL_WIDTH_DEFAULT } from '../core/settings.js';
import { buildStudyModel, buildSuggestion, suggestionsForRead, blockText } from './study-questions.js';
import { createStudyConfig } from './study-config.js';
import { loadStudyLog, saveStudyLog, recordResult, reviewList } from './study-log.js';
import { aiAvailable, generateQuestion, checkAnswer } from './study-ai.js';

export const READ_EVENT = 'pooja:block-read';
const SESSION_KEY = 'studySession';
const NUDGE_MS = 15000;
const MAX_PENDING = 6;      // waiting in the queue
const VISIBLE_CARDS = 2;    // shown at once: more than that is too much to take in

const $ = id => document.getElementById(id);
const state = { data: null, config: null, onCite: null, model: null, pending: [], log: {}, lastBlockId: null, nudgeTimer: null, aiBusy: false, aiQuestions: [], aiAsked: [], aiFocusUsed: new Set(), sessionReads: [], showAll: false };

// ── Model, log and session ───────────────────────────────────────────────
function model() {
    if (!state.model) state.model = buildStudyModel(createIndex(state.data), state.config);
    return state.model;
}
const langs = () => loadSettings().langs;
const enabled = () => loadSettings().studyCompanion;

function saveSession() {
    try {
        sessionStorage.setItem(SESSION_KEY, JSON.stringify({
            open: !!$('study-drawer') && !$('study-drawer').hidden,
            pending: state.pending.filter(e => e.sug.desc).map(e => ({ desc: e.sug.desc, blockId: e.blockId, text: e.text })),   // typed answers too (this tab only)
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
    state.sessionReads = [...state.sessionReads.filter(id => id !== blockId), blockId];   // most recent last
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
    d.style.setProperty('--ai-width', `${loadSettings().aiPanelWidth}px`);   // the width shared with the Ask panel
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
        // Lets sync hear about it without this file knowing it.
        document.dispatchEvent(new CustomEvent('pooja:study-logged', { detail: { id: entry.sug.id } }));
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
    card.appendChild(el('div', 'study-kind', sug.kind === 'compare' ? 'Compare' : sug.kind === 'recall' ? 'Recall' : `Question from the AI${sug.focusLabel ? ` \u00B7 about ${sug.focusLabel}` : ''}`));
    const prompt = el('div', 'study-prompt');
    (sug.promptLines?.length ? sug.promptLines : [{ lang: '', text: sug.prompt }]).forEach(line => {
        const row = el('div', 'study-prompt-line', line.text);
        if (line.lang) row.lang = line.lang;
        prompt.appendChild(row);
    });
    card.appendChild(prompt);

    const box = el('textarea', 'study-answer');
    box.rows = 3;
    box.placeholder = 'Your answer (optional) / ನಿಮ್ಮ ಉತ್ತರ';
    box.value = entry.text;
    box.addEventListener('input', () => { entry.text = box.value; saveSession(); if (check) check.disabled = entry.busy || !box.value.trim(); });
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

// ── "Another question from the AI": a different part of what was read each time ──
const normalise = q => String(q).toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);
/** The same question again, or nearly (most of the same words). */
function seenBefore(question) {
    const a = new Set(normalise(question));
    return state.aiAsked.some(prev => {
        const b = new Set(normalise(prev));
        const common = [...a].filter(w => b.has(w)).length;
        return common / Math.max(a.size, b.size, 1) >= 0.8;
    });
}

/** Blocks the reader has read that have text to ask about: most recently marked first, then book order. */
function focusCandidates() {
    if (!state.data) return [];
    const m = model();
    const read = getReadBlocks(localStorage);
    const ok = id => { const c = m.chunkById.get(id); return read.has(id) && c && !c.textless; };
    const recent = [...state.sessionReads].reverse().filter(ok);
    const rest = m.index.chunks.map(c => c.id).filter(id => ok(id) && !recent.includes(id));
    return [...recent, ...rest];
}

/** The passages for one question: the focus block, the rest of its item that is read, and (if it has one) its comparison. All read. */
function passagesAround(focusId) {
    const m = model();
    const read = getReadBlocks(localStorage);
    const chunk = m.chunkById.get(focusId);
    const sameItem = (m.blockItem.get(focusId)?.blocks || []).map(b => m.chunkById.get(b.id)).filter(c => c && !c.textless && read.has(c.id));
    const sug = suggestionsForRead(m, focusId, { readSet: read, langs: langs(), max: 1 });
    const passages = [];
    [chunk, ...sug.flatMap(x => x.passages), ...sameItem].forEach(p => {
        if (!p || !p.text || passages.some(q => q.id === p.id) || passages.length >= 5) return;
        passages.push({ id: p.id, label: p.label, text: p.text });
    });
    return passages;
}

const MAX_AI_TRIES = 3;

async function askAiForQuestion() {
    const engine = getEngine(loadSettings().aiEngine);
    if (!aiAvailable(engine) || state.aiBusy) return;
    const candidates = focusCandidates();
    if (!candidates.length) return;
    state.aiBusy = true;
    state.aiNote = '';
    render();
    try {
        for (let tries = 0; tries < MAX_AI_TRIES; tries++) {
            // Next part not used yet; when all have been used, start over.
            let focus = candidates.find(id => !state.aiFocusUsed.has(id));
            if (!focus) { state.aiFocusUsed = new Set(); focus = candidates[0]; }
            state.aiFocusUsed.add(focus);
            const passages = passagesAround(focus);
            if (!passages.length) continue;
            const q = await generateQuestion({ engine, passages, langs: langs(), avoid: state.aiAsked.slice(-10) });
            if (!q) { state.aiNote = 'The AI didn\u2019t produce a question it could back up with the book\u2019s text. Try again.'; continue; }
            if (seenBefore(q.question)) { state.aiNote = 'The AI gave a question you have already had. Try again, or mark more sections as read.'; continue; }
            state.aiAsked.push(q.question);
            const label = model().chunkById.get(focus)?.label;
            const entry = makeEntry({ id: `ai:${Date.now()}`, kind: 'ai', prompt: q.question, passages, focusLabel: label, modelAnswer: { text: q.answer, citations: q.citations } }, focus);
            state.aiQuestions.push(entry);
            state.pending = [entry, ...state.pending].slice(0, MAX_PENDING);
            state.aiNote = '';
            break;
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
    const shown = state.showAll ? state.pending : state.pending.slice(0, VISIBLE_CARDS);
    shown.forEach(e => body.appendChild(cardNode(e)));
    if (state.pending.length > VISIBLE_CARDS) {
        const n = state.pending.length - VISIBLE_CARDS;
        const toggle = el('button', 'study-more', state.showAll ? 'Show fewer' : `${n} more waiting \u2014 show`);
        toggle.type = 'button';
        toggle.addEventListener('click', () => { state.showAll = !state.showAll; render(); });
        body.appendChild(toggle);
    }

    const engine = getEngine(loadSettings().aiEngine);
    if (aiAvailable(engine) && focusCandidates().length) {
        const more = el('button', 'study-more', state.aiBusy ? 'Writing a question\u2026' : '\u2728 Another question from the AI');
        more.type = 'button';
        more.disabled = state.aiBusy;
        more.title = 'Sends a passage you have marked as read (a different one each time), and related read passages, to the AI assistant you chose in Settings';
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
    // Same width controls as the Ask panel (and the same saved width): drag the left edge, or the \u2922 button.
    const expand = el('button', 'ai-expand', '\u2922');
    expand.type = 'button';
    expand.title = 'Wider / narrower';
    expand.setAttribute('aria-label', 'Make the panel wider or narrower');
    expand.addEventListener('click', () => setPanelWidth(currentPanelWidth() < 700 ? WIDE_PANEL : AI_PANEL_WIDTH_DEFAULT));
    head.append(el('strong', '', 'Study companion'), expand, close);
    const body = el('div', 'study-body');
    body.id = 'study-body';
    body.setAttribute('aria-live', 'polite');
    const note = el('div', 'ai-disclaimer', 'Questions come from this book\u2019s own text. Check your answers against the passages, shlokas and videos in the book.');
    drawer.append(buildResizeHandle('study-resize', 'Resize the study panel (drag, or use the arrow keys)'), head, body, note);
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

const RT_SWITCHES = ['toggle-read-tracking', 'home-toggle-read-tracking'];
const LOCK_NOTES = ['rt-lock-note', 'home-rt-lock-note'];
const LOCK_TEXT = 'Read tracking stays on while the study companion is on. Switch Study off to change it.';

/** A refused click on the locked Read tracking switch: highlight the note that explains why. */
function flashLockNote() {
    LOCK_NOTES.forEach(id => {
        const n = $(id);
        if (!n || n.hidden) return;
        n.classList.add('rt-lock-flash');
        n.textContent = '';
        n.textContent = LOCK_TEXT;          // re-announced by the status region
        setTimeout(() => n.classList.remove('rt-lock-flash'), 1400);
    });
}

/**
 * Shows or hides the Study button and syncs both switches (header and Home) to the saved setting.
 * Study needs the ✓ ticks, so while it is on, Read tracking is switched on and locked (both places).
 * That also repairs a saved "Study on, Read tracking off" (e.g. from an older version, or another tab).
 */
export function applyStudySetting() {
    const on = enabled();
    ['toggle-study', 'home-toggle-study'].forEach(id => { const c = $(id); if (c) c.checked = on; });
    const btn = $('study-btn');
    if (btn) btn.hidden = !on;
    if (on) {
        const rt = $('toggle-read-tracking');
        if (rt && !rt.checked) { rt.checked = true; rt.dispatchEvent(new Event('change', { bubbles: true })); }   // the header saves it and shows the ticks
        else if (!rt && !loadSettings().readTracking) saveSettings({ readTracking: true });
    }
    RT_SWITCHES.forEach(id => {
        const c = $(id);
        if (!c) return;
        if (on) c.checked = true;
        // Not `disabled`: a disabled switch ignores clicks silently. A locked one refuses them and says why.
        c.dataset.locked = on ? '1' : '';
        c.setAttribute('aria-disabled', String(on));
        c.title = on ? LOCK_TEXT : '';
    });
    LOCK_NOTES.forEach(id => { const n = $(id); if (n) { n.textContent = LOCK_TEXT; n.hidden = !on; } });
    if (!on) { closeStudy(); hideNudge(); }
}

/** Reloads the saved log after sync stored another device's answers (so the next answer does not overwrite them). */
export function refreshStudyLog() {
    state.log = loadStudyLog(localStorage);
    updateBadge();
    if (drawerOpen()) render();
}

/**
 * @param {{data: Array, onCite: (blockId: string) => void, config?: Object}} args  config: from loadStudyConfig()
 */
export function initStudy({ data, onCite, config }) {
    state.data = data;
    state.config = config || createStudyConfig({});   // the book's names, aliases and title words (study-config.json)
    state.onCite = onCite;
    buildDrawer();
    state.log = loadStudyLog(localStorage);

    document.addEventListener(READ_EVENT, e => onBlockRead(e.detail || {}));
    document.addEventListener('click', e => {
        const t = e.target;
        if (t?.dataset?.locked === '1' && RT_SWITCHES.includes(t.id)) { e.preventDefault(); flashLockNote(); }
    }, true);
    $('study-btn')?.addEventListener('click', () => (drawerOpen() ? closeStudy() : openStudy()));
    $('ai-btn')?.addEventListener('click', () => closeStudy());
    document.addEventListener('keydown', e => { if (e.key === 'Escape') closeStudy(); });

    $('toggle-study')?.addEventListener('change', e => {
        saveSettings({ studyCompanion: e.target.checked });
        applyStudySetting();   // also switches Read tracking on and locks it (questions follow the ticks)
    });
    applyStudySetting();

    const saved = readSession();
    if (saved && enabled()) {
        saved.pending?.forEach?.(p => {
            const s = p?.desc && buildSuggestion(model(), p.desc, { langs: langs(), blockId: p.blockId, readSet: getReadBlocks(localStorage) });
            if (!s) return;
            const [added] = addPending([s], p.blockId);
            const entry = added && state.pending.find(e => e.sug.id === s.id);
            if (entry && typeof p.text === 'string') entry.text = p.text;
        });
        updateBadge();
        if (saved.open) openStudy();
    }
}

// CommonJS shim for Jest
if (typeof module !== 'undefined' && module.exports) {
    Object.assign(module.exports, { READ_EVENT, onBlockRead, openStudy, closeStudy, applyStudySetting, initStudy });
}
