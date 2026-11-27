// header/progress-button.js — The reading-progress button (a ring) and the small card it opens.
//
// The ring and the count are filled in by core/read-tracking.js (updateProgressDisplay). This file only
// opens/closes the card and keeps the Study questions row in it in step with the real Study button
// (#study-btn, owned by study/study-panel.js): same visibility, same count, and pressing the row presses it.
// On a phone the real Study button is hidden and this row is the way in; the ring carries the same count.

/** Wires the ring button, its card and the Study row. Safe to call when the markup is absent. */
export function initProgressButton() {
    const btn = document.getElementById('progress-btn');
    const pop = document.getElementById('progress-pop');
    if (!btn || !pop) return;

    const study = document.getElementById('study-btn');
    const studyBadge = document.getElementById('study-badge');
    const popRow = document.getElementById('study-btn-pop');
    const popBadge = document.getElementById('study-badge-pop');
    const ringBadge = document.getElementById('progress-badge');

    const setOpen = open => {
        pop.hidden = !open;
        btn.setAttribute('aria-expanded', String(open));
    };

    btn.addEventListener('click', e => { e.stopPropagation(); setOpen(pop.hidden); });
    document.addEventListener('click', e => { if (!pop.hidden && !pop.contains(e.target)) setOpen(false); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && !pop.hidden) { setOpen(false); btn.focus(); } });

    function mirror() {
        const count = studyBadge ? studyBadge.textContent : '';
        if (popRow && study) popRow.hidden = study.hidden;
        if (popBadge) popBadge.textContent = count;
        if (ringBadge) ringBadge.textContent = study && !study.hidden ? count : '';
    }

    if (popRow && study) {
        popRow.addEventListener('click', () => { setOpen(false); study.click(); });
        if (typeof MutationObserver !== 'undefined') {
            const watch = new MutationObserver(mirror);
            watch.observe(study, { attributes: true, attributeFilter: ['hidden'] });
            if (studyBadge) watch.observe(studyBadge, { childList: true, characterData: true, subtree: true });
        }
    }
    mirror();
}

// CommonJS shim for Jest
if (typeof module !== 'undefined' && module.exports) Object.assign(module.exports, { initProgressButton });
