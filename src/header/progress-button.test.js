const { initProgressButton } = require('./progress-button');
const flush = () => new Promise(r => setTimeout(r, 0));

beforeEach(() => {
    document.body.innerHTML = `
        <button id="progress-btn" aria-expanded="false"><span id="progress-badge"></span></button>
        <div id="progress-pop" hidden><button id="study-btn-pop" hidden><span id="study-badge-pop"></span></button></div>
        <button id="study-btn" hidden><span id="study-badge"></span></button>`;
});

describe('progress button', () => {
    test('tapping the ring opens and closes its card', () => {
        initProgressButton();
        const btn = document.getElementById('progress-btn');
        const pop = document.getElementById('progress-pop');
        btn.click();
        expect(pop.hidden).toBe(false);
        expect(btn.getAttribute('aria-expanded')).toBe('true');
        btn.click();
        expect(pop.hidden).toBe(true);
    });

    test('a click elsewhere or Escape closes the card', () => {
        initProgressButton();
        const pop = document.getElementById('progress-pop');
        document.getElementById('progress-btn').click();
        document.body.click();
        expect(pop.hidden).toBe(true);
        document.getElementById('progress-btn').click();
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
        expect(pop.hidden).toBe(true);
    });

    test('the Study row and the ring badge follow the real Study button', async () => {
        initProgressButton();
        const study = document.getElementById('study-btn');
        const row = document.getElementById('study-btn-pop');
        expect(row.hidden).toBe(true);
        study.hidden = false;
        document.getElementById('study-badge').textContent = '3';
        await flush();
        expect(row.hidden).toBe(false);
        expect(document.getElementById('study-badge-pop').textContent).toBe('3');
        expect(document.getElementById('progress-badge').textContent).toBe('3');
        study.hidden = true;
        await flush();
        expect(document.getElementById('progress-badge').textContent).toBe('');
    });

    test('pressing the Study row presses the real Study button and closes the card', () => {
        initProgressButton();
        const study = document.getElementById('study-btn');
        const onStudy = jest.fn();
        study.addEventListener('click', onStudy);
        document.getElementById('progress-btn').click();
        document.getElementById('study-btn-pop').click();
        expect(onStudy).toHaveBeenCalledTimes(1);
        expect(document.getElementById('progress-pop').hidden).toBe(true);
    });

    test('does nothing when the markup is missing', () => {
        document.body.innerHTML = '';
        expect(() => initProgressButton()).not.toThrow();
    });
});
