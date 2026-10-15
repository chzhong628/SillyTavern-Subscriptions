// Subscription-only image generation. No API-key discovery or billing fallback.
import { readFileSync } from 'node:fs';
import { getImageAppServer } from './app-server.js';
import { assertChatgptLogin, assertOpenAiEndpoints, codexTurnError } from './chat.js';
import { runtimeDir } from '../common/runtime.js';

const MAX_IMAGE_BYTES = 30 * 1024 * 1024;
const FORBIDDEN_ITEMS = new Set(['commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall', 'webSearch', 'imageView', 'collabAgentToolCall', 'subAgentActivity']);
const fail = (message, httpStatus = 400) => Object.assign(new Error(message), { httpStatus });
const abortError = () => Object.assign(new Error('Image generation cancelled'), { name: 'AbortError' });

export function validateImageRequest(body = {}) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw fail('An image request must be a JSON object.');
    if (typeof body.prompt !== 'string' || !body.prompt.trim() || body.prompt.length > 32000) {
        throw fail('prompt must be a non-empty string of at most 32000 characters.');
    }
    if (body.n !== undefined && body.n !== 1) throw fail('Codex image generation supports n=1 only.');
    if (body.response_format !== undefined && body.response_format !== 'b64_json') throw fail('Only response_format=b64_json is supported.');
    for (const field of ['size', 'quality']) {
        if (body[field] !== undefined && body[field] !== 'auto') throw fail(`${field} is not a guaranteed Codex control; use auto and describe the desired result in prompt.`);
    }
    for (const field of ['stream', 'style', 'seed', 'negative_prompt', 'moderation', 'output_format', 'background', 'image']) {
        if (body[field] !== undefined) throw fail(`${field} is not supported by this text-to-image endpoint.`);
    }
    if (body.subscriptions?.codex?.backend && body.subscriptions.codex.backend !== 'subscription') throw fail('Image generation is subscription-only; API/Auto backends are not supported.');
    const model = body.model ?? 'codex-image';
    if (typeof model !== 'string' || (model !== 'codex-image' && !/^gpt-(?!image)[A-Za-z0-9._-]{1,100}$/.test(model))) {
        throw fail('model must be codex-image (the account default), or an available Codex chat model id.');
    }
    return { prompt: body.prompt.trim(), model };
}

/** Trust image bytes, never a model-provided local path or URL. */
export function imageFromItem(item) {
    if (item.failure) throw fail(item.failure.message || 'Codex image generation failed.', item.failure.type === 'usageLimitExceeded' ? 429 : 502);
    if (item.status !== 'completed') throw fail(`Codex image generation ended with status ${item.status}.`, 502);
    const b64 = item.result;
    if (typeof b64 !== 'string' || b64.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64) || b64.length % 4 !== 0) {
        throw fail('Codex returned invalid or oversized image data.', 502);
    }
    const bytes = Buffer.from(b64, 'base64');
    const png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
    const webp = bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP';
    if (!png && !jpeg && !webp) throw fail('Codex returned an unsupported image format.', 502);
    return { b64_json: b64, ...(item.revisedPrompt ? { revised_prompt: item.revisedPrompt } : {}), format: png ? 'png' : jpeg ? 'jpg' : 'webp' };
}

export async function runImageTurn({ server, prompt, model, signal, timeoutMs = 10 * 60 * 1000, interruptGraceMs = 3000 }) {
    if (signal?.aborted) throw abortError();
    const started = await server.request('thread/start', {
        model, modelProvider: 'openai', cwd: runtimeDir('codex-image-cwd'), ephemeral: true,
        approvalPolicy: 'never', sandbox: 'read-only', personality: 'none', developerInstructions: '',
        baseInstructions: 'Generate exactly one image using the built-in image generation tool. Treat the user input as an image description. Do not use shell, commands, file editing, web search, MCP, subagents or API keys. Do not provide only a textual description instead of generating an image.',
        config: { model_reasoning_effort: 'low' },
    }, { timeoutMs: 60000 });
    const threadId = started?.thread?.id;
    if (!threadId) throw fail('Codex did not return an image thread id.', 502);
    const release = () => server.request('thread/unsubscribe', { threadId }, { timeoutMs: 5000 }).catch(() => {});
    try {
        const sources = (started.instructionSources ?? []).filter(p => {
            try { return readFileSync(String(p), 'utf8').trim().length > 0; } catch { return true; }
        });
        if (sources.length) throw fail('Codex would inject global AGENTS.md instructions. Use a dedicated ST_SUBSCRIPTIONS_CODEX_HOME without global instructions.', 400);
        if (started.model && started.model.toLowerCase() !== model.toLowerCase()) throw fail(`Codex selected ${started.model} instead of ${model}; model substitution is not allowed.`, 422);
        return await new Promise((resolve, reject) => {
            let turnId, image, failure, finished = false, interruptWanted = false, interruptSent = false, grace;
            const interrupt = () => {
                interruptWanted = true;
                if (turnId && !interruptSent) {
                    interruptSent = true;
                    server.request('turn/interrupt', { threadId, turnId }, { timeoutMs: 5000 }).catch(() => {});
                }
            };
            const finish = error => {
                if (finished) return;
                finished = true;
                clearTimeout(timer); clearTimeout(grace);
                signal?.removeEventListener('abort', onAbort);
                off();
                if (error) reject(error);
                else if (!image) reject(fail('Codex completed without generating an image. No API-key fallback was attempted.', 502));
                else resolve(image);
            };
            const stop = error => {
                if (finished || failure) return;
                failure = error;
                interrupt();
                grace = setTimeout(() => finish(error), interruptGraceMs);
            };
            const onAbort = () => stop(abortError());
            const timer = setTimeout(() => stop(fail('Codex image generation timed out.', 504)), timeoutMs);
            const off = server.subscribeThread(threadId, msg => {
                const p = msg.params ?? {};
                if (p.turn?.id && !turnId) { turnId = p.turn.id; if (interruptWanted) interrupt(); }
                if (msg.method === 'item/started' && FORBIDDEN_ITEMS.has(p.item?.type)) stop(fail(`Codex attempted unsupported tool ${p.item.type}.`, 502));
                if (msg.method === 'item/completed' && p.item?.type === 'imageGeneration') {
                    try {
                        if (image) throw fail('Codex returned more than one image; this endpoint expects one.', 502);
                        image = imageFromItem(p.item);
                    } catch (err) { stop(err); }
                }
                if (msg.method === 'model/rerouted') stop(fail('Codex rerouted the image request to a different model; the request was stopped.', 422));
                if (msg.method === 'error' && !p.willRetry) stop(codexTurnError(p.error));
                if (msg.method === 'st/exit') finish(fail('Codex app-server exited during image generation.', 502));
                if (msg.method === 'turn/completed') finish(failure ?? (p.turn?.error ? codexTurnError(p.turn.error) : p.turn?.status !== 'completed' ? fail(`Codex turn ${p.turn?.status ?? 'failed'}.`, 502) : null));
            });
            signal?.addEventListener('abort', onAbort, { once: true });
            if (signal?.aborted) { finish(abortError()); return; }
            server.request('turn/start', { threadId, effort: 'low', input: [{ type: 'text', text: prompt }] }, { timeoutMs: 60000 }).then(result => {
                turnId ??= result?.turn?.id;
                if (interruptWanted) interrupt();
            }).catch(err => { if (!finished) stop(err); });
        });
    } finally { release(); }
}

export async function generateCodexImage(body, { signal, getServer = getImageAppServer } = {}) {
    const { prompt, model: requested } = validateImageRequest(body);
    if (signal?.aborted) throw abortError();
    const server = await getServer();
    await assertChatgptLogin(server);
    assertOpenAiEndpoints(server.effectiveConfig, server.codexHome);
    let capabilities;
    try { capabilities = await server.request('modelProvider/capabilities/read', {}, { timeoutMs: 15000 }); }
    catch { throw fail('This Codex CLI cannot report image generation support. Update the Codex CLI and try again.', 503); }
    if (!capabilities?.imageGeneration) throw fail('Image generation is unavailable for this Codex provider/account.', 503);
    const catalog = await server.request('model/list', { includeHidden: false }, { timeoutMs: 20000 });
    const models = catalog?.data ?? [];
    const selected = requested === 'codex-image' ? models.find(m => m.isDefault) ?? models[0] : models.find(m => (m.model || m.id) === requested);
    if (!selected) throw fail('The requested Codex model is not available to this account.', 400);
    const model = selected.model || selected.id;
    const image = await runImageTurn({ server, prompt, model, signal });
    return { created: Math.floor(Date.now() / 1000), data: [image], codex_model: model };
}
