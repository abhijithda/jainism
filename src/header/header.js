// header.js — Header UI: language picker, media/QR toggles, read-tracking,
// settings dropdown. The persisted settings object lives in
// core/settings.js; paper size and font scale each have their own module
// (core/paper-size.js, core/font-scale.js) — see those for how each
// setting is validated, applied, and wired to its control. Re-exported
// here so callers (app.js) have one import path for everything
// header-related.

import { KNOWN_LANGS, MAX_ACTIVE_LANGS } from '../core/langs.js';
import { SETTINGS_KEY, loadSettings, saveSettings } from '../core/settings.js';
import { PAPER_SIZES, applyPaperSize, initPaperSizeControl } from '../core/paper-size.js';
import {
    FONT_SCALE_MIN, FONT_SCALE_MAX, FONT_SCALE_STEP,
    applyFontScale, changeFontScale, initFontScaleControl,
} from '../core/font-scale.js';

import { initSegmented } from '../core/segmented.js';

export { SETTINGS_KEY, loadSettings, saveSettings };
export { PAPER_SIZES, applyPaperSize, initPaperSizeControl };
export { FONT_SCALE_MIN, FONT_SCALE_MAX, FONT_SCALE_STEP, applyFontScale, changeFontScale, initFontScaleControl };

/** Reads current settings and pushes them onto the header controls (checkboxes, paper size, font scale). */
export function applySettings() {
    const saved              = loadSettings();
    const toggleVideos       = document.getElementById('toggle-videos');
    const toggleQrs          = document.getElementById('toggle-qrs');
    const toggleReadTracking = document.getElementById('toggle-read-tracking');

    if (toggleVideos)       toggleVideos.checked       = saved.videos;
    if (toggleQrs)          toggleQrs.checked          = saved.qrs;
    if (toggleReadTracking) toggleReadTracking.checked = saved.readTracking;
    // Lang checkboxes are built by initLangPicker itself, reading loadSettings().langs.

    applyPaperSize();
    applyFontScale();
}

// ── Lang picker ───────────────────────────────────────────────────────────
// Searchable, collapsible multi-select — scales past a couple of languages
// (e.g. adding more Indian languages later) without turning the settings
// menu into a wall of checkboxes.

export function getActiveLangs() {
    return loadSettings().langs;
}

export function saveActiveLangs(langs) {
    saveSettings({ langs });
}

/**
 * Wire up the searchable, collapsible multi-select lang picker.
 * Expects this markup inside the Settings menu (see index.html):
 *   #lang-trigger  (button — shows a summary, toggles #lang-panel)
 *   #lang-summary  (span inside the trigger)
 *   #lang-panel    (hidden by default)
 *   #lang-search   (text input inside the panel)
 *   #lang-list     (checkbox rows render here)
 * Calls onLangChange(activeLangs[]) whenever selection changes.
 * The same picker is on Home too: `prefix` ('home-') gives that copy its own element ids, and a change in either
 * redraws the other, so the two always agree.
 * At least one and at most MAX_ACTIVE_LANGS (two) languages are active: with
 * two active, the other rows are disabled until one of them is unchecked. What
 * is selected here is what the views show and what gets printed.
 */
const langPickers = new Map();   // prefix -> { refresh }: every picker on the page

/** Redraws every language picker from the saved settings (used when something else may have changed them). */
export function refreshLangPickers() {
    langPickers.forEach(p => p.refresh());
}

export function initLangPicker(onLangChange, prefix = '') {
    const trigger = document.getElementById(`${prefix}lang-trigger`);
    const summary = document.getElementById(`${prefix}lang-summary`);
    const panel   = document.getElementById(`${prefix}lang-panel`);
    const search  = document.getElementById(`${prefix}lang-search`);
    const list    = document.getElementById(`${prefix}lang-list`);
    if (!trigger || !panel || !list) return;

    function updateSummary() {
        if (!summary) return;
        const active = getActiveLangs();
        const names = KNOWN_LANGS.filter(l => active.includes(l.code)).map(l => l.label);
        summary.textContent = names.length ? names.join(', ') : 'Select a language';
    }

    /** Disable the unchecked rows while two languages are chosen, on the existing inputs (the focus stays where it is). */
    function refreshDisabled() {
        const n = getActiveLangs().length;
        list.querySelectorAll('input[type="checkbox"]').forEach((c) => { c.disabled = !c.checked && n >= MAX_ACTIVE_LANGS; });
    }

    function renderList(filter) {
        const q = (filter || '').trim().toLowerCase();
        list.innerHTML = '';

        const matches = KNOWN_LANGS.filter(lang =>
            lang.label.toLowerCase().includes(q) || lang.name.toLowerCase().includes(q)
        );

        matches.forEach((lang, i) => {
            if (!q && i > 0 && lang.future && !matches[i - 1].future) {
                const div = document.createElement('div');
                div.className = 'lang-divider';
                list.appendChild(div);
            }

            const row = document.createElement('label');
            row.className = 'lang-row';
            row.htmlFor = `${prefix}lang-chk-${lang.code}`;

            const chk = document.createElement('input');
            chk.type = 'checkbox';
            chk.id   = `${prefix}lang-chk-${lang.code}`;
            chk.checked = getActiveLangs().includes(lang.code);
            chk.disabled = !chk.checked && getActiveLangs().length >= MAX_ACTIVE_LANGS;

            const labelText = document.createElement('span');
            labelText.className = 'lang-row-label';
            labelText.textContent = lang.label;

            const nameText = document.createElement('span');
            nameText.className = 'lang-row-name';
            nameText.textContent = lang.name;

            row.appendChild(chk);
            row.appendChild(labelText);
            row.appendChild(nameText);
            list.appendChild(row);

            chk.addEventListener('change', () => {
                const newActive = KNOWN_LANGS
                    .filter(l => document.getElementById(`${prefix}lang-chk-${l.code}`)?.checked
                        ?? getActiveLangs().includes(l.code)) // langs filtered out of view keep their prior state
                    .map(l => l.code);

                if (newActive.length === 0) {
                    chk.checked = true; // enforce at least one active lang
                    return;
                }

                if (newActive.length > MAX_ACTIVE_LANGS) {
                    chk.checked = false; // never more than two at once
                    return;
                }

                saveActiveLangs(newActive);
                updateSummary();
                refreshDisabled(); // in place: re-rendering the list would drop the keyboard focus from the box just toggled
                langPickers.forEach((p, key) => { if (key !== prefix) p.refresh(); });   // the other copy follows
                if (onLangChange) onLangChange(newActive);
            });
        });

        if (!matches.length) {
            const empty = document.createElement('div');
            empty.className = 'lang-empty';
            empty.textContent = 'No languages match';
            list.appendChild(empty);
        } else {
            const hint = document.createElement('div');
            hint.className = 'lang-hint';
            hint.textContent = `Choose up to ${MAX_ACTIVE_LANGS} languages. Uncheck one to pick another.`;
            list.appendChild(hint);
        }
    }

    function openPanel() {
        panel.hidden = false;
        trigger.setAttribute('aria-expanded', 'true');
        if (search) search.focus();
    }
    function closePanel() {
        panel.hidden = true;
        trigger.setAttribute('aria-expanded', 'false');
        if (search) search.value = '';
        renderList('');
    }

    trigger.onclick = (e) => {
        e.stopPropagation();
        if (panel.hidden) openPanel(); else closePanel();
    };

    document.addEventListener('click', (e) => {
        if (!panel.hidden && !panel.contains(e.target) && e.target !== trigger) {
            closePanel();
        }
    });

    if (search) search.addEventListener('input', () => renderList(search.value));

    renderList('');
    updateSummary();
    langPickers.set(prefix, { refresh: () => { updateSummary(); renderList(search ? search.value : ''); } });
}

// ── Media visibility ──────────────────────────────────────────────────────

export function updateMediaVisibility() {
    const toggleVideos = document.getElementById('toggle-videos');
    const toggleQrs    = document.getElementById('toggle-qrs');
    const showVideos   = toggleVideos ? toggleVideos.checked : false;
    const showQrs      = toggleQrs    ? toggleQrs.checked    : false;

    document.body.classList.toggle('show-videos', showVideos);
    document.body.classList.toggle('show-qrs',    showQrs);

    document.querySelectorAll('.video-card').forEach(el => {
        el.style.display = showVideos ? '' : 'none';
    });
    document.querySelectorAll('.qr-code').forEach(el => {
        el.style.display = showQrs ? '' : 'none';
    });

    saveSettings({ videos: showVideos, qrs: showQrs });
}

export function updateReadTrackingVisibility() {
    const toggle = document.getElementById('toggle-read-tracking');
    const readTracking = toggle ? toggle.checked : false;
    document.body.classList.toggle('show-read-tracking', readTracking);
    saveSettings({ readTracking });
}

// ── Settings dropdown ─────────────────────────────────────────────────────

export function initHeaderDropdown() {
    const btn  = document.getElementById('settings-btn');
    const menu = document.getElementById('settings-menu');
    const closeBtn = document.getElementById('settings-close');
    if (!btn || !menu) return;

    // body.settings-open dims the page behind the sheet on a phone (header.css); it does nothing on desktop.
    const setOpen = (open) => {
        menu.style.display = open ? 'block' : 'none';
        document.body.classList.toggle('settings-open', open);
        btn.setAttribute('aria-expanded', String(open));
    };

    btn.onclick = (e) => {
        e.stopPropagation();
        setOpen(menu.style.display !== 'block');
    };
    if (closeBtn) closeBtn.addEventListener('click', () => setOpen(false));
    document.addEventListener('click', (e) => {
        if (menu && menu.style.display === 'block' && !menu.contains(e.target) && !btn.contains(e.target)) {
            setOpen(false);
        }
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && menu.style.display === 'block') setOpen(false);
    });
}

/**
 * Initialize all header controls.
 * @param {Function} onLangChange  - callback(activeLangs[]) on lang change
 * @param {Function} [onReadToggle] - callback when read-tracking toggle changes
 */
// ── Full screen / zen mode ─────────────────────────────────────────────────────
// Hides the header and, best-effort, requests real browser Fullscreen so
// the browser's own chrome gets out of the way too — see the CSS comment
// on body.zen-mode in header.css for why Fullscreen is optional rather
// than required. A separate peek button (body.zen-header-visible) lets the
// header be shown/hidden again on demand without leaving zen mode/dropping
// Fullscreen — the exit button alone was all-or-nothing, too heavy just to
// glance at Settings. Deliberately not persisted (see the same comment):
// requestFullscreen() needs a fresh user gesture on every load anyway, so
// there's nothing meaningful to restore.
export function initZenModeControl() {
    const enterBtn = document.getElementById('zen-mode-btn');
    const exitBtn  = document.getElementById('zen-exit-btn');
    const peekBtn  = document.getElementById('zen-peek-btn');

    function setZenClass(on) {
        document.body.classList.toggle('zen-mode', on);
        if (exitBtn) exitBtn.hidden = !on;
        if (peekBtn) peekBtn.hidden = !on;
        if (!on) document.body.classList.remove('zen-header-visible');
    }

    async function enterZen() {
        setZenClass(true);
        try {
            if (document.documentElement.requestFullscreen) {
                await document.documentElement.requestFullscreen();
            }
        } catch (_) {
            // Denied or unsupported (iframe, no user gesture, etc.) — the
            // header is still hidden regardless, so the main
            // distraction-free effect doesn't depend on this succeeding.
        }
    }

    async function exitZen() {
        setZenClass(false);
        try {
            if (document.fullscreenElement && document.exitFullscreen) {
                await document.exitFullscreen();
            }
        } catch (_) {}
    }

    if (enterBtn) enterBtn.addEventListener('click', () => {
        // The button is only ever clickable in two states: not in zen mode
        // (normal header) or peeked-open (header temporarily shown while
        // still in zen mode) — in the latter case "enter" is a no-op
        // (already there), which reads as a dead button. Toggle instead.
        if (document.body.classList.contains('zen-mode')) {
            exitZen();
        } else {
            enterZen();
        }
    });
    if (exitBtn)  exitBtn.addEventListener('click', exitZen);
    if (peekBtn)  peekBtn.addEventListener('click', () => {
        document.body.classList.toggle('zen-header-visible');
    });

    // If real fullscreen was entered and the user exits it some other way
    // (Esc, F11, browser UI) rather than our own exit button, keep the
    // header's hidden state in sync instead of leaving no way back in.
    if (typeof document.addEventListener === 'function') {
        document.addEventListener('fullscreenchange', () => {
            if (!document.fullscreenElement) setZenClass(false);
        });

        // Also handle Escape when fullscreen was never actually entered
        // (e.g. the request above was denied) — the browser only
        // auto-handles Escape for its own real fullscreen state.
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && document.body.classList.contains('zen-mode')) {
                exitZen();
            }
        });
    }
}

export function initHeaderControls(onLangChange, onReadToggle) {
    applySettings();

    const toggleVideos       = document.getElementById('toggle-videos');
    const toggleQrs          = document.getElementById('toggle-qrs');
    const toggleReadTracking = document.getElementById('toggle-read-tracking');

    if (toggleVideos)       toggleVideos.addEventListener('change', updateMediaVisibility);
    if (toggleQrs)          toggleQrs.addEventListener('change', updateMediaVisibility);
    if (toggleReadTracking) toggleReadTracking.addEventListener('change', () => {
        updateReadTrackingVisibility();
        if (onReadToggle) onReadToggle();
    });

    initLangPicker(onLangChange);
    initLangPicker(onLangChange, 'home-');   // the same picker on the Home page
    initHeaderDropdown();
    initPaperSizeControl();
    initFontScaleControl();
    // The page-size and AI choices are a row of buttons instead of a drop-down (the <select> stays underneath).
    initSegmented(['paper-size-select', 'home-paper-size-select', 'ai-engine-select', 'home-ai-engine-select']);
    initZenModeControl();
    updateMediaVisibility();
    updateReadTrackingVisibility();
}

// Note: no manual CommonJS re-export shim — see paper-size.js for why (this
// file re-exports bindings from settings.js/paper-size.js/font-scale.js,
// which a manual Object.assign(module.exports, {...}) can't overwrite;
// babel's transform already handles every export here, local or re-exported).
