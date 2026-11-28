jest.mock('./config.js', () => ({ ...jest.requireActual('./config.js'), CLOUD_ENDPOINT: '' }));

const { initAi, askWith, openDrawer } = require('./ai-panel');

beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    document.body.innerHTML = `
        <button id="ai-btn"></button>
        <select id="ai-engine-select"><option value="off"></option><option value="cloud"></option><option value="local"></option></select>
        <span id="ai-engine-note"></span>`;
});

const input = () => document.getElementById('ai-input');
const drawer = () => document.getElementById('ai-drawer');

describe('Ask AI panel: question arriving from the header search box', () => {
    test('askWith opens the panel with the question typed in but not sent', () => {
        initAi({ data: [], onCite() {} });
        askWith('why is abhisheka done?');
        expect(drawer().hidden).toBe(false);
        expect(input().value).toBe('why is abhisheka done?');
        expect(document.querySelectorAll('.ai-msg')).toHaveLength(0);
    });

    test('openDrawer without a prefill leaves what was typed alone', () => {
        initAi({ data: [], onCite() {} });
        input().value = 'half-typed';
        openDrawer();
        expect(input().value).toBe('half-typed');
    });

    test('the header chip asks what is typed in the search box, then clears that box', () => {
        const clearDraft = jest.fn();
        initAi({ data: [], onCite() {}, getDraft: () => 'what is daana', clearDraft });
        document.getElementById('ai-btn').click();
        expect(input().value).toBe('what is daana');
        expect(clearDraft).toHaveBeenCalled();
        // Pressing it again with text typed keeps the panel open (it does not toggle it shut).
        document.getElementById('ai-btn').click();
        expect(drawer().hidden).toBe(false);
    });

    test('with nothing typed the chip opens and closes the panel as before', () => {
        initAi({ data: [], onCite() {} });
        const chip = document.getElementById('ai-btn');
        chip.click();
        expect(drawer().hidden).toBe(false);
        chip.click();
        expect(drawer().hidden).toBe(true);
    });

    test('the panel says what it is, sends with an arrow button, and points to the book\'s own references', () => {
        initAi({ data: [], onCite() {} });
        expect(drawer().querySelector('.ai-head strong').textContent).toContain('Ask AI');
        expect(document.getElementById('ai-send').getAttribute('aria-label')).toBe('Ask');
        expect(drawer().querySelector('.ai-disclaimer').textContent).toMatch(/shlokas and videos/);
        expect(drawer().querySelector('.ai-disclaimer').textContent).not.toMatch(/guru/i);
        expect(document.getElementById('ai-empty')).not.toBeNull();
    });
});
