# Grok subscription OAuth (experimental)

Grok is a fourth provider in Subscriptions. It does not require a separate Grok
proxy or Grok CLI installation.

Implemented: device authorization, plugin-owned credential storage, token refresh,
live model discovery, text chat through Responses,
streaming/non-streaming output, reasoning summaries when returned, stop sequences,
cancellation, and administrator-only login controls in the panel.

Live verified on 2026-10-16: device OAuth approval, subscription model discovery,
and a streamed Grok 4.7 reply through the official CLI subscription proxy (HTTP
200). The proxy reported unified weekly billing. Full invoice reconciliation and
complete device-login UI interaction remains unverified. Deployed localhost
chat also passed: JSON transport returned a completed response, and streaming
Chinese tavern roleplay preserved names from prior turns. An exact-codeword
prompt was refused by the model; this integration does not remove upstream
model policies. The proxy returned more total/output tokens than the requested
max_output_tokens, so that field must not be treated as a strict usage cap.

## Before using

- Use an active Grok subscription and the browser login associated with it.
- Confirm access to `https://auth.x.ai` and `https://cli-chat-proxy.grok.com` from the server.
- Run the server as your own OS user. Credentials are host-wide, shared by users
  able to use this plugin's chat endpoint. Only ST administrators can replace them.
- Configure a client ID accepted by xAI for device authorization:

  ```powershell
  $env:ST_SUBSCRIPTIONS_GROK_CLIENT_ID = '<your-client-id>'
  ```

  A public client identifier exists in Grok/Hermes implementations. For an explicit
  experimental test using that identity instead, set:

  ```powershell
  $env:ST_SUBSCRIPTIONS_GROK_ALLOW_PUBLIC_CLIENT = '1'
  ```

  This is not a client secret. It is also not evidence of xAI approval for this
  extension. We have not established a general third-party registration procedure.
  The preset is off by default and may be rejected or changed upstream.

These environment variables must be set in the process launching SillyTavern (or
the diagnostic below). Restart the server after changing them. Never put tokens
into Include Body, browser settings, screenshots, or source control.

## Standalone live verification

Run from this repository. `status` does not make network calls. `login` contacts
the authorization server; you must approve it yourself in your browser. `models`
contacts the inference API without generating text. `probe` explicitly generates
one small reply and consumes account usage.

```powershell
node scripts/grok-auth.mjs status
node scripts/grok-auth.mjs login
node scripts/grok-auth.mjs models
node scripts/grok-auth.mjs probe <model-id-returned-by-models>
```

Record account subscription usage and API billing before and after the probe. A
successful login or inference response alone does not prove the billing source.
The plugin never reads `XAI_API_KEY`, ST's Custom API key, or a relay key for Grok.
It does not switch to paid API credentials after an error.

The upstream is the fixed first-party subscription proxy
`https://cli-chat-proxy.grok.com/v1/responses`. The initial public API path
returned an API-spend rate tier of 0/0 for this subscription-only account; it has
been removed from this provider. Model discovery also uses the subscription
proxy, which listed Grok 4.7 for the tested account. The proxy requires a session-auth selector, model override and client version
headers, as documented in the official Grok source. The adapter sends its own
package version and `sillytavern-subscriptions` identity; it does not claim to be
an installed Grok CLI. Responses always streams upstream, then accumulates
JSON for non-streaming SillyTavern clients.

## SillyTavern

Install this branch's server plugin and its matching `index.js`/`manifest.json`/
`style.css` panel. Enable server plugins, restart, and hard-refresh the browser.
If a newer panel (for example the separate image branch) is already installed,
the version-gated installer may keep it; use a separate test installation with
this branch's matching panel. Do not overwrite another branch's working setup.

Open Extensions → Subscriptions → Grok. As an ST administrator, click **Sign in
to Grok**, open the authorization link, and enter the displayed code. Then choose
**Grok subscription only**, connect, and select a live-discovered model. You can
also enter a known entitled model ID manually when discovery is unavailable.
The provider endpoint is `http://127.0.0.1:8901/grok/v1` with the default listener.

Only text messages are supported in this first version. Images, files, tool-call
histories and agent tools are rejected. Model discovery is a catalogue, not proof
of per-model entitlement or text capability. Context and reasoning metadata come from the subscription catalogue. The Grok
drawer offers Auto/Low/Medium/High/Extra High effort, supported by the tested
Grok 4.7 catalogue. No quota meter or fixed model list is advertised. Responses sends
the full conversation with `store: false` and no tools; server-side model policies
still apply. Reasoning summaries are shown only when the upstream returns them.

## Credentials and troubleshooting

Tokens live in `.credentials/grok/oauth.json`, outside disposable `.runtime/` and
excluded by Git. Writes use a temporary file and atomic replacement. Unix modes
are 0700/0600; on Windows protect the repository with your user account's NTFS
permissions (POSIX mode bits do not provide Windows ACL isolation). Do not serve
this directory through a web server or share it between installations.

Refresh is serialized and protected by a cross-process lock. Concurrent processes
using the same store receive a busy error instead of racing refresh-token
rotation. After a process crash, stop all instances before removing the empty
`.credentials/grok/.lock` directory. Tokens from Grok CLI, Kilo and other apps are
never imported or refreshed.

- 401: one refresh/retry before visible output; if refresh fails, sign in again.
- 403: model/client access was refused; credentials remain saved. No paid fallback.
- 429: quota or rate limiting; reauthentication is not attempted automatically.
- Premature stream end: report failure and preserve partial output.
- **Cancel login** cancels the local pending flow. **Sign out** and CLI `logout`
  remove local credentials; they do not revoke the grant at xAI. Revoke provider
  authorization through the account if needed.

## Verification

Offline tests run without model credentials or external requests:

```powershell
$env:ST_ROOT = 'C:\path\to\SillyTavern'
npm test
```

The Grok suite covers polling cadence, slowdown, denial, expiry, cancellation,
secret redaction, restart persistence, concurrent refresh/rotation, refresh
failure, cross-process locking, malformed storage, endpoint pinning, model
discovery, one-time 401 retry, 403/429 handling, text-only validation, Responses
JSON/SSE, split UTF-8, stop cancellation, truncated streams, admin controls and
UI settings migration. See `test/grok.test.js`.

Live acceptance: login → discover models → short probe → verify billing/usage →
ST role/system instruction and multi-turn history → streaming and non-streaming →
cancel → expired-token refresh → restart persistence → local sign-out. Long-chat
limits and real quota exhaustion require account-specific testing; do not burn a
subscription just to reproduce quota exhaustion.

## References

- [xAI discovery metadata](https://auth.x.ai/.well-known/openid-configuration)
- [xAI announcement of subscription OAuth in Kilo](https://x.ai/news/grok-kilocode)
- [Kilo documentation, including refresh rotation](https://kilo.ai/docs/ai-providers/xai)
- [Hermes OAuth constants](https://github.com/NousResearch/hermes-agent/blob/main/hermes_cli/auth_constants.py)
- [xAI Responses guidance](https://docs.x.ai/developers/model-capabilities/text/best-practices)

- [Official Grok source: proxy API access and required headers](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-shell/README.md)

The implementation is original code informed by these protocol references.
