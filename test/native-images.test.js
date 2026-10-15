import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { codexImageProvider } from '../index.js';

test('native provider generates through same-origin route without performing its own chat upload', async () => {
    const calls = [];
    const controller = new AbortController();
    const provider = codexImageProvider({ getContext: () => ({ getRequestHeaders: () => ({ 'X-CSRF-Token': 'test' }) }), fetchImpl: async (url, options) => {
        calls.push({ url, options });
        return { ok: true, json: async () => ({ data: [{ b64_json: 'image-bytes', format: 'png' }] }) };
    } });
    assert.deepEqual(await provider.generate({ prompt: 'night sky', signal: controller.signal }), { data: 'image-bytes', format: 'png' });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, '/api/plugins/subscriptions/images/generations');
    assert.equal(calls[0].options.signal, controller.signal);
    assert.equal(calls[0].options.headers['X-CSRF-Token'], 'test');
    assert.deepEqual(JSON.parse(calls[0].options.body), { model: 'codex-image', prompt: 'night sky', n: 1, response_format: 'b64_json' });
    assert.equal(provider.promptOnly, true);
});

test('native provider surfaces subscription errors and refuses disabled requests', async () => {
    const provider = codexImageProvider({ getContext: () => ({ getRequestHeaders: () => ({}) }), fetchImpl: async () => ({ ok: false, json: async () => ({ error: { message: 'quota exceeded' } }) }) });
    await assert.rejects(provider.generate({ prompt: 'night' }), /quota exceeded/);
    const disabled = codexImageProvider({ isEnabled: () => false });
    await assert.rejects(disabled.generate({ prompt: 'night' }), /Enable Subscriptions/);
});

test('companion native registry handles registration, validation and cleanup', { skip: !process.env.ST_ROOT }, async () => {
    const registry = await import(pathToFileURL(join(process.env.ST_ROOT, 'public/scripts/extensions/stable-diffusion/providers.js')));
    let changed = 0;
    const off = registry.onImageGenerationProvidersChanged(() => changed++);
    const descriptor = codexImageProvider({});
    const cleanup = registry.registerImageGenerationProvider(descriptor);
    assert.equal(registry.getImageGenerationProvider(descriptor.id).label, descriptor.label);
    assert.throws(() => registry.registerImageGenerationProvider(descriptor), /already registered/);
    assert.throws(() => registry.registerImageGenerationProvider({ ...descriptor, id: 'openai' }), /Invalid/);
    cleanup(); cleanup(); off();
    assert.equal(registry.getImageGenerationProvider(descriptor.id), undefined);
    assert.equal(changed, 2);
});

test('companion installer applies, detects existing patch, reverses and refuses conflicts', { skip: !process.env.ST_ROOT }, () => {
    const fixture = mkdtempSync(join(tmpdir(), 'st-native-images-'));
    const relative = 'public/scripts/extensions/stable-diffusion/index.js';
    const original = spawnSync('git', ['-C', process.env.ST_ROOT, 'show', `HEAD:${relative}`], { encoding: 'utf8', windowsHide: true });
    assert.equal(original.status, 0);
    mkdirSync(join(fixture, 'public/scripts/extensions/stable-diffusion'), { recursive: true });
    writeFileSync(join(fixture, 'server.js'), '// test fixture');
    writeFileSync(join(fixture, relative), original.stdout);
    const run = (...args) => spawnSync(process.execPath, ['scripts/install-native-images.mjs', fixture, ...args], { encoding: 'utf8', windowsHide: true });
    try {
        assert.equal(run().status, 0);
        assert.ok(existsSync(join(fixture, 'public/scripts/extensions/stable-diffusion/providers.js')));
        assert.match(run().stdout, /already installed/);
        assert.equal(run('--reverse').status, 0);
        assert.equal(readFileSync(join(fixture, relative), 'utf8').replace(/\r\n/g, '\n'), original.stdout.replace(/\r\n/g, '\n'));
        assert.equal(existsSync(join(fixture, 'public/scripts/extensions/stable-diffusion/providers.js')), false);
        writeFileSync(join(fixture, relative), 'conflicting source\n');
        assert.notEqual(run().status, 0);
        assert.equal(readFileSync(join(fixture, relative), 'utf8'), 'conflicting source\n');
    } finally {
        assert.ok(fixture.startsWith(join(tmpdir(), 'st-native-images-')));
        rmSync(fixture, { recursive: true, force: true });
    }
});
