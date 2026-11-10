import { app, shell } from 'electron';
import http from 'http';
import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { loadEnv } from './load-env';
import logger from './logger';

/**
 * Auth0 OAuth (Authorization Code + PKCE) helper for Electron main-process.
 *
 * What you need to configure in Auth0:
 * - Allowed Callback URLs must include:
 *   - Interactive login: http://127.0.0.1:47823/callback
 *   - Silent login fallback: gia://auth/callback
 */

// Ensure env is loaded before reading process.env into defaults.
loadEnv();

function ensureRequiredScopes(scopes) {
    const parts = String(scopes || '')
        .split(/\s+/)
        .filter(Boolean);
    if (!parts.includes('offline_access')) parts.push('offline_access');
    return parts.join(' ');
}

const DEFAULTS = {
    domain: process.env.AUTH0_DOMAIN || 'auth.myagiea.com',
    clientId: process.env.AUTH0_CLIENT_ID || '0E4ov2yLLLONevskQiqYzbRotpGdmX4q',
    audience: process.env.AUTH0_AUDIENCE || 'https://api.heygia.com',
    scopes: ensureRequiredScopes(process.env.AUTH0_SCOPES || 'openid profile email'),
    redirectHost: process.env.AUTH0_REDIRECT_HOST || '127.0.0.1',
    redirectPort: Number(process.env.AUTH0_REDIRECT_PORT || 47823),
    redirectPath: process.env.AUTH0_REDIRECT_PATH || '/callback',
};

const DEEPLINK_SCHEME = process.env.GIA_DEEPLINK_SCHEME || 'gia';
const AUTH_DEEPLINK_HOST = process.env.AUTH0_DEEPLINK_HOST || 'auth';
const AUTH_DEEPLINK_PATH = process.env.AUTH0_DEEPLINK_PATH || '/callback';

const STORAGE_FILE_ENV = process.env.GIA_AUTH_STORAGE_FILE;
let pendingDeepLinkAuth = null;

function getStorageFile() {
    return STORAGE_FILE_ENV || path.join(app.getPath('userData'), 'auth.tokens.json');
}

function base64url(buf) {
    return Buffer.from(buf)
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/g, '');
}

function randomString(length = 64) {
    // Allowed PKCE charset: ALPHA / DIGIT / "-" / "." / "_" / "~"
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
    const bytes = crypto.randomBytes(length);
    let out = '';
    for (let i = 0; i < length; i++) out += chars[bytes[i] % chars.length];
    return out;
}

function buildRedirectUri(cfg = DEFAULTS) {
    return `http://${cfg.redirectHost}:${cfg.redirectPort}${cfg.redirectPath}`;
}

function buildDeepLinkRedirectUri() {
    return `${DEEPLINK_SCHEME}://${AUTH_DEEPLINK_HOST}${AUTH_DEEPLINK_PATH}`;
}

function normalizeCallbackResult(url) {
    return {
        code: url.searchParams.get('code'),
        state: url.searchParams.get('state'),
        error: url.searchParams.get('error'),
        errorDescription: url.searchParams.get('error_description'),
    };
}

function cleanupPendingDeepLinkAuth() {
    if (!pendingDeepLinkAuth) return;
    clearTimeout(pendingDeepLinkAuth.timeout);
    pendingDeepLinkAuth = null;
}

function waitForDeepLinkCallback({ timeoutMs = 300000 } = {}) {
    if (pendingDeepLinkAuth) {
        throw new Error('Another interactive login is already waiting for an auth callback');
    }

    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            pendingDeepLinkAuth = null;
            reject(new Error('Login callback timed out'));
        }, timeoutMs);

        pendingDeepLinkAuth = {
            resolve: (result) => {
                cleanupPendingDeepLinkAuth();
                resolve(result);
            },
            reject: (error) => {
                cleanupPendingDeepLinkAuth();
                reject(error);
            },
            timeout,
        };
    });
}

export function consumeAuthCallbackUrl(rawUrl) {
    try {
        if (typeof rawUrl !== 'string' || rawUrl.length === 0) return false;
        const url = new URL(rawUrl);
        if (url.protocol !== `${DEEPLINK_SCHEME}:`) return false;
        if ((url.hostname || '').toLowerCase() !== AUTH_DEEPLINK_HOST.toLowerCase()) return false;
        if (url.pathname !== AUTH_DEEPLINK_PATH) return false;

        if (!pendingDeepLinkAuth) {
            return true;
        }

        pendingDeepLinkAuth.resolve(normalizeCallbackResult(url));
        return true;
    } catch {
        return false;
    }
}

async function readStoredTokens() {
    try {
        const raw = await fs.readFile(getStorageFile(), 'utf8');
        return JSON.parse(raw);
    } catch {
        return null;
    }
}

async function writeStoredTokens(tokens) {
    const storageFile = getStorageFile();
    await fs.mkdir(path.dirname(storageFile), { recursive: true });
    const tmp = `${storageFile}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(tokens, null, 2), {
        encoding: 'utf8',
        mode: 0o600,
    });
    await fs.rename(tmp, storageFile);
}

async function clearStoredTokens() {
    try {
        await fs.unlink(getStorageFile());
    } catch {
        // ignore
    }
}

function normalizeTokens(tokenResponse) {
    const now = Date.now();
    const expiresInSec =
        typeof tokenResponse.expires_in === 'number' ? tokenResponse.expires_in : 0;
    const expiresAt = now + expiresInSec * 1000;

    return {
        access_token: tokenResponse.access_token,
        refresh_token: tokenResponse.refresh_token,
        token_type: tokenResponse.token_type || 'Bearer',
        scope: tokenResponse.scope,
        expires_in: expiresInSec,
        expires_at: expiresAt,
        id_token: tokenResponse.id_token,
    };
}

async function startLoopbackCallbackServer({ host, port, callbackPath, timeoutMs = 300000 }) {
    return await new Promise((resolve, reject) => {
        const server = http.createServer((req, res) => {
            try {
                const url = new URL(req.url || '', `http://${host}:${port}`);
                if (url.pathname !== callbackPath) {
                    res.writeHead(404);
                    res.end('Not found');
                    return;
                }

                // Auth0 redirects with code/state or error/error_description
                const code = url.searchParams.get('code');
                const state = url.searchParams.get('state');
                const error = url.searchParams.get('error');
                const errorDescription = url.searchParams.get('error_description');

                res.writeHead(200, {
                    'Content-Type': 'text/html; charset=utf-8',
                    'Cache-Control': 'no-store, no-cache',
                    Connection: 'close',
                });

                const escapeHtml = (s) =>
                    String(s ?? '')
                        .replace(/&/g, '&amp;')
                        .replace(/</g, '&lt;')
                        .replace(/>/g, '&gt;')
                        .replace(/"/g, '&quot;')
                        .replace(/'/g, '&#39;');

                const openAppUrl = `${DEEPLINK_SCHEME}://open`;

                const page = ({ title, heading, body, variant = 'success' }) => {
                    const safeTitle = escapeHtml(title);
                    const safeHeading = escapeHtml(heading);
                    return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${safeTitle}</title>
    <style>
      :root {
        --bg: #fafafa;
        --fg: #0a0a0a;
        --muted: #737373;
        --faint: #a3a3a3;
        --border: rgba(0,0,0,0.08);
        --btn-bg: #0a0a0a;
        --btn-fg: #ffffff;
        --success: #16a34a;
        --error: #dc2626;
      }
      @media (prefers-color-scheme: dark) {
        :root {
          --bg: #0a0a0a;
          --fg: #fafafa;
          --muted: #a3a3a3;
          --faint: #6b6b6b;
          --border: rgba(255,255,255,0.10);
          --btn-bg: #fafafa;
          --btn-fg: #0a0a0a;
        }
      }
      * { box-sizing: border-box; }
      html, body { height: 100%; }
      body {
        margin: 0;
        font-family: -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
        background: var(--bg);
        color: var(--fg);
        -webkit-font-smoothing: antialiased;
        display: grid;
        place-items: center;
        padding: 24px;
      }
      .wrap {
        width: min(360px, 100%);
        display: flex;
        flex-direction: column;
        align-items: center;
        text-align: center;
        animation: rise .5s cubic-bezier(.2,.7,.2,1) both;
      }
      @keyframes rise { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
      .mark { position: relative; width: 44px; height: 44px; margin-bottom: 28px; }
      .mark svg.logo { width: 44px; height: 44px; display: block; }
      .badge {
        position: absolute; right: -4px; bottom: -4px;
        width: 18px; height: 18px; border-radius: 50%;
        display: grid; place-items: center;
        color: #fff; box-shadow: 0 0 0 3px var(--bg);
      }
      .badge.success { background: var(--success); }
      .badge.error { background: var(--error); }
      .badge svg { width: 10px; height: 10px; }
      h1 {
        margin: 0 0 8px;
        font-size: 22px;
        font-weight: 600;
        letter-spacing: -0.02em;
      }
      p {
        margin: 0;
        color: var(--muted);
        font-size: 15px;
        line-height: 1.5;
      }
      p a { color: inherit; }
      a.btn {
        margin-top: 28px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        height: 40px;
        padding: 0 22px;
        border-radius: 999px;
        background: var(--btn-bg);
        color: var(--btn-fg);
        text-decoration: none;
        font-size: 14px;
        font-weight: 500;
        transition: opacity .15s, transform .15s;
      }
      a.btn:hover { opacity: .85; }
      a.btn:active { transform: scale(.98); }
      .fineprint {
        margin-top: 20px;
        font-size: 12px;
        color: var(--faint);
        line-height: 1.4;
      }
      pre {
        margin: 12px 0 0;
        padding: 10px 12px;
        width: 100%;
        border-radius: 10px;
        border: 1px solid var(--border);
        color: var(--muted);
        text-align: left;
        white-space: pre-wrap;
        word-break: break-word;
        font-size: 12px;
        line-height: 1.45;
      }
    </style>
  </head>
  <body data-variant="${variant}">
    <main class="wrap">
      <div class="mark">
        <svg class="logo" viewBox="0 0 771 771" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Gia">
          <path fill-rule="evenodd" clip-rule="evenodd" d="M744.71 632.273L733.18 551.378C757.066 500.951 771 445.216 771 385.5C771 172.513 598.487 0 385.5 0C172.513 0 0 172.513 0 385.5C0 598.487 172.513 771 385.5 771C457.159 771 523.51 751.095 580.572 717.256L760.773 744.71L744.71 632.273ZM519.703 476.819C490.486 519.684 441.272 547.828 385.484 547.828C295.84 547.828 223.169 475.157 223.169 385.512C223.169 295.868 295.84 223.197 385.484 223.197C453.604 223.197 511.922 265.159 536.001 324.644H600.267C573.772 230.967 487.644 162.328 385.484 162.328C262.223 162.328 162.3 262.251 162.3 385.512C162.3 508.774 262.223 608.697 385.484 608.697C448.36 608.697 505.164 582.696 545.729 540.86V608.701H606.598V415.951H413.848V476.819H519.703Z" fill="url(#giaGrad)"/>
          <defs>
            <linearGradient id="giaGrad" x1="568.105" y1="0" x2="142.026" y2="771" gradientUnits="userSpaceOnUse">
              <stop stop-color="#FFB731"/>
              <stop offset="1" stop-color="#FC6466"/>
            </linearGradient>
          </defs>
        </svg>
        <span class="badge ${variant}">${
            variant === 'success'
                ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>`
                : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>`
        }</span>
      </div>

      <h1>${safeHeading}</h1>
      ${body}

      <a class="btn" id="openBtn" href="${openAppUrl}">Open Gia</a>

      <div class="fineprint">Didn’t open? Switch to Gia from your menu bar.</div>
    </main>
    <script>
      document.getElementById("openBtn").addEventListener("click", function() {
        setTimeout(function() { window.close(); }, 500);
      });
      // Auto-open Gia on success via hidden iframe (keeps page visible)
      if (document.body.dataset.variant === "success") {
        var f = document.createElement("iframe");
        f.style.display = "none";
        f.src = document.getElementById("openBtn").href;
        document.body.appendChild(f);
        setTimeout(function() { window.close(); }, 10000);
      }
    </script>
  </body>
</html>`;
                };

                if (error === 'login_required' || error === 'interaction_required') {
                    // Silent auth failed — user needs to log in interactively.
                    // Show a brief message and auto-close so the interactive tab takes over.
                    res.end(`<!doctype html><html lang="en"><head><title>Redirecting…</title></head><body>
                        <p style="font-family:sans-serif;text-align:center;margin-top:40vh;color:#6b7280">Opening login…</p>
                        <script>setTimeout(function(){window.close()},1500)</script></body></html>`);
                } else if (error) {
                    const safeDesc = escapeHtml(errorDescription || '');
                    res.end(
                        page({
                            title: 'Login failed',
                            heading: 'Sign-in failed',
                            variant: 'error',
                            body: `<p>Something went wrong. Try again from the Gia menu bar.</p>${
                                safeDesc ? `<pre>${safeDesc}</pre>` : ''
                            }<p style="margin-top:12px;font-size:13px">Still stuck? <a href="mailto:support@myagiea.com">support@myagiea.com</a></p>`,
                        }),
                    );
                } else {
                    res.end(
                        page({
                            title: 'Login complete',
                            heading: 'You’re all set',
                            variant: 'success',
                            body: `<p>You’re signed in. Head back to Gia to finish setup.</p>`,
                        }),
                    );
                }

                clearTimeout(timeout);
                const result = { code, state, error, errorDescription };
                // Close the server and wait for the port to be released
                // before resolving, so a subsequent login() can reuse the port.
                server.close(() => resolve(result));
            } catch (e) {
                clearTimeout(timeout);
                server.close(() => reject(e));
            }
        });

        const timeout = setTimeout(() => {
            try {
                server.close();
            } catch {}
            reject(new Error('Login callback timed out'));
        }, timeoutMs);

        server.on('error', (err) => {
            clearTimeout(timeout);
            reject(err);
        });
        server.listen(port, host);
    });
}

async function exchangeCodeForTokens({ domain, clientId, redirectUri, codeVerifier, code }) {
    const tokenRes = await fetch(`https://${domain}/oauth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            grant_type: 'authorization_code',
            client_id: clientId,
            code_verifier: codeVerifier,
            code,
            redirect_uri: redirectUri,
        }),
        signal: AbortSignal.timeout(30000),
    });

    const bodyText = await tokenRes.text();
    if (!tokenRes.ok) throw new Error(`Token exchange failed: ${bodyText}`);
    return JSON.parse(bodyText);
}

async function refreshAccessToken({ domain, clientId, refreshToken }) {
    const tokenRes = await fetch(`https://${domain}/oauth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            grant_type: 'refresh_token',
            client_id: clientId,
            refresh_token: refreshToken,
        }),
        signal: AbortSignal.timeout(30000),
    });

    const bodyText = await tokenRes.text();
    if (!tokenRes.ok) {
        const err = new Error(`Refresh failed: ${bodyText}`);
        try {
            const parsed = JSON.parse(bodyText);
            if (parsed?.error) err.oauthError = parsed.error;
        } catch {
            // keep original error message when response is not JSON
        }
        throw err;
    }
    return JSON.parse(bodyText);
}

export async function getStoredAccessToken({ allowRefresh = true } = {}) {
    const stored = await readStoredTokens();
    if (!stored) return null;

    // Valid, non-expired access token — return immediately.
    if (stored.access_token && stored.expires_at && Date.now() < stored.expires_at) {
        return stored;
    }

    // No refresh path available — nothing we can do.
    if (!allowRefresh || !stored.refresh_token) return null;

    // attempt refresh
    try {
        logger.info('[auth] access token expired, attempting refresh');
        const refreshed = await refreshAccessToken({
            domain: stored.domain || DEFAULTS.domain,
            clientId: stored.client_id || DEFAULTS.clientId,
            refreshToken: stored.refresh_token,
        });

        const next = {
            ...normalizeTokens(refreshed),
            // keep config so refresh works later
            domain: stored.domain || DEFAULTS.domain,
            client_id: stored.client_id || DEFAULTS.clientId,
            audience: stored.audience || DEFAULTS.audience,
            scopes: stored.scopes || DEFAULTS.scopes,
            redirect_uri: stored.redirect_uri || buildRedirectUri(DEFAULTS),
        };

        // Auth0 may omit refresh_token on refresh depending on settings
        if (!next.refresh_token) next.refresh_token = stored.refresh_token;

        await writeStoredTokens(next);
        logger.info('[auth] refresh token exchange succeeded');
        return next;
    } catch (e) {
        logger.warn('[auth] refresh token exchange failed', {
            error: e?.message || String(e),
        });
        // `invalid_grant` means the refresh token is no longer usable.
        // Clear storage to force a clean interactive login instead of retry loops.
        const msg = String(e?.message || '');
        const isInvalidGrant =
            e?.oauthError === 'invalid_grant' || msg.includes('"error":"invalid_grant"');
        if (isInvalidGrant) {
            await clearStoredTokens();
        } else if (stored.refresh_token) {
            // Preserve the refresh_token so the next attempt can retry.
            await writeStoredTokens({
                ...stored,
                access_token: null,
                expires_at: 0,
            });
        } else {
            await clearStoredTokens();
        }
        throw e;
    }
}

export async function login({
    domain = DEFAULTS.domain,
    clientId = DEFAULTS.clientId,
    audience = DEFAULTS.audience,
    scopes = DEFAULTS.scopes,
    prompt = 'login', // "none" for silent attempt
} = {}) {
    await app.whenReady();
    const requestedScopes = ensureRequiredScopes(scopes);
    const useDeepLinkCallback = prompt === 'none';
    const redirectUri = useDeepLinkCallback
        ? buildDeepLinkRedirectUri()
        : buildRedirectUri(DEFAULTS);

    const state = crypto.randomUUID();
    const codeVerifier = randomString(64);
    const codeChallenge = base64url(crypto.createHash('sha256').update(codeVerifier).digest());

    const authUrl =
        `https://${domain}/authorize?` +
        new URLSearchParams({
            client_id: clientId,
            response_type: 'code',
            redirect_uri: redirectUri,
            audience,
            scope: requestedScopes,
            state,
            code_challenge: codeChallenge,
            code_challenge_method: 'S256',
            prompt,
        }).toString();

    // Use a browser-visible loopback page for interactive sign-in so the browser
    // shows a completion page, while silent auth can return straight to the app.
    const callbackPromise = useDeepLinkCallback
        ? waitForDeepLinkCallback({
              timeoutMs: 15000,
          })
        : startLoopbackCallbackServer({
              host: DEFAULTS.redirectHost,
              port: DEFAULTS.redirectPort,
              callbackPath: DEFAULTS.redirectPath,
              timeoutMs: 300000,
          });

    // Open auth URL in the system default browser
    try {
        await shell.openExternal(authUrl);
    } catch (error) {
        if (useDeepLinkCallback && pendingDeepLinkAuth) {
            pendingDeepLinkAuth.reject(error);
        }
        throw error;
    }

    // Wait for the callback from the browser
    const callback = await callbackPromise;

    if (callback?.error) {
        throw new Error(
            `Auth error: ${callback.error}${
                callback.errorDescription ? ` (${callback.errorDescription})` : ''
            }`,
        );
    }

    if (!callback?.code) throw new Error('No authorization code returned');
    if (!callback?.state || callback.state !== state) throw new Error('Invalid OAuth state');

    const tokenResponse = await exchangeCodeForTokens({
        domain,
        clientId,
        redirectUri,
        codeVerifier,
        code: callback.code,
    });

    const normalized = {
        ...normalizeTokens(tokenResponse),
        domain,
        client_id: clientId,
        audience,
        scopes: requestedScopes,
        redirect_uri: redirectUri,
    };

    await writeStoredTokens(normalized);
    return normalized;
}

export async function logout() {
    await clearStoredTokens();
}

export async function isAuthenticated() {
    try {
        const t = await getStoredAccessToken({ allowRefresh: true });
        return { authenticated: !!t, accessToken: t?.access_token || null };
    } catch (e) {
        logger.warn('[auth] isAuthenticated failed', {
            error: e?.message || String(e),
        });
        return { authenticated: false, accessToken: null };
    }
}
