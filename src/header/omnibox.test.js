const { initOmnibox } = require('./omnibox');

const data = [
    { id: 'q_001', type: 'qa', blocks: [
        { id: 'q_001_b_1', type: 'question', content: { en: ['What is abhisheka?'] } },
        { id: 'q_001_b_2', type: 'answer', content: { en: ['Abhisheka is the bathing of the Jina image.'] } },
    ] },
];

function setup({ ask = false } = {}) {
    document.body.innerHTML = `
        <header class="app-header">
            <div id="omnibox"><button id="omni-back"></button>
                <input id="search-bar"><button id="ai-btn" ${ask ? '' : 'hidden'}></button>
                <div id="omni-menu" hidden></div></div>
            <button id="search-toggle" aria-expanded="false"></button>
        </header>`;
    const onPick = jest.fn();
    const onAsk = jest.fn();
    const box = initOmnibox({ data, getLangs: () => ['en'], onPick, onAsk });
    const input = document.getElementById('search-bar');
    const type = text => { input.value = text; input.dispatchEvent(new Event('input')); };
    return { box, input, type, onPick, onAsk, menu: document.getElementById('omni-menu') };
}

describe('omnibox list', () => {
    test('typing lists matching passages with a count, label and highlighted hit', () => {
        const { type, menu } = setup();
        type('abhisheka');
        expect(menu.hidden).toBe(false);
        expect(menu.querySelector('.omni-head').textContent).toBe('Topics · 2 matches');
        const rows = menu.querySelectorAll('.omni-topic');
        expect(rows).toHaveLength(2);
        expect(rows[0].querySelector('mark').textContent).toBe('abhisheka');
        expect(rows[0].querySelector('.omni-label').textContent).toMatch(/^Q-/);
    });

    test('one letter or nothing closes the list', () => {
        const { type, menu } = setup();
        type('abhisheka');
        type('a');
        expect(menu.hidden).toBe(true);
        expect(menu.children).toHaveLength(0);
    });

    test('says so when nothing matches', () => {
        const { type, menu } = setup();
        type('zzzz');
        expect(menu.textContent).toContain('No topic matches');
    });

    test('picking a topic opens it, closes the list and empties the box', () => {
        const { type, menu, onPick, input } = setup();
        type('abhisheka');
        menu.querySelector('.omni-topic').click();
        expect(onPick).toHaveBeenCalledWith('q_001_b_1');
        expect(menu.hidden).toBe(true);
        expect(input.value).toBe('');
    });
});

describe('omnibox Ask AI', () => {
    test('there is no Ask row (and the placeholder does not mention asking) while the AI is off', () => {
        const { type, menu, input } = setup({ ask: false });
        type('abhisheka');
        expect(menu.querySelector('.omni-ask')).toBeNull();
        expect(input.placeholder).not.toMatch(/ask/i);
    });

    test('with the AI on, the last row asks the typed text, and nothing is sent by itself', () => {
        const { type, menu, onAsk, input } = setup({ ask: true });
        expect(input.placeholder).toMatch(/ask/i);
        type('what is abhisheka');
        const row = menu.querySelector('.omni-ask');
        expect(row.textContent).toContain('Ask AI');
        expect(row.textContent).toContain('what is abhisheka');
        expect(menu.lastElementChild).toBe(row);
        row.click();
        expect(onAsk).toHaveBeenCalledWith('what is abhisheka');
        expect(input.value).toBe('');
    });

    test('Ctrl+Enter asks; plain Enter does not', () => {
        const { type, onAsk, input } = setup({ ask: true });
        type('why');
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        expect(onAsk).not.toHaveBeenCalled();
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
        expect(onAsk).toHaveBeenCalledWith('why');
    });

    test('draft() returns what is typed, trimmed', () => {
        const { box, type } = setup({ ask: true });
        type('  hello ');
        expect(box.draft()).toBe('hello');
    });
});

describe('omnibox on a phone', () => {
    test('the search icon opens the box in the header and the back arrow closes it', () => {
        const { type } = setup();
        const header = document.querySelector('.app-header');
        const toggle = document.getElementById('search-toggle');
        toggle.click();
        expect(header.classList.contains('search-open')).toBe(true);
        expect(toggle.getAttribute('aria-expanded')).toBe('true');
        type('abhisheka');
        document.getElementById('omni-back').click();
        expect(header.classList.contains('search-open')).toBe(false);
        expect(document.getElementById('search-bar').value).toBe('');
        expect(document.getElementById('omni-menu').hidden).toBe(true);
    });

    test('clearing the box tells the view (keyup) so a filtered page shows everything again', () => {
        const { type, input } = setup();
        const onKeyup = jest.fn();
        input.addEventListener('keyup', onKeyup);
        type('abhisheka');
        document.getElementById('omni-back').click();
        expect(onKeyup).toHaveBeenCalled();
    });
});
