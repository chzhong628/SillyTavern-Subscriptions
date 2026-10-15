import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { isolationOverrides } from '../lib/codex/config.js';
import { generateCodexImage, runImageTurn, validateImageRequest, imageFromItem } from '../lib/codex/images.js';
import { handleImageGenerations } from '../lib/listener.js';
import { generateImageInChat } from '../index.js';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=';
const item = { type: 'imageGeneration', id: 'image', status: 'completed', result: png };
class ImageServer {
    constructor({ accountType = 'chatgpt', capabilities = true, script, turnStart } = {}) {
        Object.assign(this, { accountType, capabilities, script, turnStart, calls: [], listeners: new Set(), effectiveConfig: {} });
    }
    async request(method, params) {
        this.calls.push({ method, params });
        if (method === 'account/read') return { account: { type: this.accountType } };
        if (method === 'modelProvider/capabilities/read') return { imageGeneration: this.capabilities };
        if (method === 'model/list') return { data: [{ model: 'gpt-test', isDefault: true }] };
        if (method === 'thread/start') return { thread: { id: 'thread' }, model: params.model };
        if (method === 'turn/start') {
            if (this.turnStart) return this.turnStart(this);
            setImmediate(() => this.script ? this.script(this) : this.complete());
            return { turn: { id: 'turn' } };
        }
        return {};
    }
    subscribeThread(_id, listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
    emit(method, params = {}) { for (const fn of this.listeners) fn({ method, params: { threadId: 'thread', ...params } }); }
    complete() {
        this.emit('item/completed', { item });
        this.emit('turn/completed', { turn: { id: 'turn', status: 'completed' } });
    }
}

test('image process enables only image generation; chat isolation stays tool-less', () => {
    const chat = isolationOverrides({});
    const images = isolationOverrides({}, { imageGeneration: true });
    assert.ok(chat.includes('features.image_generation=false'));
    assert.ok(images.includes('features.image_generation=true'));
    for (const feature of ['shell_tool', 'unified_exec', 'view_image', 'multi_agent', 'apps', 'plugins']) assert.ok(images.includes(`features.${feature}=false`));
});

test('image request rejects unsupported controls and API billing before starting a server', async () => {
    for (const body of [{ prompt: '' }, { prompt: 'x', n: 2 }, { prompt: 'x', size: '1024x1024' }, { prompt: 'x', response_format: 'url' }, { prompt: 'x', model: 'gpt-image-2' }, { prompt: 'x', subscriptions: { codex: { backend: 'auto' } } }]) {
        let called = false;
        await assert.rejects(generateCodexImage(body, { getServer: () => { called = true; } }), { httpStatus: 400 });
        assert.equal(called, false);
    }
    assert.deepEqual(validateImageRequest({ prompt: ' boat ' }), { prompt: 'boat', model: 'codex-image' });
});

test('subscription gate refuses API login and foreign endpoints before a turn', async () => {
    const api = new ImageServer({ accountType: 'apiKey' });
    await assert.rejects(generateCodexImage({ prompt: 'x' }, { getServer: async () => api }), /never uses a key/);
    assert.ok(!api.calls.some(c => c.method === 'thread/start'));
    const relay = new ImageServer();
    relay.effectiveConfig.chatgpt_base_url = 'https://relay.example';
    await assert.rejects(generateCodexImage({ prompt: 'x' }, { getServer: async () => relay }), /will not send/);
    assert.ok(!relay.calls.some(c => c.method === 'thread/start'));
});

test('capability and catalog gates fail without starting generation', async () => {
    const server = new ImageServer({ capabilities: false });
    await assert.rejects(generateCodexImage({ prompt: 'x' }, { getServer: async () => server }), { httpStatus: 503 });
    const unknown = new ImageServer();
    await assert.rejects(generateCodexImage({ prompt: 'x', model: 'gpt-unknown' }, { getServer: async () => unknown }), /not available/);
    assert.ok(!unknown.calls.some(c => c.method === 'turn/start'));
});

test('successful image returns bytes, selected model, and releases its ephemeral thread', async () => {
    const server = new ImageServer();
    const result = await generateCodexImage({ prompt: 'blue boat' }, { getServer: async () => server });
    assert.equal(result.data[0].b64_json, png);
    assert.equal(result.data[0].format, 'png');
    assert.equal(result.codex_model, 'gpt-test');
    assert.equal(server.calls.find(c => c.method === 'thread/start').params.modelProvider, 'openai');
    assert.equal(server.calls.find(c => c.method === 'thread/start').params.sandbox, 'read-only');
    assert.ok(server.calls.some(c => c.method === 'thread/unsubscribe'));
    assert.equal(server.listeners.size, 0);
});

test('quota failures, text-only replies and tool escapes return errors', async () => {
    const cases = [
        { script: s => { s.emit('item/completed', { item: { ...item, failure: { type: 'usageLimitExceeded', message: 'Image quota exhausted' } } }); s.emit('turn/completed', { turn: { status: 'completed' } }); }, status: 429 },
        { script: s => s.emit('turn/completed', { turn: { status: 'completed' } }), status: 502 },
        { script: s => { s.emit('item/started', { item: { type: 'commandExecution' } }); s.emit('turn/completed', { turn: { status: 'interrupted' } }); }, status: 502 },
        { script: s => { s.emit('model/rerouted', {}); s.emit('turn/completed', { turn: { status: 'interrupted' } }); }, status: 422 },
    ];
    for (const { script, status } of cases) {
        const server = new ImageServer({ script });
        await assert.rejects(runImageTurn({ server, model: 'gpt-test', prompt: 'x' }), { httpStatus: status });
        assert.equal(server.listeners.size, 0);
    }
    assert.throws(() => imageFromItem({ ...item, result: Buffer.from('not an image').toString('base64'), savedPath: 'C:/secrets' }), /unsupported image/);
});

test('cancelling while turn/start is pending interrupts when its id arrives', async () => {
    const ac = new AbortController();
    let returnTurn;
    const server = new ImageServer({ turnStart: () => new Promise(resolve => { returnTurn = resolve; }) });
    const result = runImageTurn({ server, prompt: 'x', model: 'gpt-test', signal: ac.signal, interruptGraceMs: 30 });
    await new Promise(resolve => setImmediate(resolve));
    ac.abort();
    returnTurn({ turn: { id: 'delayed-turn' } });
    await assert.rejects(result, { name: 'AbortError' });
    assert.ok(server.calls.some(c => c.method === 'turn/interrupt' && c.params.turnId === 'delayed-turn'));
    assert.equal(server.listeners.size, 0);
});

test('image deadline interrupts and cleans up a silent turn', async () => {
    const server = new ImageServer({ script: () => {} });
    await assert.rejects(runImageTurn({ server, prompt: 'x', model: 'gpt-test', timeoutMs: 10, interruptGraceMs: 10 }), { httpStatus: 504 });
    assert.ok(server.calls.some(c => c.method === 'turn/interrupt'));
    assert.equal(server.listeners.size, 0);
});

test('HTTP image handler preserves upstream status and aborts on client disconnect', async () => {
    class Response extends EventEmitter {
        status(value) { this.statusCode = value; return this; }
        json(value) { this.body = value; this.writableFinished = true; this.writableEnded = true; }
        end() { this.writableEnded = true; }
    }
    const res = new Response();
    await handleImageGenerations({ body: { prompt: 'x' } }, res, async () => { throw Object.assign(new Error('quota'), { httpStatus: 429 }); });
    assert.equal(res.statusCode, 429);
    assert.equal(res.body.error.message, 'quota');
    const disconnected = new Response();
    const pending = handleImageGenerations({ body: {} }, disconnected, async (_body, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })));
    disconnected.emit('close');
    await pending;
    assert.equal(disconnected.body, undefined);
    assert.equal(disconnected.writableEnded, true);
});

function chatFixture() {
    const ctx = { chatId: 'one', characterId: 0, name2: 'Test character', chat: [], getRequestHeaders: () => ({ 'X-CSRF-Token': 'test' }), ensureMessageMediaIsArray() {}, eventSource: { emit: async () => {} }, eventTypes: { MESSAGE_RECEIVED: 'received', CHARACTER_MESSAGE_RENDERED: 'rendered' }, addOneMessage() {}, saveChat: async () => {} };
    const calls = [];
    const fetchImpl = async (path, options) => {
        calls.push({ path, options });
        return { ok: true, json: async () => path.endsWith('/upload') ? { path: '/user/images/boat.png' } : { data: [{ b64_json: png, format: 'png' }], codex_model: 'gpt-test' } };
    };
    return { ctx, calls, fetchImpl };
}

test('UI generates over same-origin routes, uploads and posts a media attachment', async () => {
    const { ctx, calls, fetchImpl } = chatFixture();
    const path = await generateImageInChat('Blue boat', { getContext: () => ctx, fetchImpl });
    assert.equal(path, '/user/images/boat.png');
    assert.deepEqual(calls.map(c => c.path), ['/api/plugins/subscriptions/images/generations', '/api/images/upload']);
    assert.equal(calls[0].options.headers['X-CSRF-Token'], 'test');
    assert.equal(ctx.chat[0].extra.media[0].url, path);
    assert.equal(ctx.chat[0].extra.subscriptions_image.model, 'gpt-test');
    assert.match(ctx.chat[0].send_date, /^\d{4}-\d{2}-\d{2}T.*Z$/);
});

test('UI never posts to a different chat after a long image generation', async () => {
    const { ctx, calls, fetchImpl } = chatFixture();
    await assert.rejects(generateImageInChat('boat', { getContext: () => ctx, fetchImpl: async (...args) => { const response = await fetchImpl(...args); ctx.chatId = 'two'; return response; } }), /chat changed/);
    assert.equal(ctx.chat.length, 0);
    assert.equal(calls.length, 1);
});

test('UI surfaces quota failure without attempting an upload', async () => {
    const { ctx } = chatFixture();
    let calls = 0;
    await assert.rejects(generateImageInChat('boat', { getContext: () => ctx, fetchImpl: async () => { calls++; return { ok: false, status: 429, text: async () => JSON.stringify({ error: { message: 'Image quota exhausted' } }) }; } }), /Image quota exhausted/);
    assert.equal(calls, 1);
    assert.equal(ctx.chat.length, 0);
});
