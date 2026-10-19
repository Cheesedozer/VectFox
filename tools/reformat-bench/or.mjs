// OpenRouter client with usage accounting, plus a fetch shim that turns
// SillyTavern's chat-completions proxy calls into direct OpenRouter calls.
const KEY = process.env.OPENROUTER_API_KEY;
export const usage = [];
let currentPhase = 'misc';
export function setPhase(p) { currentPhase = p; }

export async function openrouter(body, { phase = currentPhase, timeoutMs = 900000 } = {}) {
    const t0 = Date.now();
    for (let attempt = 1; ; attempt++) {
        let res, text;
        try {
            res = await realFetch('https://openrouter.ai/api/v1/chat/completions', {
                method: 'POST',
                headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ ...body, usage: { include: true } }),
                signal: AbortSignal.timeout(timeoutMs),
            });
            text = await res.text();
        } catch (err) {
            if (attempt >= 4) throw err;
            console.error(`[or] ${phase} attempt ${attempt} network error: ${err.message}`);
            await new Promise(r => setTimeout(r, 3000 * attempt));
            continue;
        }
        let data = null;
        try { data = JSON.parse(text); } catch { /* keep raw */ }
        if ((!res.ok || data?.error) && attempt < 3 && (res.status >= 500 || res.status === 429 || data?.error)) {
            console.error(`[or] ${phase} attempt ${attempt} failed: ${res.status} ${text.slice(0, 200)}`);
            await new Promise(r => setTimeout(r, 3000 * attempt));
            continue;
        }
        const u = data?.usage || {};
        usage.push({
            phase,
            ms: Date.now() - t0,
            prompt: u.prompt_tokens || 0,
            cached: u.prompt_tokens_details?.cached_tokens || 0,
            cacheWrite: u.prompt_tokens_details?.cache_write_tokens || 0,
            completion: u.completion_tokens || 0,
            reasoning: u.completion_tokens_details?.reasoning_tokens || 0,
            cost: u.cost || 0,
            finish: data?.choices?.[0]?.finish_reason || null,
        });
        return { ok: res.ok && !data?.error, status: res.status, data, text };
    }
}

export function summarizeUsage(rows = usage) {
    const by = {};
    for (const r of rows) {
        const b = (by[r.phase] ||= { calls: 0, prompt: 0, cached: 0, cacheWrite: 0, completion: 0, reasoning: 0, cost: 0, maxMs: 0, sumMs: 0, truncated: 0 });
        b.calls++; b.prompt += r.prompt; b.cached += r.cached; b.cacheWrite += r.cacheWrite; b.completion += r.completion;
        b.reasoning += r.reasoning; b.cost += r.cost; b.maxMs = Math.max(b.maxMs, r.ms); b.sumMs += r.ms;
        if (r.finish === 'length') b.truncated++;
    }
    return by;
}

const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
    if (url === '/api/backends/chat-completions/generate') {
        const b = JSON.parse(init.body);
        const r = await openrouter({
            model: b.model,
            messages: b.messages,
            ...(b.max_tokens ? { max_tokens: b.max_tokens } : {}),
            temperature: b.temperature,
            ...(b.reasoning_effort ? { reasoning: { effort: b.reasoning_effort } } : {}),
        });
        return new Response(r.text, { status: r.ok ? 200 : (r.status === 200 ? 502 : r.status), headers: { 'Content-Type': 'application/json' } });
    }
    return realFetch(url, init);
};
