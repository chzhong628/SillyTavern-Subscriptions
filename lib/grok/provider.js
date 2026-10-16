import { grokOAuth } from './oauth.js';
import { runGrokResponses, responsesInput } from './responses.js';
import { GROK_BASE, grokHeaders } from './config.js';

export { GROK_BASE };

export async function grokStatus() {
    const login = await grokOAuth.status();
    const ready = login.loggedIn && (login.expiresAt > Date.now() || login.refreshable);
    return { provider: 'grok', ok: ready, available: ready, login,
        message: ready ? 'Signed in on this server. Model access is checked when connecting or chatting.' : 'Sign in through the Grok drawer (experimental OAuth).',
        backends: { subscription: { ready }, api: { ready: false } } };
}

export async function grokModelEntries({ oauth = grokOAuth, fetchImpl = globalThis.fetch } = {}) {
    if (!(await oauth.status()).loggedIn) return [];
    let token = await oauth.token();
    const request = () => fetchImpl(`${GROK_BASE}/models`, { redirect: 'error', signal: AbortSignal.timeout(20000), headers: grokHeaders(token) });
    let res = await request();
    if (res.status === 401) {
        await res.body?.cancel();
        token = await oauth.token({ force: true, rejectedToken: token });
        res = await request();
    }
    if (!res.ok) {
        await res.body?.cancel();
        throw Object.assign(new Error(`Grok model discovery returned HTTP ${res.status}.`), { httpStatus: res.status });
    }
    const data = await res.json();
    return (Array.isArray(data.data) ? data.data : []).filter((m) => m && typeof m.id === 'string' && m.id.startsWith('grok-'))
        .map((m) => ({ id: m.id, object: 'model', created: m.created || 0, owned_by: 'grok',
            ...(Number.isFinite(m.context_window) ? { context_window: m.context_window } : {}),
            ...(Array.isArray(m.reasoning_efforts) ? { reasoning_efforts: m.reasoning_efforts } : {}) }));
}

export async function runGrokChat({ messages, model, settings, writer, signal }, { oauth = grokOAuth, run } = {}) {
    if (settings.grok?.backend && settings.grok.backend !== 'subscription') {
        throw Object.assign(new Error('Grok supports subscription OAuth only; API fallback is disabled.'), { httpStatus: 400 });
    }
    // Validate before requesting a token or spending quota. First release is text-only.
    responsesInput(messages);
    run ??= runGrokResponses;
    let token = await oauth.token();
    const extraBody = {};
    if (settings.maxTokens) extraBody.max_tokens = settings.maxTokens;
    if (settings.temperature !== undefined) extraBody.temperature = settings.temperature;
    if (settings.topP !== undefined) extraBody.top_p = settings.topP;
    if (['low', 'medium', 'high', 'xhigh'].includes(settings.grok?.effort)) extraBody.reasoning_effort = settings.grok.effort;
    const invoke = () => run({ baseUrl: GROK_BASE, apiKey: token, model, messages, extraBody, writer, signal, tag: '[subscriptions/grok]' });
    try { await invoke(); }
    catch (e) {
        if (e.httpStatus === 401 && !writer.didYieldContent && !signal?.aborted) {
            token = await oauth.token({ force: true, rejectedToken: token });
            await invoke();
        } else if (e.httpStatus === 403) {
            throw Object.assign(new Error('Grok refused access to this model or OAuth client (HTTP 403). Your login was preserved; no API fallback was attempted.'), { httpStatus: 403 });
        } else throw e;
    }
}
