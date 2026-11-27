// header/omnibox.js — The header's one box for finding things.
//
// Typing still searches the book exactly as before (app.js filters the Continuous view / jumps to the first
// matching Book spread on keyup). This adds a small list of matching passages under the box, and — when the
// AI assistant is on — an "Ask AI" row that hands the typed text to the Ask panel (it is never sent by itself:
// the reader presses Ask there). On a phone the box is closed behind a search icon so it costs no space.

import { icon } from '../core/icons.js';
import { searchBlocks, MIN_QUERY_LENGTH } from '../core/search.js';

const PHONE_QUERY = '(max-width: 700px)';
const PLACEHOLDER_SEARCH = 'Search topics - ಅಭಿಷೇಕ, Daana...';
const PLACEHOLDER_ASK = 'Search, or ask AI a question';

/**
 * @param {Object} args
 * @param {Array} args.data
 * @param {() => string[]} args.getLangs         the reader's active language codes
 * @param {(blockId: string) => void} args.onPick   open a matching passage
 * @param {(question: string) => void} args.onAsk   hand a question to the Ask panel
 * @returns {{ draft: () => string, close: () => void }}
 */
export function initOmnibox({ data, getLangs, onPick, onAsk }) {
    const input = document.getElementById('search-bar');
    const menu = document.getElementById('omni-menu');
    const header = document.querySelector('.app-header');
    const toggle = document.getElementById('search-toggle');
    const back = document.getElementById('omni-back');
    const askChip = document.getElementById('ai-btn');
    if (!input || !menu) return { draft: () => '', close() {} };

    const isPhone = () => typeof window !== 'undefined' && window.matchMedia && window.matchMedia(PHONE_QUERY).matches;
    const askOn = () => !!askChip && !askChip.hidden;
    const draft = () => input.value.trim();

    // The box says what it can do: "ask" is only mentioned when the assistant is on.
    const syncPlaceholder = () => { input.placeholder = askOn() ? PLACEHOLDER_ASK : PLACEHOLDER_SEARCH; };
    syncPlaceholder();
    if (askChip && typeof MutationObserver !== 'undefined') {
        new MutationObserver(syncPlaceholder).observe(askChip, { attributes: true, attributeFilter: ['hidden'] });
    }

    const rows = () => [...menu.querySelectorAll('.omni-row')];
    const setActive = i => rows().forEach((r, n) => r.classList.toggle('is-active', n === i));

    function closeMenu() { menu.hidden = true; menu.replaceChildren(); }

    /** Empties the box and lets the view show everything again (app.js listens for keyup). */
    function clearSearch() {
        if (!input.value) return;
        input.value = '';
        input.dispatchEvent(new Event('keyup'));
    }

    function closeSearch({ clear = true } = {}) {
        closeMenu();
        if (clear) clearSearch();
        if (header) header.classList.remove('search-open');
        if (toggle) toggle.setAttribute('aria-expanded', 'false');
    }

    function openSearch() {
        if (header) header.classList.add('search-open');
        if (toggle) toggle.setAttribute('aria-expanded', 'true');
        input.focus();
    }

    function row(className, children, onClick) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = `omni-row ${className}`.trim();
        b.setAttribute('role', 'option');
        b.append(...children);
        b.addEventListener('click', onClick);
        return b;
    }

    function render() {
        const q = draft();
        if ([...q].length < MIN_QUERY_LENGTH) { closeMenu(); return; }

        const { total, results } = searchBlocks(data, q, getLangs(), 5);
        const parts = [];

        const head = document.createElement('div');
        head.className = askOn() && !total ? 'omni-empty' : 'omni-head';
        head.textContent = total ? `Topics · ${total} ${total === 1 ? 'match' : 'matches'}` : 'No topic matches';
        parts.push(head);

        results.forEach(r => {
            const text = document.createElement('span');
            text.className = 'omni-text';
            const mark = document.createElement('mark');
            mark.textContent = r.hit;
            text.append(r.before, mark, r.after);
            const label = document.createElement('span');
            label.className = 'omni-label';
            label.textContent = r.label;
            parts.push(row('omni-topic', [text, label], () => { closeSearch(); onPick(r.blockId); }));
        });

        if (askOn()) {
            const text = document.createElement('span');
            text.className = 'omni-text';
            text.textContent = `Ask AI: \u201C${q}\u201D`;
            const go = icon(document, 'arrow-right', 18);
            const sparkle = icon(document, 'sparkles', 18);
            parts.push(row('omni-ask', [sparkle, text, go], () => handOff(q)));
        }

        menu.replaceChildren(...parts);
        menu.hidden = false;
    }

    /** Gives the question to the Ask panel and tidies the search box away. */
    function handOff(question) {
        closeSearch();
        onAsk(question);
    }

    input.addEventListener('input', render);
    input.addEventListener('focus', () => { if (draft()) render(); });
    input.addEventListener('keydown', e => {
        if (e.key === 'Escape') { if (!menu.hidden || isPhone()) { e.stopPropagation(); closeSearch({ clear: isPhone() }); } return; }
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && askOn() && draft()) { e.preventDefault(); handOff(draft()); return; }
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            const r = rows();
            if (!r.length) return;
            e.preventDefault();
            const at = r.findIndex(x => x.classList.contains('is-active'));
            const next = e.key === 'ArrowDown' ? (at + 1) % r.length : (at - 1 + r.length) % r.length;
            setActive(next);
            r[next].scrollIntoView?.({ block: 'nearest' });
        }
        if (e.key === 'Enter') {
            const active = rows().find(x => x.classList.contains('is-active'));
            if (active) { e.preventDefault(); active.click(); }
        }
    });

    // Anywhere else on the page closes the list (the text stays, and so does the filter).
    document.addEventListener('click', e => {
        if (menu.hidden) return;
        if (!menu.contains(e.target) && e.target !== input && !(askChip && askChip.contains(e.target))) closeMenu();
    });

    if (toggle) toggle.addEventListener('click', openSearch);
    if (back) back.addEventListener('click', () => closeSearch());

    // Turning the phone sideways (or resizing) must not leave the header stuck in its search state.
    if (typeof window !== 'undefined' && window.matchMedia) {
        window.matchMedia(PHONE_QUERY).addEventListener?.('change', e => { if (!e.matches) closeSearch({ clear: false }); });
    }

    return { draft, close: () => closeSearch() };
}

// CommonJS shim for Jest
if (typeof module !== 'undefined' && module.exports) Object.assign(module.exports, { initOmnibox });
