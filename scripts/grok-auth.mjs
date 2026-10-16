#!/usr/bin/env node
// Explicit live diagnostics. Never print OAuth tokens or use an API-key fallback.
import { setTimeout as delay } from 'node:timers/promises';
import { grokOAuth } from '../lib/grok/oauth.js';
import { grokModelEntries, runGrokChat } from '../lib/grok/provider.js';
import { CompletionWriter } from '../lib/common/completion.js';

const [action = 'status', model] = process.argv.slice(2);
try {
    if (action === 'status') console.log(JSON.stringify(await grokOAuth.status(), null, 2));
    else if (action === 'login') {
        const login = await grokOAuth.start();
        console.log(`Open ${login.verificationUri}\nEnter code: ${login.userCode}\nWaiting for browser authorization (Ctrl+C to stop).`);
        let interval = login.intervalMs;
        while (true) {
            await delay(interval);
            const result = await grokOAuth.poll();
            if (result.state === 'connected') { console.log('OAuth credentials saved locally. Subscription inference is not yet verified.'); break; }
            interval = result.intervalMs;
        }
    } else if (action === 'logout') {
        await grokOAuth.logout(); console.log('Local Grok credentials removed.');
    } else if (action === 'models') {
        console.log(JSON.stringify(await grokModelEntries(), null, 2));
    } else if (action === 'probe') {
        if (!model || !/^grok-[A-Za-z0-9._-]{1,100}$/.test(model)) throw new Error('Usage: node scripts/grok-auth.mjs probe <model-id-from-models>');
        console.log('Sending one short OAuth inference request. This consumes account usage; verify subscription usage and billing in your account.');
        const controller = new AbortController();
        process.once('SIGINT', () => controller.abort());
        const res = { destroyed: false, writableEnded: false, headersSent: false,
            setHeader() {}, flushHeaders() {}, write(chunk) { process.stdout.write(chunk); },
            end() { this.writableEnded = true; }, json(data) { this.writableEnded = true; console.log(JSON.stringify(data, null, 2)); },
            status() { return this; } };
        const writer = new CompletionWriter({ res, stream: true, model });
        await runGrokChat({ model, messages: [{ role: 'system', content: 'Reply concisely in Chinese.' },
            { role: 'user', content: '请只回复：连接成功' }], settings: { grok: { backend: 'subscription', effort: 'low' }, maxTokens: 128 }, writer, signal: controller.signal });
    } else throw new Error('Commands: status | login | logout | models | probe <model-id>');
} catch (e) {
    // Do not print raw error objects, response bodies, or credential-bearing request options.
    console.error(e.code ? `${e.code}: ${e.message}` : (e.httpStatus ? `Grok HTTP ${e.httpStatus}: ${e.message}` : 'Grok diagnostic failed. Check network, command arguments and credential storage.'));
    process.exitCode = 1;
}
