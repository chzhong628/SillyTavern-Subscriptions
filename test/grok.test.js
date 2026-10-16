import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGrokOAuth } from '../lib/grok/oauth.js';
import { runGrokChat, grokModelEntries } from '../lib/grok/provider.js';
import { runGrokResponses, responsesInput } from '../lib/grok/responses.js';
import { mountGrokRoutes } from '../lib/grok/routes.js';
import { CompletionWriter } from '../lib/common/completion.js';
import { buildSubscriptionsBlock, loadSettings, endpointFor, providerReadiness, grokAuthControls } from '../index.js';
import { extractRequestSettings } from '../lib/settings.js';
import { resolveProvider } from '../lib/router.js';
import { buildApp } from '../lib/listener.js';
import { grokHeaders } from '../lib/grok/config.js';

const json = (data, status = 200) => new Response(JSON.stringify(data), { status });
const device = { device_code: 'DEVICE-SECRET', user_code: 'ABCD-EFGH', verification_uri: 'https://auth.x.ai/activate', expires_in: 600, interval: 5 };
const tokens = { access_token: 'ACCESS-SECRET', refresh_token: 'REFRESH-SECRET', expires_in: 3600, token_type: 'Bearer' };

async function fixture(t, responses, opts = {}) {
    const directory = await mkdtemp(join(tmpdir(), 'st-grok-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    let clock = 1000000;
    const calls = [];
    const oauth = createGrokOAuth({ directory, clientId: () => 'test-client', now: () => clock,
        fetchImpl: async (url, options) => {
            calls.push({ url, options });
            const next = responses.shift();
            assert.ok(next, 'unexpected OAuth request');
            return typeof next === 'function' ? next(url, options) : json(next.body ?? next, next.status ?? 200);
        }, ...opts });
    return { oauth, calls, directory, advance: (ms) => { clock += ms; }, login: async () => { await oauth.start(); clock += 5000; await oauth.poll(); } };
}

test('device login respects polling, redacts secrets and survives restart', async (t) => {
    const f = await fixture(t, [device, tokens]);
    const login = await f.oauth.start();
    assert.equal(JSON.stringify(login).includes(device.device_code), false);
    assert.equal((await f.oauth.poll()).state, 'pending');
    assert.equal(f.calls.length, 1);
    f.advance(5000);
    assert.equal((await f.oauth.poll()).state, 'connected');
    const state = await f.oauth.status();
    assert.equal(state.loggedIn, true);
    assert.equal(JSON.stringify(state).includes('SECRET'), false);
    assert.equal(await f.oauth.token(), tokens.access_token);
    const restarted = createGrokOAuth({ directory: f.directory });
    assert.equal((await restarted.status()).loggedIn, true);
    assert.equal(f.calls[0].options.redirect, 'error');
    assert.equal(f.calls[0].options.body.get('client_id'), 'test-client');
});

test('pending and slow_down increase the polling delay', async (t) => {
    const f = await fixture(t, [device, { status: 400, body: { error: 'authorization_pending' } }, { status: 400, body: { error: 'slow_down' } }, tokens]);
    await f.oauth.start(); f.advance(5000);
    assert.equal((await f.oauth.poll()).intervalMs, 5000);
    f.advance(5000);
    assert.equal((await f.oauth.poll()).intervalMs, 10000);
    f.advance(5000); await f.oauth.poll(); assert.equal(f.calls.length, 3);
    f.advance(5000); assert.equal((await f.oauth.poll()).state, 'connected');
});

test('denial, expiry and cancellation do not save credentials', async (t) => {
    const f = await fixture(t, [device, { status: 400, body: { error: 'access_denied', error_description: tokens.access_token } }, device, device]);
    await f.oauth.start(); f.advance(5000);
    await assert.rejects(f.oauth.poll(), (e) => e.code === 'access_denied' && !e.message.includes(tokens.access_token));
    assert.equal((await f.oauth.status()).loggedIn, false);
    await f.oauth.start(); f.advance(601000);
    await assert.rejects(f.oauth.poll(), { code: 'expired_token' });
    await f.oauth.start(); await f.oauth.cancel();
    await assert.rejects(f.oauth.poll(), { code: 'expired_token' });
});

test('missing client configuration and untrusted verification links fail closed', async (t) => {
    const noClient = await fixture(t, [], { clientId: () => '' });
    await assert.rejects(noClient.oauth.start(), { code: 'client_not_configured' });
    for (const verification_uri of ['https://evil.example/login', 'http://auth.x.ai/login', 'https://auth.x.ai.evil.example', 'https://user@auth.x.ai/login']) {
        const f = await fixture(t, [{ ...device, verification_uri }]);
        await assert.rejects(f.oauth.start(), { code: 'invalid_response' });
    }
});

test('concurrent refresh rotates once, persists latest refresh token and deduplicates rejected tokens', async (t) => {
    const f = await fixture(t, [device, tokens, { ...tokens, access_token: 'NEW', refresh_token: 'ROTATED' }]);
    await f.login(); f.advance(3500000);
    assert.deepEqual(await Promise.all([f.oauth.token(), f.oauth.token(), f.oauth.token()]), ['NEW', 'NEW', 'NEW']);
    assert.equal(f.calls.length, 3);
    assert.equal(JSON.parse(await readFile(join(f.directory, 'oauth.json'))).refresh_token, 'ROTATED');
    assert.equal(await f.oauth.token({ force: true, rejectedToken: tokens.access_token }), 'NEW');
    assert.equal(f.calls.length, 3);
});

test('invalid refresh requires login; logout clears credentials and pending auth', async (t) => {
    const f = await fixture(t, [device, tokens, { status: 400, body: { error: 'invalid_grant' } }, device]);
    await f.login(); f.advance(3600000);
    await assert.rejects(f.oauth.token(), { code: 'login_required', httpStatus: 401 });
    await f.oauth.start(); await f.oauth.logout();
    assert.equal((await f.oauth.status()).loggedIn, false);
    await assert.rejects(f.oauth.poll(), { code: 'expired_token' });
    await assert.rejects(f.oauth.token(), { code: 'login_required' });
});

test('a second process cannot rotate a locked credential store', async (t) => {
    const f = await fixture(t, []);
    await mkdir(join(f.directory, '.lock'));
    await assert.rejects(f.oauth.token(), { code: 'credentials_locked' });
});

test('malformed credentials are reported without leaking their contents', async (t) => {
    const f = await fixture(t, []);
    await writeFile(join(f.directory, 'oauth.json'), '{SECRET');
    await assert.rejects(f.oauth.status(), (e) => e.code === 'storage_error' && !e.message.includes('SECRET'));
});

test('discovery uses fixed origin and returns live Grok IDs only', async () => {
    const data = await grokModelEntries({ oauth: { status: async () => ({ loggedIn: true }), token: async () => 'secret' }, fetchImpl: async (url, opts) => {
        assert.equal(url, 'https://cli-chat-proxy.grok.com/v1/models'); assert.equal(opts.redirect, 'error');
        return json({ data: [{ id: 'grok-test' }, { id: 'unrelated' }, {}] });
    } });
    assert.deepEqual(data.map((m) => m.id), ['grok-test']);
});

test('subscription discovery refreshes a rejected token and keeps proxy metadata', async () => {
    let requests = 0, refreshed = false;
    const models = await grokModelEntries({ oauth: { status: async () => ({ loggedIn: true }), token: async (opts) => {
        if (opts?.force) { refreshed = true; assert.equal(opts.rejectedToken, 'old'); return 'new'; }
        return 'old';
    } }, fetchImpl: async (url, opts) => {
        assert.equal(url, 'https://cli-chat-proxy.grok.com/v1/models');
        assert.equal(opts.headers['X-XAI-Token-Auth'], 'xai-grok-cli');
        assert.equal(opts.headers['x-grok-client-identifier'], 'sillytavern-subscriptions');
        if (++requests === 1) return json({}, 401);
        assert.equal(opts.headers.Authorization, 'Bearer new');
        return json({ data: [{ id: 'grok-4.7', context_window: 256000, reasoning_efforts: [{ id: 'low' }] }] });
    } });
    assert.equal(refreshed, true);
    assert.equal(models[0].context_window, 256000);
    assert.deepEqual(models[0].reasoning_efforts, [{ id: 'low' }]);
});

test('Grok chat refreshes once on 401 but never on forbidden or quota failure', async () => {
    let tokenCalls = 0, calls = 0;
    const oauth = { token: async () => (++tokenCalls === 1 ? 'first' : 'second') };
    const args = { messages: [{ role: 'user', content: '你好' }], model: 'grok-test', settings: {}, writer: { didYieldContent: false } };
    await runGrokChat(args, { oauth, run: async (opts) => {
        calls++; assert.equal(opts.baseUrl, 'https://cli-chat-proxy.grok.com/v1');
        if (calls === 1) throw Object.assign(new Error(), { httpStatus: 401 });
        assert.equal(opts.apiKey, 'second');
    } });
    assert.equal(calls, 2);
    for (const httpStatus of [403, 429]) {
        calls = 0;
        await assert.rejects(runGrokChat(args, { oauth, run: async () => { calls++; throw Object.assign(new Error(), { httpStatus }); } }), { httpStatus });
        assert.equal(calls, 1);
    }
    await assert.rejects(runGrokChat({ ...args, settings: { grok: { backend: 'api' } } }, { oauth }), /fallback is disabled/);
});

test('no retry after visible output; images and tool calls rejected before inference', async () => {
    let calls = 0;
    await assert.rejects(runGrokChat({ messages: [{ role: 'user', content: 'x' }], settings: {}, writer: { didYieldContent: true } }, {
        oauth: { token: async () => 'x' }, run: async () => { calls++; throw Object.assign(new Error(), { httpStatus: 401 }); },
    }), { httpStatus: 401 });
    assert.equal(calls, 1);
    assert.throws(() => responsesInput([{ role: 'user', content: [{ type: 'image_url' }] }]), /text only/);
    assert.throws(() => responsesInput([{ role: 'assistant', tool_calls: [], content: '' }]), /without tool calls/);
});

function writer(stream = false, stops = []) {
    const res = { writableEnded: false, destroyed: false, headersSent: false, chunks: [],
        setHeader() {}, flushHeaders() { this.headersSent = true; },
        write(s) { this.chunks.push(s); }, end() { this.writableEnded = true; },
        json(data) { this.data = data; this.writableEnded = true; }, status() { return this; } };
    return { res, w: new CompletionWriter({ res, stream, model: 'grok-test', stops }) };
}

test('Responses JSON preserves system and history, disables storage/tools, maps usage and truncation', async () => {
    const { res, w } = writer();
    const messages = [{ role: 'system', content: '角色卡' }, { role: 'assistant', content: '历史' }, { role: 'user', content: '继续' }];
    await runGrokResponses({ apiKey: 'secret', model: 'grok-test', messages, extraBody: { max_tokens: 100 }, writer: w }, { upstreamStream: false, fetchImpl: async (url, opts) => {
        assert.equal(url, 'https://cli-chat-proxy.grok.com/v1/responses'); assert.equal(opts.redirect, 'error');
        const body = JSON.parse(opts.body); assert.deepEqual(body.input, messages); assert.deepEqual(body.tools, []); assert.equal(body.store, false); assert.equal(body.max_output_tokens, 100);
        return json({ status: 'incomplete', output: [{ type: 'message', content: [{ type: 'output_text', text: '你好' }] }], usage: { input_tokens: 5, output_tokens: 2 } });
    } });
    assert.equal(res.data.choices[0].message.content, '你好'); assert.equal(res.data.choices[0].finish_reason, 'length'); assert.equal(res.data.usage.total_tokens, 7);
});

const event = (value) => `data: ${JSON.stringify(value)}\r\n\r\n`;

test('JSON clients accumulate subscription SSE; headers identify adapter and effort is forwarded', async () => {
    const { res, w } = writer(false);
    await runGrokResponses({ apiKey: 'secret', model: 'grok-4.7', messages: [], extraBody: { reasoning_effort: 'low' }, writer: w }, { fetchImpl: async (url, opts) => {
        assert.equal(url, 'https://cli-chat-proxy.grok.com/v1/responses');
        const expected = grokHeaders('secret', 'grok-4.7');
        assert.equal(opts.headers['x-grok-model-override'], expected['x-grok-model-override']);
        assert.equal(opts.headers['x-grok-client-identifier'], 'sillytavern-subscriptions');
        assert.equal(opts.headers['x-grok-client-version'], expected['x-grok-client-version']);
        const body = JSON.parse(opts.body); assert.equal(body.stream, true); assert.deepEqual(body.reasoning, { effort: 'low' });
        return new Response(event({ type: 'response.output_text.delta', delta: '连接成功' }) + event({ type: 'response.completed', response: { status: 'completed' } }));
    } });
    assert.equal(res.data.choices[0].message.content, '连接成功');
});

test('Grok effort setting survives UI and server extraction', () => {
    const s = loadSettings({ subscriptions: { grok: { effort: 'low' }, settingsVersion: 3 } });
    const block = buildSubscriptionsBlock(s, {});
    assert.equal(block.grok.effort, 'low');
    assert.equal(extractRequestSettings({ subscriptions: block }).grok.effort, 'low');
    const invalid = loadSettings({ subscriptions: { grok: { effort: 'invalid' }, settingsVersion: 3 } });
    assert.equal(invalid.grok.effort, 'auto');
});
test('Responses streaming handles split UTF-8, reasoning summaries and completion', async () => {
    const { res, w } = writer(true);
    const bytes = new TextEncoder().encode(event({ type: 'response.reasoning_summary_text.delta', delta: '摘要' }) + event({ type: 'response.output_text.delta', delta: '你好' }) + event({ type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 2, output_tokens: 3 } } }));
    await runGrokResponses({ apiKey: 'x', model: 'grok-test', messages: [], writer: w }, { fetchImpl: async () => new Response(new ReadableStream({ start(c) { for (const byte of bytes) c.enqueue(Uint8Array.of(byte)); c.close(); } })) });
    assert.equal(w.text, '你好'); assert.equal(w.reasoning, '摘要'); assert.equal(w.usage.total_tokens, 5); assert.ok(res.chunks.join('').includes('[DONE]'));
});

test('Responses stop sequence cancels the upstream stream', async () => {
    const { w } = writer(true, ['STOP']); let cancelled = false;
    await runGrokResponses({ apiKey: 'x', messages: [], writer: w }, { fetchImpl: async () => new Response(new ReadableStream({ start(c) {
        c.enqueue(new TextEncoder().encode(event({ type: 'response.output_text.delta', delta: 'hello ST' }) + event({ type: 'response.output_text.delta', delta: 'OP extra' })));
    }, cancel() { cancelled = true; } })) });
    assert.equal(w.text, 'hello '); assert.equal(cancelled, true);
});

test('truncated streams fail; cancelled requests never start inference', async () => {
    const { w } = writer(true);
    await assert.rejects(runGrokResponses({ apiKey: 'x', messages: [], writer: w }, { fetchImpl: async () => new Response(event({ type: 'response.output_text.delta', delta: 'partial' })) }), /before a completion event/);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(runGrokResponses({ messages: [], signal: controller.signal }, { fetchImpl: async () => { assert.fail('must not fetch'); } }), /abort/i);
});

test('Responses idle timeout and client cancellation abort an open upstream', async () => {
    for (const cancel of [false, true]) {
        const { w } = writer(true);
        const controller = new AbortController();
        const keepAlive = setTimeout(() => {}, 1000);
        let signal;
        try {
            const task = runGrokResponses({ apiKey: 'x', messages: [], writer: w, signal: controller.signal }, {
                firstByteMs: 100, idleMs: 20,
                fetchImpl: async (_url, opts) => {
                    signal = opts.signal;
                    return new Response(new ReadableStream({ start(c) {
                        c.enqueue(new TextEncoder().encode(': heartbeat\n\n'));
                        signal.addEventListener('abort', () => c.error(new DOMException('Aborted', 'AbortError')), { once: true });
                    } }));
                },
            });
            if (cancel) setTimeout(() => controller.abort(), 5);
            await assert.rejects(task, cancel ? /abort/i : /timed out/);
            assert.equal(signal.aborted, true);
        } finally { clearTimeout(keepAlive); }
    }
});

test('standalone HTTP exposes Grok reads but no credential mutation routes', async (t) => {
    const server = buildApp().listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
    const base = `http://127.0.0.1:${server.address().port}`;
    const root = await (await fetch(base)).json();
    assert.ok(root.providers.some((p) => p.id === 'grok' && p.endpoint === '/grok/v1'));
    assert.equal((await fetch(base + '/grok/oauth/start', { method: 'POST', body: '{}' })).status, 404);
    assert.equal((await fetch(base + '/grok/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'grok-test', messages: [{ role: 'user', content: 'hi' }], subscriptions: { grok: { backend: 'api' } } }) })).status, 400);
});

test('OAuth management routes require admin and never appear on standalone listener', async () => {
    const routes = {};
    mountGrokRoutes({ post: (path, ...handlers) => { routes[path] = handlers; } }, (f) => f, { start: async () => ({ userCode: 'code' }) });
    const [admin, handler] = routes['/grok/oauth/start'];
    let next = false, status;
    const res = { status(n) { status = n; return this; }, json(d) { this.data = d; } };
    admin({}, res, () => { next = true; }); assert.equal(status, 403); assert.equal(next, false);
    admin({ user: { profile: { admin: true } } }, res, () => { next = true; }); assert.equal(next, true);
    await handler({}, res); assert.equal(res.data.userCode, 'code');
});

test('Grok UI settings migrate, route and force subscription-only', () => {
    const s = loadSettings({ subscriptions: { scope: 'grok', grok: { backend: 'api' }, settingsVersion: 3 } });
    assert.equal(s.grok.backend, 'subscription');
    assert.equal(endpointFor(s), 'http://127.0.0.1:8901/grok/v1');
    assert.deepEqual(buildSubscriptionsBlock(s, {}).grok, { backend: 'subscription' });
    assert.equal(extractRequestSettings({ subscriptions: { provider: 'grok' } }).provider, 'grok');
    assert.equal(resolveProvider({ model: 'grok-test' }).provider, 'grok');
    assert.equal(providerReadiness('grok', { backends: { subscription: { ready: false } } }, 'subscription').state, 'sign-in required');
});

test('malformed stored token schemas fail without exposing secrets', async (t) => {
    const f = await fixture(t, []);
    for (const value of [null, {}, { access_token: 'SECRET', client_id: 'id', expires_at: 'tomorrow' }]) {
        await writeFile(join(f.directory, 'oauth.json'), JSON.stringify(value));
        await assert.rejects(f.oauth.status(), (e) => e.code === 'storage_error' && !e.message.includes('SECRET'));
        await assert.rejects(f.oauth.token(), { code: 'storage_error' });
    }
});

test('malformed and oversized multiline SSE events fail and cancel upstream', async () => {
    const badEvents = [
        'data: {SECRET\n\n',
        'data: null\n\n',
        event({ type: 'response.completed', response: {} }),
        ('data: ' + 'x'.repeat(1024) + '\n').repeat(4097) + '\n',
    ];
    for (const content of badEvents) {
        const { w } = writer(true);
        let cancelled = false;
        await assert.rejects(runGrokResponses({ apiKey: 'x', messages: [], writer: w }, {
            fetchImpl: async () => new Response(new ReadableStream({
                start(c) { c.enqueue(new TextEncoder().encode(content)); },
                cancel() { cancelled = true; },
            })),
        }), (e) => /invalid|oversized/.test(e.message) && !e.message.includes('SECRET'));
        assert.equal(cancelled, true);
        assert.equal(w.ended, false);
    }
});

test('null message parts produce a client error before token access', async () => {
    for (const messages of [[null], [{ role: 'user', content: [null] }]]) {
        await assert.rejects(runGrokChat({ messages, settings: {} }, {
            oauth: { token: () => assert.fail('invalid inputs must not request credentials') },
        }), { httpStatus: 400 });
    }
});


test('login controls reflect signed-out, signed-in and pending host state', () => {
    assert.deepEqual(grokAuthControls(null), { signIn: true, signOut: false, cancel: false });
    assert.deepEqual(grokAuthControls({ loggedIn: true }), { signIn: false, signOut: true, cancel: false });
    for (const loggedIn of [true, false]) {
        assert.deepEqual(grokAuthControls({ loggedIn, pending: true }), { signIn: false, signOut: false, cancel: true });
        assert.deepEqual(grokAuthControls({ loggedIn }, true), { signIn: false, signOut: false, cancel: true });
    }
});

test('pending status can recover login controls without disclosing device credentials', async (t) => {
    const f = await fixture(t, [device]);
    await f.oauth.start();
    const status = await f.oauth.status();
    assert.equal(status.pending, true);
    assert.equal(JSON.stringify(status).includes('SECRET'), false);
    assert.equal(JSON.stringify(status).includes(device.user_code), false);
    await f.oauth.cancel();
    assert.equal((await f.oauth.status()).pending, false);
});
