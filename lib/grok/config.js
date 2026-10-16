import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pluginRoot } from '../common/runtime.js';

// Session OAuth goes to the subscription proxy. The public API has separate
// API-spend rate tiers and must never be an automatic subscription fallback.
export const GROK_BASE = 'https://cli-chat-proxy.grok.com/v1';
const VERSION = JSON.parse(readFileSync(join(pluginRoot(), 'package.json'), 'utf8')).version;
export function grokHeaders(token, model) {
    return {
        Authorization: `Bearer ${token}`,
        'X-XAI-Token-Auth': 'xai-grok-cli',
        // The proxy requires a version header. Identify this adapter honestly.
        'x-grok-client-version': VERSION,
        'x-grok-client-identifier': 'sillytavern-subscriptions',
        'User-Agent': `sillytavern-subscriptions/${VERSION}`,
        ...(model ? { 'x-grok-model-override': model } : {}),
    };
}
