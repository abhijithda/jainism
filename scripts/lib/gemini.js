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
// A model that has no "minimal" gets "low" instead (for that model only, after one refused call); a model that refuses any
// other setting gets none.
// If a model rejects the setting (HTTP 400 naming thinking) the call is repeated once without it and the log says so; that
// model is then asked without it for the rest of the run, and the other models in GEMINI_MODELS still get the setting.
//
// Busy server (HTTP 429 / 5xx / timeout): each call is tried again a few times with growing pauses. If it is still busy after
// that, the client stops asking for the rest of the run (every later call fails at once with a clear message), so a Gemini
// outage costs a few minutes, not nine. The error then carries `unavailable: true`, so a script can tell "Gemini is down"
// (stop and change nothing) from "the answer was not usable" (use its own fallback).
//
// Models: the repository variable GEMINI_MODELS is a comma-separated list in order of preference, for example
// `gemini-3.8-flash,gemini-4-hydrogen`. The first is used; if it stays busy (or its quota is used up, HTTP 429), or is not
// available to the key (404), the next one is tried and later calls start with the one that answered. After about two minutes
// (cooldownMs) the first model is tried again, because a per-minute 429 passes; a daily limit just moves on again at once. Each model
// has its own free-tier quota, so a second model is also a second quota. GEMINI_MODEL (a single name) still works when
// GEMINI_MODELS is not set. Names are used as given; the code does not know which exist.

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

/** The model names to use, in order: GEMINI_MODELS (list), else GEMINI_MODEL, else the default. Blank entries and repeats go. */
function modelsFrom(list, single) {
    const raw = Array.isArray(list) ? list : String(list ?? process.env.GEMINI_MODELS ?? '').split(',');
    const names = [...new Set(raw.map((m) => String(m).trim()).filter(Boolean))];
    if (names.length) return names;
    return [String(single || '').trim() || DEFAULT_MODEL];
}

/** An error that says "Gemini itself is not answering" (busy after every retry), as opposed to "the answer was not usable". */
function unavailableError(message) {
    const e = new Error(message);
    e.unavailable = true;
    return e;
}

/**
 * @param {{ apiKey?: string, model?: string, models?: string|string[], fetchImpl?: Function, retries?: number, timeoutMs?: number, sleep?: Function, cooldownMs?: number, now?: Function,
 *           thinkingLevel?: string, thinkingBudget?: number|string, log?: Function }} options
 * @returns {{ available: boolean, model: string, models: string[], json: Function, usage: Function, printUsage: Function, reset: Function }}
 */
function createGemini(options = {}) {
    const apiKey = options.apiKey ?? process.env.GEMINI_API_KEY;
    const models = modelsFrom(options.models, options.model || process.env.GEMINI_MODEL);
    let current = 0;                                  // index of the model that answered last (later calls start there)
    let movedAt = 0;                                  // when the run last moved to a later model in the list
    const now = options.now || Date.now;
    const cooldownMs = options.cooldownMs ?? 120000;  // after this long on a fallback model the preferred one is tried again
    const skipped = new Set();                        // models the key cannot use (404)
    const noThinking = new Set();                     // models that refused the thinking setting
    const levelFor = {};                              // models that refused the level asked for and take the next one up: model -> thinkingConfig
    const perModel = {};                              // calls per model, for the usage line
    const fetchImpl = options.fetchImpl || globalThis.fetch;
    const retries = options.retries ?? 3;
    const timeoutMs = options.timeoutMs ?? 240000;
    let unavailable = null; // set when Gemini stayed busy after every retry: later calls fail at once
    const sleep = options.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    const log = options.log || ((line) => console.log(line));
    const thinking = thinkingConfigFrom(options.thinkingLevel ?? process.env.GEMINI_THINKING_LEVEL, options.thinkingBudget ?? process.env.GEMINI_THINKING_BUDGET);
    const totals = { calls: 0, prompt: 0, output: 0, thinking: 0, total: 0, ms: 0 };

    /** Count and log one answer's token usage (usageMetadata), whatever the answer was. */
    function record(payload, ms, used) {
        const u = payload?.usageMetadata;
        totals.calls++;
        perModel[used] = (perModel[used] || 0) + 1;
        totals.ms += ms;
        if (!u) { log(`[gemini] call ${totals.calls} (${used}): no usage numbers in the answer, ${(ms / 1000).toFixed(1)}s`); return; }
        const prompt = u.promptTokenCount || 0, output = u.candidatesTokenCount || 0, think = u.thoughtsTokenCount || 0;
        const total = u.totalTokenCount || prompt + output + think;
        totals.prompt += prompt; totals.output += output; totals.thinking += think; totals.total += total;
        log(`[gemini] call ${totals.calls} (${used}): in ${prompt}, out ${output}, thinking ${think}, total ${total} tokens, ${(ms / 1000).toFixed(1)}s`);
    }

    /**
     * Ask for JSON.
     * @param {{ system?: string, prompt: string, parts?: Object[], temperature?: number }} request
     *   parts: extra content parts put before the prompt (e.g. a YouTube fileData part with videoMetadata)
     */
    /** The thinking setting to send to a model: the one asked for, a step up if the model refused it, or none. */
    const thinkingFor = (forModel) => (!thinking || noThinking.has(forModel) ? null : (levelFor[forModel] || thinking));

    async function json({ system, prompt, parts = [], temperature = 0 }) {
        if (!apiKey) throw new Error('GEMINI_API_KEY is not set');
        if (unavailable) throw unavailableError(`Gemini not asked again in this run: it stayed unavailable earlier (${unavailable})`);
        const makeBody = (forModel) => ({
            ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
            contents: [{ role: 'user', parts: [...parts, { text: prompt }] }],
            generationConfig: { temperature, responseMimeType: 'application/json', ...(thinkingFor(forModel) ? { thinkingConfig: thinkingFor(forModel) } : {}) },
        });
        let lastError;
        if (current > 0 && now() - movedAt >= cooldownMs) {
            // a per-minute limit (429) or a busy spell is usually over after a couple of minutes: try the preferred model again;
            // if it is still limited the call moves on at once (a 429 never waits), so the probe costs one quick request
            log(`[gemini] ${Math.round((now() - movedAt) / 1000)}s on ${models[current]}; trying ${models[0]} again`);
            current = 0;
        }
        const order = models.map((name, i) => ({ name, i })).filter((m) => m.i >= current && !skipped.has(m.name));
        for (let k = 0; k < order.length; k++) {
            const { name: useModel, i: modelIndex } = order[k];
            const hasNext = k + 1 < order.length;
            if (k > 0) log(`[gemini] ${order[k - 1].name} did not answer (${lastError.message}); trying ${useModel}`);
            const tries = k === 0 ? retries : 1;             // the first model gets all the retries, the others one more try
            let giveUpOnModel = false;
            for (let attempt = 0; attempt <= tries && !giveUpOnModel; attempt++) {
                if (attempt) await sleep(2000 * 2 ** (attempt - 1));
                let res;
                const startedAt = Date.now();
                try {
                    res = await fetchImpl(`${ENDPOINT}/${encodeURIComponent(useModel)}:generateContent`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
                        body: JSON.stringify(makeBody(useModel)),
                        signal: AbortSignal.timeout(timeoutMs),
                    });
                } catch (e) { lastError = new Error(`Gemini request failed: ${e.message}`); continue; }
                if (res.status === 404 && hasNext) {
                    // this key cannot use that model name: never ask it again in this run
                    skipped.add(useModel);
                    lastError = new Error(`${useModel} is not available to this key (404)`);
                    giveUpOnModel = true;
                    continue;
                }
                if (res.status === 429 || res.status >= 500) {
                    lastError = new Error(`Gemini answered ${res.status} (busy or rate-limited)`);
                    if (res.status === 429 && hasNext) giveUpOnModel = true; // this model's quota: the next model has its own
                    continue;
                }
                const payload = await res.json().catch(() => ({}));
                if (!res.ok && res.status === 400 && thinkingFor(useModel) && /thinking/i.test(payload.error?.message || '')) {
                    const asked = thinkingFor(useModel);
                    if (asked.thinkingLevel === 'minimal') {
                        // some models have no "minimal" and say "retry with other thinking level": take "low", which is still far less
                        // than the model's own default, for this model for the rest of the run, and repeat the call
                        log(`[gemini] ${useModel} refused thinking level minimal (${payload.error.message}); using low for this model`);
                        levelFor[useModel] = { thinkingLevel: 'low' };
                    } else {
                        // this model does not accept the thinking setting: say so once, drop it for this model for the rest of the run, and repeat the call
                        log(`[gemini] ${useModel} refused the thinking setting (${payload.error.message}); continuing without it for this model`);
                        noThinking.add(useModel);
                    }
                    attempt--;
                    continue;
                }
                if (!res.ok) throw new Error(`Gemini answered ${res.status}: ${payload.error?.message || 'no details'} (model: ${useModel})`);
                if (modelIndex !== current) { current = modelIndex; movedAt = now(); }   // later calls start with the model that answers (for the cooldown)
                record(payload, Date.now() - startedAt, useModel);
                const text = (payload.candidates?.[0]?.content?.parts || []).filter((p) => !p.thought).map((p) => p.text || '').join('');
                if (!text.trim()) {
                    const why = payload.promptFeedback?.blockReason || payload.candidates?.[0]?.finishReason || 'empty answer';
                    throw new Error(`Gemini returned no text (${why})`);
                }
                try { return parseJsonAnswer(text); } catch (err) { err.raw = text; throw err; }   // the whole answer, so a caller can show where the JSON broke
            }
        }
        unavailable = lastError.message;
        log(`[gemini] still unavailable after the retries${order.length > 1 ? ` (${order.map((m) => m.name).join(', ')})` : ''}: ${lastError.message}; no more Gemini calls in this run`);
        throw unavailableError(lastError.message);
    }

    /** Lift the "unavailable" flag so the next call is really made. For a script that waits for a busy spell to pass and then
     *  asks again (scripts/translate-transcripts.js). Everything else the client has learned stays: which model answered last,
     *  the models this key cannot use, the models that refused the thinking setting, and the usage totals. */
    function reset() { unavailable = null; }

    /** Totals so far: { calls, prompt, output, thinking, total, ms }. */
    function usage() { return { ...totals }; }

    /** One summary line for the end of a run (nothing when no call was made). */
    function printUsage() {
        if (!totals.calls) return;
        const level = thinking
            ? ` (thinking setting: ${JSON.stringify(thinking)}${noThinking.size ? `, not accepted by ${[...noThinking].join(', ')}` : ''})`
            : ' (thinking setting: model default)';
        log(`[gemini] ${Object.entries(perModel).map(([m, n]) => `${m}${models.length > 1 ? ` x${n}` : ''}`).join(', ')}: ${totals.calls} call(s), in ${totals.prompt}, out ${totals.output}, thinking ${totals.thinking}, total ${totals.total} tokens, ${(totals.ms / 1000).toFixed(1)}s${level}`);
    }

    return { available: Boolean(apiKey), get model() { return models[current]; }, models, json, usage, printUsage, reset };
}

module.exports = { createGemini, parseJsonAnswer, thinkingConfigFrom, modelsFrom, DEFAULT_MODEL, THINKING_LEVELS };
