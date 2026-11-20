// lib/gemini.js — a small client for the Gemini API (REST, no SDK, Node 22 fetch).
//
// Used by notes-to-blocks (split + translate), typo-review (typos) and video-followup (transcript + points).
// Everything that calls it takes the client as an argument (`ai.json(...)`), so tests pass a fake and nothing in the
// test suite touches the network.
//
// Setup: a free key from Google AI Studio, saved as the repository secret GEMINI_API_KEY. The model can be changed
// without touching code with the repository variable GEMINI_MODEL (Settings -> Secrets and variables -> Actions ->
// Variables); models are renamed and retired often, so this is the first thing to check if every call fails.

const DEFAULT_MODEL = 'gemini-3.8-flash';
const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';

/** Pull a JSON value out of a model answer, tolerating ```json fences and text around it. */
function parseJsonAnswer(text) {
    let s = String(text || '').trim();
    const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) s = fence[1].trim();
    try { return JSON.parse(s); } catch { /* fall through */ }
    const first = Math.min(...['{', '['].map((c) => { const i = s.indexOf(c); return i < 0 ? Infinity : i; }));
    const last = Math.max(s.lastIndexOf('}'), s.lastIndexOf(']'));
    if (first !== Infinity && last > first) return JSON.parse(s.slice(first, last + 1));
    throw new Error('the model did not return JSON');
}

/**
 * @param {{ apiKey?: string, model?: string, fetchImpl?: Function, retries?: number, timeoutMs?: number, sleep?: Function }} options
 * @returns {{ available: boolean, model: string, json: Function }}
 */
function createGemini(options = {}) {
    const apiKey = options.apiKey ?? process.env.GEMINI_API_KEY;
    const model = options.model || process.env.GEMINI_MODEL || DEFAULT_MODEL;
    const fetchImpl = options.fetchImpl || globalThis.fetch;
    const retries = options.retries ?? 3;
    const timeoutMs = options.timeoutMs ?? 240000;
    const sleep = options.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));

    /**
     * Ask for JSON.
     * @param {{ system?: string, prompt: string, parts?: Object[], temperature?: number }} request
     *   parts: extra content parts put before the prompt (e.g. a YouTube fileData part with videoMetadata)
     */
    async function json({ system, prompt, parts = [], temperature = 0 }) {
        if (!apiKey) throw new Error('GEMINI_API_KEY is not set');
        const body = {
            ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
            contents: [{ role: 'user', parts: [...parts, { text: prompt }] }],
            generationConfig: { temperature, responseMimeType: 'application/json' },
        };
        let lastError;
        for (let attempt = 0; attempt <= retries; attempt++) {
            if (attempt) await sleep(2000 * 2 ** (attempt - 1));
            let res;
            try {
                res = await fetchImpl(`${ENDPOINT}/${encodeURIComponent(model)}:generateContent`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
                    body: JSON.stringify(body),
                    signal: AbortSignal.timeout(timeoutMs),
                });
            } catch (e) { lastError = new Error(`Gemini request failed: ${e.message}`); continue; }
            if (res.status === 429 || res.status >= 500) { lastError = new Error(`Gemini answered ${res.status} (busy or rate-limited)`); continue; }
            const payload = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(`Gemini answered ${res.status}: ${payload.error?.message || 'no details'} (model: ${model})`);
            const text = (payload.candidates?.[0]?.content?.parts || []).filter((p) => !p.thought).map((p) => p.text || '').join('');
            if (!text.trim()) {
                const why = payload.promptFeedback?.blockReason || payload.candidates?.[0]?.finishReason || 'empty answer';
                throw new Error(`Gemini returned no text (${why})`);
            }
            return parseJsonAnswer(text);
        }
        throw lastError;
    }

    return { available: Boolean(apiKey), model, json };
}

module.exports = { createGemini, parseJsonAnswer, DEFAULT_MODEL };
