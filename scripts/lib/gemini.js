// lib/gemini.js — a small client for the Gemini API (REST, no SDK, Node 22 fetch).
//
// Used by notes-to-blocks (split + translate), typo-review (typos) and video-followup (transcript + points).
// Everything that calls it takes the client as an argument (`ai.json(...)`), so tests pass a fake and nothing in the
// test suite touches the network.
//
// Setup: a free key from Google AI Studio, saved as the repository secret GEMINI_API_KEY. The model can be changed
// without touching code with the repository variable GEMINI_MODEL (Settings -> Secrets and variables -> Actions ->
// Variables); models are renamed and retired often, so this is the first thing to check if every call fails.
//
// Usage: every call logs one line (`[gemini] call 3: in 1200, out 310, thinking 2950, total 4460 tokens, 12.4s`) and
// the scripts print the totals at the end, so the Actions log shows what a run really cost.
//
// Thinking: Gemini 3 models think before they answer, and the thinking tokens count against the quota and take time even
// for a tiny answer. The repository variable GEMINI_THINKING_LEVEL (minimal | low | medium | high) is sent as
// generationConfig.thinkingConfig.thinkingLevel. Unset (the default) sends nothing: the model's own default. Gemini 2.5
// models take a number of tokens instead (GEMINI_THINKING_BUDGET); the API refuses both together, so only one is sent.
// If the model rejects the setting (HTTP 400 naming thinking) the call is repeated once without it and the log says so.

const DEFAULT_MODEL = 'gemini-3.8-flash';
const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';
const THINKING_LEVELS = ['minimal', 'low', 'medium', 'high'];

/** The thinkingConfig to send, from options or the environment; null when none is set or the value is not valid. */
function thinkingConfigFrom(level, budget) {
    const lv = String(level ?? '').trim().toLowerCase();
    if (lv) {
        if (THINKING_LEVELS.includes(lv)) return { thinkingLevel: lv };
        console.error(`[gemini] ignoring GEMINI_THINKING_LEVEL="${lv}" (use one of ${THINKING_LEVELS.join(', ')})`);
        return null;
    }
    const raw = String(budget ?? '').trim();
    if (raw !== '') {
        const n = Number(raw);
        if (Number.isInteger(n) && n >= -1) return { thinkingBudget: n };
        console.error(`[gemini] ignoring GEMINI_THINKING_BUDGET="${raw}" (use a whole number; 0 turns thinking off where allowed, -1 is automatic)`);
    }
    return null;
}

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
 * @param {{ apiKey?: string, model?: string, fetchImpl?: Function, retries?: number, timeoutMs?: number, sleep?: Function,
 *           thinkingLevel?: string, thinkingBudget?: number|string, log?: Function }} options
 * @returns {{ available: boolean, model: string, json: Function, usage: Function, printUsage: Function }}
 */
function createGemini(options = {}) {
    const apiKey = options.apiKey ?? process.env.GEMINI_API_KEY;
    const model = options.model || process.env.GEMINI_MODEL || DEFAULT_MODEL;
    const fetchImpl = options.fetchImpl || globalThis.fetch;
    const retries = options.retries ?? 3;
    const timeoutMs = options.timeoutMs ?? 240000;
    const sleep = options.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    const log = options.log || ((line) => console.log(line));
    let thinking = thinkingConfigFrom(options.thinkingLevel ?? process.env.GEMINI_THINKING_LEVEL, options.thinkingBudget ?? process.env.GEMINI_THINKING_BUDGET);
    const totals = { calls: 0, prompt: 0, output: 0, thinking: 0, total: 0, ms: 0 };

    /** Count and log one answer's token usage (usageMetadata), whatever the answer was. */
    function record(payload, ms) {
        const u = payload?.usageMetadata;
        totals.calls++;
        totals.ms += ms;
        if (!u) { log(`[gemini] call ${totals.calls}: no usage numbers in the answer, ${(ms / 1000).toFixed(1)}s`); return; }
        const prompt = u.promptTokenCount || 0, output = u.candidatesTokenCount || 0, think = u.thoughtsTokenCount || 0;
        const total = u.totalTokenCount || prompt + output + think;
        totals.prompt += prompt; totals.output += output; totals.thinking += think; totals.total += total;
        log(`[gemini] call ${totals.calls}: in ${prompt}, out ${output}, thinking ${think}, total ${total} tokens, ${(ms / 1000).toFixed(1)}s`);
    }

    /**
     * Ask for JSON.
     * @param {{ system?: string, prompt: string, parts?: Object[], temperature?: number }} request
     *   parts: extra content parts put before the prompt (e.g. a YouTube fileData part with videoMetadata)
     */
    async function json({ system, prompt, parts = [], temperature = 0 }) {
        if (!apiKey) throw new Error('GEMINI_API_KEY is not set');
        const makeBody = () => ({
            ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
            contents: [{ role: 'user', parts: [...parts, { text: prompt }] }],
            generationConfig: { temperature, responseMimeType: 'application/json', ...(thinking ? { thinkingConfig: thinking } : {}) },
        });
        let lastError;
        for (let attempt = 0; attempt <= retries; attempt++) {
            if (attempt) await sleep(2000 * 2 ** (attempt - 1));
            let res;
            const startedAt = Date.now();
            try {
                res = await fetchImpl(`${ENDPOINT}/${encodeURIComponent(model)}:generateContent`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
                    body: JSON.stringify(makeBody()),
                    signal: AbortSignal.timeout(timeoutMs),
                });
            } catch (e) { lastError = new Error(`Gemini request failed: ${e.message}`); continue; }
            if (res.status === 429 || res.status >= 500) { lastError = new Error(`Gemini answered ${res.status} (busy or rate-limited)`); continue; }
            const payload = await res.json().catch(() => ({}));
            if (!res.ok && res.status === 400 && thinking && /think/i.test(payload.error?.message || '')) {
                // this model does not accept the thinking setting: say so once, drop it for the rest of the run, and repeat the call
                log(`[gemini] the model refused the thinking setting (${payload.error.message}); continuing without it`);
                thinking = null;
                attempt--;
                continue;
            }
            if (!res.ok) throw new Error(`Gemini answered ${res.status}: ${payload.error?.message || 'no details'} (model: ${model})`);
            record(payload, Date.now() - startedAt);
            const text = (payload.candidates?.[0]?.content?.parts || []).filter((p) => !p.thought).map((p) => p.text || '').join('');
            if (!text.trim()) {
                const why = payload.promptFeedback?.blockReason || payload.candidates?.[0]?.finishReason || 'empty answer';
                throw new Error(`Gemini returned no text (${why})`);
            }
            return parseJsonAnswer(text);
        }
        throw lastError;
    }

    /** Totals so far: { calls, prompt, output, thinking, total, ms }. */
    function usage() { return { ...totals }; }

    /** One summary line for the end of a run (nothing when no call was made). */
    function printUsage() {
        if (!totals.calls) return;
        const level = thinking ? ` (thinking setting: ${JSON.stringify(thinking)})` : ' (thinking setting: model default)';
        log(`[gemini] ${model}: ${totals.calls} call(s), in ${totals.prompt}, out ${totals.output}, thinking ${totals.thinking}, total ${totals.total} tokens, ${(totals.ms / 1000).toFixed(1)}s${level}`);
    }

    return { available: Boolean(apiKey), model, json, usage, printUsage };
}

module.exports = { createGemini, parseJsonAnswer, thinkingConfigFrom, DEFAULT_MODEL, THINKING_LEVELS };
