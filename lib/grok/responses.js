import { onAbort, abortError } from '../common/abort.js';
import { FIRST_BYTE_MS, IDLE_MS } from '../common/openai-compat.js';
import { GROK_BASE, grokHeaders } from './config.js';

export function responsesInput(messages) {
    return messages.map((m) => {
        if (!m || !['system', 'developer', 'user', 'assistant'].includes(m.role) || m.tool_calls) {
            throw Object.assign(new Error('Grok OAuth currently supports text conversations without tool calls.'), { httpStatus: 400 });
        }
        if (typeof m.content === 'string') return { role: m.role, content: m.content };
        if (!Array.isArray(m.content) || m.content.some((p) => !p || p.type !== 'text' || typeof p.text !== 'string')) {
            throw Object.assign(new Error('Grok OAuth currently supports text only. Remove image or file attachments.'), { httpStatus: 400 });
        }
        return { role: m.role, content: m.content.map((p) => p.text).join('\n') };
    });
}

function usageOf(u) {
    if (!u) return null;
    return { prompt_tokens: u.input_tokens || 0, completion_tokens: u.output_tokens || 0,
        total_tokens: u.total_tokens ?? ((u.input_tokens || 0) + (u.output_tokens || 0)),
        ...(u.input_tokens_details ? { prompt_tokens_details: u.input_tokens_details } : {}),
        ...(u.output_tokens_details ? { completion_tokens_details: u.output_tokens_details } : {}) };
}

/** Only the fixed first-party API receives the subscription bearer. No tools or stored sessions. */
export async function runGrokResponses({ apiKey, model, messages, extraBody, writer, signal },
    { fetchImpl = globalThis.fetch, firstByteMs = FIRST_BYTE_MS, idleMs = IDLE_MS, upstreamStream = true } = {}) {
    const input = responsesInput(messages);
    if (signal?.aborted) throw abortError();
    const controller = new AbortController();
    const unsubscribe = onAbort(signal, () => controller.abort());
    let timer, timeout = false, reader;
    const arm = (ms) => {
        clearTimeout(timer);
        timer = setTimeout(() => { timeout = true; controller.abort(); }, ms);
        timer.unref?.();
    };
    let terminal = null;
    const check = (data) => {
        if (data?.error || data?.type === 'error' || data?.type === 'response.failed') {
            throw new Error('Grok returned a failed response. No automatic generation retry was attempted.');
        }
    };
    try {
        arm(firstByteMs);
        // Some subscription models require streaming even for a JSON client.
        // CompletionWriter accumulates upstream deltas when ST requested JSON.
        const body = { model, input, stream: upstreamStream, store: false, tools: [],
            ...(extraBody?.reasoning_effort ? { reasoning: { effort: extraBody.reasoning_effort } } : {}),
            ...(extraBody?.max_tokens ? { max_output_tokens: extraBody.max_tokens } : {}),
            ...(extraBody?.temperature !== undefined ? { temperature: extraBody.temperature } : {}),
            ...(extraBody?.top_p !== undefined ? { top_p: extraBody.top_p } : {}) };
        const res = await fetchImpl(`${GROK_BASE}/responses`, {
            method: 'POST', redirect: 'error', signal: controller.signal,
            headers: { ...grokHeaders(apiKey, model), 'Content-Type': 'application/json', Accept: upstreamStream ? 'text/event-stream' : 'application/json' },
            body: JSON.stringify(body),
        });
        if (!res.ok) {
            await res.body?.cancel();
            throw Object.assign(new Error(`Grok inference returned HTTP ${res.status}.`), { httpStatus: res.status });
        }
        if (!upstreamStream) {
            terminal = await res.json();
            check(terminal);
            if (!['completed', 'incomplete'].includes(terminal.status) || !Array.isArray(terminal.output)) throw new Error('Grok returned an incomplete response envelope.');
            for (const item of terminal.output) {
                for (const part of item.content || []) {
                    if (part.type === 'output_text') writer.pushText(part.text || '');
                    if (part.type === 'refusal') writer.pushText(part.refusal || '');
                }
                if (item.type === 'reasoning') for (const part of item.summary || []) writer.pushReasoning(part.text || '');
            }
        } else {
            reader = res.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '', dataLines = [], eventSize = 0;
            const maxEventSize = 4 * 1024 * 1024;
            const event = () => {
                if (!dataLines.length) return;
                const payload = dataLines.join('\n'); dataLines = []; eventSize = 0;
                if (payload === '[DONE]') return;
                let data;
                try { data = JSON.parse(payload); }
                catch { throw new Error('Grok returned an invalid stream event.'); }
                if (!data || typeof data.type !== 'string') throw new Error('Grok returned an invalid stream event.');
                check(data);
                if (data.type === 'response.output_text.delta') writer.pushText(data.delta || '');
                if (data.type === 'response.refusal.delta') writer.pushText(data.delta || '');
                if (data.type === 'response.reasoning_summary_text.delta') writer.pushReasoning(data.delta || '');
                if (['response.completed', 'response.incomplete'].includes(data.type)) {
                    terminal = data.response;
                    check(terminal);
                    if (!terminal || !['completed', 'incomplete'].includes(terminal.status)) throw new Error('Grok returned an invalid completion event.');
                }
            };
            while (!terminal && !writer.stopMatched) {
                const { done, value } = await reader.read();
                if (done) break;
                arm(idleMs);
                buffer += decoder.decode(value, { stream: true });
                let newline;
                while ((newline = buffer.indexOf('\n')) !== -1) {
                    const line = buffer.slice(0, newline).replace(/\r$/, '');
                    buffer = buffer.slice(newline + 1);
                    if (!line) event();
                    else if (line.startsWith('data:')) {
                        eventSize += line.length;
                        if (eventSize > maxEventSize) throw new Error('Grok sent an oversized stream event.');
                        dataLines.push(line.slice(5).trimStart());
                    }
                    if (terminal || writer.stopMatched) break;
                }
                if (buffer.length + eventSize > maxEventSize) throw new Error('Grok sent an oversized stream event.');
            }
            if (!terminal && !writer.stopMatched) throw new Error('Grok stream ended before a completion event. Partial output was preserved.');
        }
        if (signal?.aborted) throw abortError();
        writer.flushTail();
        writer.finish({ usage: usageOf(terminal?.usage), finishReason: writer.stopMatched ? 'stop' : terminal?.status === 'incomplete' ? 'length' : 'stop' });
    } catch (e) {
        if (timeout) throw new Error('Grok inference timed out.');
        if (signal?.aborted) throw abortError();
        throw e;
    } finally {
        clearTimeout(timer);
        unsubscribe();
        await reader?.cancel().catch(() => {});
    }
}
