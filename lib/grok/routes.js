import { grokOAuth } from './oauth.js';

// Credential mutations are available only through ST's authenticated, CSRF-protected router.
// This plugin uses one host-wide subscription, so only an ST administrator may replace it.
export function mountGrokRoutes(router, wrap, oauth = grokOAuth) {
    const admin = (req, res, next) => req.user?.profile?.admin === true ? next()
        : res.status(403).json({ error: { message: 'A SillyTavern administrator must manage the host Grok login.' } });
    for (const action of ['start', 'poll', 'cancel', 'logout']) {
        router.post(`/grok/oauth/${action}`, admin, wrap(async (_req, res) => {
            try { res.json(await oauth[action]()); }
            catch (e) { res.status(e.httpStatus || 502).json({ error: { message: e.code ? e.message : 'Grok authentication failed. Check connectivity and credential storage.', code: e.code || 'oauth_error' } }); }
        }));
    }
}
