import { mkdir, readFile, writeFile, rename, unlink, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pluginRoot } from '../common/runtime.js';

export const ISSUER = 'https://auth.x.ai';
// Public identifier used by Grok CLI and Hermes; experimental reuse requires opt-in.
export const PUBLIC_CLIENT = 'b1a00492-073a-47ea-816f-4c329264a828';
export function grokClientId() {
    return process.env.ST_SUBSCRIPTIONS_GROK_CLIENT_ID?.trim()
        || (process.env.ST_SUBSCRIPTIONS_GROK_ALLOW_PUBLIC_CLIENT === '1' ? PUBLIC_CLIENT : '');
}

const failure = (message, code = 'oauth_error', httpStatus = 400) => Object.assign(new Error(message), { code, httpStatus });

/** Dependency injection is for offline tests; production endpoints cannot be overridden. */
export function createGrokOAuth({ directory = join(pluginRoot(), '.credentials', 'grok'), fetchImpl = globalThis.fetch,
    clientId = grokClientId, now = Date.now } = {}) {
    const file = join(directory, 'oauth.json');
    let pending = null;
    let queue = Promise.resolve();
    const exclusive = (fn) => {
        const result = queue.then(async () => {
            await mkdir(directory, { recursive: true, mode: 0o700 });
            const lock = join(directory, '.lock');
            try { await mkdir(lock, { mode: 0o700 }); }
            catch (e) {
                if (e.code === 'EEXIST') throw failure('Grok credentials are in use by another process. If it crashed, stop all plugin instances and remove .credentials/grok/.lock.', 'credentials_locked', 409);
                throw e;
            }
            try { return await fn(); }
            finally { await rmdir(lock); }
        });
        queue = result.catch(() => {});
        return result;
    };
    async function load() {
        try {
            const value = JSON.parse(await readFile(file, 'utf8'));
            if (!value || typeof value.access_token !== 'string' || !value.access_token
                || typeof value.client_id !== 'string' || !value.client_id
                || !Number.isFinite(value.expires_at)
                || (value.refresh_token !== undefined && typeof value.refresh_token !== 'string')) {
                throw new Error('Invalid credential schema');
            }
            return value;
        }
        catch (e) { if (e.code === 'ENOENT') return null; throw failure('Cannot read Grok credentials. Check the credential directory.', 'storage_error', 500); }
    }
    async function save(value) {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const temporary = `${file}.${randomUUID()}.tmp`;
        try {
            await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
            await rename(temporary, file);
        } finally { await unlink(temporary).catch(() => {}); }
    }
    async function post(path, body) {
        const response = await fetchImpl(`${ISSUER}/oauth2/${path}`, {
            method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20000),
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
            body: new URLSearchParams(body),
        });
        let data;
        try { data = await response.json(); } catch { throw failure('Grok authentication returned an invalid response.', 'invalid_response', 502); }
        if (!data || typeof data !== 'object' || Array.isArray(data)) throw failure('Grok authentication returned an invalid response.', 'invalid_response', 502);
        if (!response.ok || data.error) {
            // Never propagate raw upstream bodies (may contain credentials).
            const code = typeof data.error === 'string' && /^[a-z_]{1,80}$/.test(data.error) ? data.error : 'oauth_error';
            throw failure(`Grok authentication: ${code}.`, code, response.status === 429 ? 429 : 400);
        }
        return data;
    }
    function credentials(data, previous, id) {
        if (typeof data.access_token !== 'string' || !data.access_token || !Number.isFinite(data.expires_in) || data.expires_in <= 0
            || (data.token_type !== undefined && (typeof data.token_type !== 'string' || data.token_type.toLowerCase() !== 'bearer'))
            || (data.refresh_token !== undefined && typeof data.refresh_token !== 'string')) {
            throw failure('Grok returned an incomplete token response.', 'invalid_response', 502);
        }
        return { access_token: data.access_token, refresh_token: data.refresh_token || previous?.refresh_token,
            expires_at: now() + data.expires_in * 1000, client_id: id };
    }
    return {
        status: async () => {
            const c = await load();
            return { configured: !!clientId(), loggedIn: !!c?.access_token,
                refreshable: !!c?.refresh_token, expiresAt: c?.expires_at ?? null,
                pending: !!pending && pending.expiresAt > now() };
        },
        start: () => exclusive(async () => {
            const id = clientId();
            if (!id) throw failure('Set ST_SUBSCRIPTIONS_GROK_CLIENT_ID, or opt in to the experimental public client with ST_SUBSCRIPTIONS_GROK_ALLOW_PUBLIC_CLIENT=1.', 'client_not_configured');
            if (pending && pending.expiresAt > now()) throw failure('A Grok login is already pending. Cancel it before starting another.', 'login_pending', 409);
            const d = await post('device/code', { client_id: id, scope: 'openid profile email offline_access grok-cli:access api:access' });
            let url;
            try { url = new URL(d.verification_uri); }
            catch { throw failure('Grok returned an invalid verification URL.', 'invalid_response', 502); }
            if (url.protocol !== 'https:' || !['auth.x.ai', 'accounts.x.ai'].includes(url.hostname) || url.username || url.password || url.port) {
                throw failure('Grok returned an unexpected verification URL.', 'invalid_response', 502);
            }
            if (!d.device_code || !d.user_code || !Number.isFinite(d.expires_in) || d.expires_in <= 0) throw failure('Invalid device authorization response.', 'invalid_response', 502);
            const interval = Math.max(5, Number(d.interval) || 5) * 1000;
            pending = { id, code: d.device_code, interval, next: now() + interval, expiresAt: now() + d.expires_in * 1000 };
            return { verificationUri: url.href, userCode: d.user_code, intervalMs: interval, expiresAt: pending.expiresAt };
        }),
        poll: () => exclusive(async () => {
            if (!pending || pending.expiresAt <= now()) { pending = null; throw failure('Grok login expired or was cancelled.', 'expired_token'); }
            if (now() < pending.next) return { state: 'pending', intervalMs: pending.next - now() };
            pending.next = now() + pending.interval;
            try {
                const data = await post('token', { client_id: pending.id, device_code: pending.code, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' });
                await save(credentials(data, null, pending.id));
                pending = null;
                return { state: 'connected' };
            } catch (e) {
                if (e.code === 'slow_down') { pending.interval += 5000; pending.next = now() + pending.interval; }
                else if (e.code !== 'authorization_pending') { pending = null; throw e; }
                return { state: 'pending', intervalMs: pending.interval };
            }
        }),
        cancel: () => exclusive(async () => { pending = null; return { ok: true }; }),
        logout: () => exclusive(async () => {
            pending = null;
            await unlink(file).catch((e) => { if (e.code !== 'ENOENT') throw e; });
            return { ok: true };
        }),
        token: ({ force = false, rejectedToken } = {}) => exclusive(async () => {
            const c = await load();
            if (!c?.access_token) throw failure('Sign in to Grok in Subscriptions first.', 'login_required', 401);
            // Another concurrent request may already have refreshed the rejected token.
            if (rejectedToken && c.access_token !== rejectedToken) return c.access_token;
            if (!force && c.expires_at > now() + 120000) return c.access_token;
            if (!c.refresh_token) throw failure('Grok login expired. Sign in again.', 'login_required', 401);
            try {
                const data = await post('token', { client_id: c.client_id, refresh_token: c.refresh_token, grant_type: 'refresh_token' });
                const updated = credentials(data, c, c.client_id);
                await save(updated);
                return updated.access_token;
            } catch (e) {
                if (e.code === 'invalid_grant') throw failure('Grok login can no longer be refreshed. Sign in again.', 'login_required', 401);
                throw e;
            }
        }),
    };
}

export const grokOAuth = createGrokOAuth();
