// core/segmented.js — Turns a <select> with a few options into a row of buttons ("Off | Cloud | Local").
//
// The <select> stays in the page (visually hidden, still the source of truth), so every piece of code that reads
// select.value, listens for 'change', or sets select.value keeps working unchanged. Clicking a button sets the
// select's value and fires its 'change' event; setting select.value from code (Home mirrors the header this way,
// and without an event) updates the buttons too.

// select -> its "redraw the buttons" function.
const refreshers = new WeakMap();
let patched = false;

/**
 * Makes `select.value = x` (done by code such as Home's mirror, without any event) redraw that select's buttons.
 * Patched once, on the prototype, because a browser (and jsdom) will not take a per-element override of `value`.
 */
function watchValueSetter() {
    if (patched || typeof HTMLSelectElement === 'undefined') return;
    patched = true;
    const proto = HTMLSelectElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (!desc || !desc.set) return;
    Object.defineProperty(proto, 'value', {
        configurable: true,
        enumerable: desc.enumerable,
        get: desc.get,
        set(v) {
            desc.set.call(this, v);
            const redraw = refreshers.get(this);
            if (redraw) redraw();
        },
    });
}

/** @param {HTMLSelectElement|null} select */
export function enhanceSegmented(select) {
    if (!select || select.dataset.segmented) return;
    select.dataset.segmented = '1';
    const doc = select.ownerDocument;

    const group = doc.createElement('div');
    group.className = 'seg';
    group.setAttribute('role', 'radiogroup');
    const label = select.labels && select.labels[0];
    group.setAttribute('aria-label', (label && label.firstChild && label.firstChild.textContent.trim()) || select.getAttribute('aria-label') || 'Choose one');

    const buttons = [...select.options].map(opt => {
        const b = doc.createElement('button');
        b.type = 'button';
        b.setAttribute('role', 'radio');
        b.dataset.value = opt.value;
        b.textContent = opt.textContent;
        b.addEventListener('click', () => {
            if (select.value === opt.value) return;
            select.value = opt.value;
            select.dispatchEvent(new Event('change', { bubbles: true }));
        });
        group.appendChild(b);
        return b;
    });

    const refresh = () => buttons.forEach(b => {
        const on = b.dataset.value === select.value;
        b.setAttribute('aria-checked', String(on));
        b.tabIndex = on ? 0 : -1;
    });

    // Arrow keys move between the choices, like any radio group.
    group.addEventListener('keydown', e => {
        const i = buttons.findIndex(b => b.getAttribute('aria-checked') === 'true');
        const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
        if (!step) return;
        e.preventDefault();
        const next = buttons[(i + step + buttons.length) % buttons.length];
        next.click();
        next.focus();
    });

    // Setting select.value from code does not fire 'change'; follow it anyway (see watchValueSetter).
    watchValueSetter();
    refreshers.set(select, refresh);
    select.addEventListener('change', refresh);

    select.classList.add('seg-source');
    select.tabIndex = -1;
    select.setAttribute('aria-hidden', 'true');
    select.after(group);
    refresh();
}

/** Applies enhanceSegmented to every select named by id that exists in the page. */
export function initSegmented(ids) {
    ids.forEach(id => enhanceSegmented(document.getElementById(id)));
}

// CommonJS shim for Jest
if (typeof module !== 'undefined' && module.exports) Object.assign(module.exports, { enhanceSegmented, initSegmented });
