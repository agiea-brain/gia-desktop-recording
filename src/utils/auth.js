import { app, shell } from "electron";
import http from "http";
import crypto from "crypto";
import fs from "fs/promises";
import path from "path";
import { loadEnv } from "./load-env";

/**
 * Auth0 OAuth (Authorization Code + PKCE) helper for Electron main-process.
 *
 * What you need to configure in Auth0:
 * - Allowed Callback URLs must include the redirect URI you use here.
 *   Default in this file: http://127.0.0.1:47823/callback
 */

// Ensure env is loaded before reading process.env into defaults.
loadEnv();

function ensureRequiredScopes(scopes) {
    const parts = String(scopes || "")
        .split(/\s+/)
        .filter(Boolean);
    if (!parts.includes("offline_access")) parts.push("offline_access");
    return parts.join(" ");
}

const DEFAULTS = {
    domain: process.env.AUTH0_DOMAIN || "auth.myagiea.com",
    clientId: process.env.AUTH0_CLIENT_ID || "0E4ov2yLLLONevskQiqYzbRotpGdmX4q",
    audience: process.env.AUTH0_AUDIENCE || "https://api.heygia.com",
    scopes: ensureRequiredScopes(
        process.env.AUTH0_SCOPES || "openid profile email",
    ),
    redirectHost: process.env.AUTH0_REDIRECT_HOST || "127.0.0.1",
    redirectPort: Number(process.env.AUTH0_REDIRECT_PORT || 47823),
    redirectPath: process.env.AUTH0_REDIRECT_PATH || "/callback",
};

const DEEPLINK_SCHEME = process.env.GIA_DEEPLINK_SCHEME || "gia";

const STORAGE_FILE_ENV = process.env.GIA_AUTH_STORAGE_FILE;

function getStorageFile() {
    return (
        STORAGE_FILE_ENV ||
        path.join(app.getPath("userData"), "auth.tokens.json")
    );
}

function base64url(buf) {
    return Buffer.from(buf)
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/g, "");
}

function randomString(length = 64) {
    // Allowed PKCE charset: ALPHA / DIGIT / "-" / "." / "_" / "~"
    const chars =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
    const bytes = crypto.randomBytes(length);
    let out = "";
    for (let i = 0; i < length; i++) out += chars[bytes[i] % chars.length];
    return out;
}

function buildRedirectUri(cfg = DEFAULTS) {
    return `http://${cfg.redirectHost}:${cfg.redirectPort}${cfg.redirectPath}`;
}

async function readStoredTokens() {
    try {
        const raw = await fs.readFile(getStorageFile(), "utf8");
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
        encoding: "utf8",
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
        typeof tokenResponse.expires_in === "number"
            ? tokenResponse.expires_in
            : 0;
    const expiresAt = now + expiresInSec * 1000;

    return {
        access_token: tokenResponse.access_token,
        refresh_token: tokenResponse.refresh_token,
        token_type: tokenResponse.token_type || "Bearer",
        scope: tokenResponse.scope,
        expires_in: expiresInSec,
        expires_at: expiresAt,
        id_token: tokenResponse.id_token,
    };
}

async function startLoopbackCallbackServer({ host, port, callbackPath }) {
    return await new Promise((resolve, reject) => {
        const server = http.createServer((req, res) => {
            try {
                const url = new URL(req.url || "", `http://${host}:${port}`);
                if (url.pathname !== callbackPath) {
                    res.writeHead(404);
                    res.end("Not found");
                    return;
                }

                // Auth0 redirects with code/state or error/error_description
                const code = url.searchParams.get("code");
                const state = url.searchParams.get("state");
                const error = url.searchParams.get("error");
                const errorDescription =
                    url.searchParams.get("error_description");

                res.writeHead(200, {
                    "Content-Type": "text/html; charset=utf-8",
                });

                const escapeHtml = (s) =>
                    String(s ?? "")
                        .replace(/&/g, "&amp;")
                        .replace(/</g, "&lt;")
                        .replace(/>/g, "&gt;")
                        .replace(/"/g, "&quot;")
                        .replace(/'/g, "&#39;");

                const openAppUrl = `${DEEPLINK_SCHEME}://open`;

                const page = ({
                    title,
                    heading,
                    body,
                    variant = "success",
                }) => {
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
        --bg: #ffffff;
        --fg: #0a0a0a;
        --muted: #6b7280;
        --border: rgba(0,0,0,0.10);
        --shadow: 0 10px 30px rgba(0,0,0,0.10);
        --radius: 14px;
        --primary: #111827;
        --primary-fg: #ffffff;
        --secondary: #f3f4f6;
        --success: #16a34a;
        --success-bg: #dcfce7;
        --error: #dc2626;
        --error-bg: #fee2e2;
      }
      * { box-sizing: border-box; }
      html, body { height: 100%; }
      body {
        margin: 0;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
        background: var(--bg);
        color: var(--fg);
      }
      .page-header {
        position: absolute;
        top: 24px;
        left: 32px;
      }
      .logo {
        display: flex;
        align-items: center;
        gap: 12px;
        font-weight: 700;
        font-size: 20px;
        letter-spacing: -0.02em;
        color: var(--fg);
      }
      .logo svg { width: 32px; height: 32px; display: block; }
      
      .wrap {
        min-height: 100%;
        display: grid;
        place-items: center;
        padding: 24px;
      }
      .card {
        width: min(440px, 100%);
        border: 1px solid var(--border);
        border-radius: 16px;
        box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06);
        padding: 48px 40px 40px;
        background: white;
        text-align: center;
        display: flex;
        flex-direction: column;
        align-items: center;
      }
      
      .status-icon {
        width: 48px;
        height: 48px;
        margin-bottom: 16px;
        display: flex;
        align-items: center;
        justify-content: center;
        border-radius: 50%;
      }
      .status-icon.success { background: var(--success-bg); color: var(--success); }
      .status-icon.error { background: var(--error-bg); color: var(--error); }
      .status-icon svg { width: 24px; height: 24px; }

      h1 {
        margin: 0 0 8px;
        font-size: 24px;
        font-weight: 600;
        letter-spacing: -0.025em;
        color: var(--fg);
      }
      p {
        margin: 0;
        color: var(--muted);
        font-size: 16px;
        line-height: 1.5;
      }
      .actions {
        margin-top: 32px;
        width: 100%;
        display: flex;
        justify-content: center;
      }
      a.btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        background: #111827;
        color: white;
        text-decoration: none;
        padding: 12px 24px;
        border-radius: 8px;
        font-size: 14px;
        font-weight: 500;
        transition: background-color 0.2s;
        min-width: 120px;
      }
      a.btn:hover {
        background: #1f2937;
      }
      .fineprint {
        margin-top: 24px;
        font-size: 13px;
        color: var(--muted);
        max-width: 320px;
        margin-left: auto;
        margin-right: auto;
        line-height: 1.4;
      }
      pre {
        margin: 10px 0 0;
        padding: 10px 12px;
        border-radius: 12px;
        border: 1px solid var(--border);
        background: #fafafa;
        color: #111827;
        white-space: pre-wrap;
        word-break: break-word;
        font-size: 12px;
        line-height: 1.45;
      }
    </style>
  </head>
  <body>
    <div class="page-header">
      <div class="logo" aria-label="Gia">
        <svg width="771" height="771" viewBox="0 0 771 771" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Gia logo">
          <path fill-rule="evenodd" clip-rule="evenodd" d="M744.71 632.273L733.18 551.378C757.066 500.951 771 445.216 771 385.5C771 172.513 598.487 0 385.5 0C172.513 0 0 172.513 0 385.5C0 598.487 172.513 771 385.5 771C457.159 771 523.51 751.095 580.572 717.256L760.773 744.71L744.71 632.273ZM519.703 476.819C490.486 519.684 441.272 547.828 385.484 547.828C295.84 547.828 223.169 475.157 223.169 385.512C223.169 295.868 295.84 223.197 385.484 223.197C453.604 223.197 511.922 265.159 536.001 324.644H600.267C573.772 230.967 487.644 162.328 385.484 162.328C262.223 162.328 162.3 262.251 162.3 385.512C162.3 508.774 262.223 608.697 385.484 608.697C448.36 608.697 505.164 582.696 545.729 540.86V608.701H606.598V415.951H413.848V476.819H519.703Z" fill="url(#paint0_linear_318_26)"/>
          <defs>
            <linearGradient id="paint0_linear_318_26" x1="568.105" y1="-5.53754e-06" x2="142.026" y2="771" gradientUnits="userSpaceOnUse">
              <stop stop-color="#FFB731"/>
              <stop offset="1" stop-color="#FC6466"/>
            </linearGradient>
          </defs>
        </svg>
        <span>Gia</span>
      </div>
    </div>

    <div class="wrap">
      <div class="card">
        <div class="status-icon ${variant}">
          ${
              variant === "success"
                  ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>`
                  : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>`
          }
        </div>
        
        <h1>${safeHeading}</h1>
        ${body}
        
        <div class="actions">
          <a class="btn" href="${openAppUrl}">Open Gia</a>
        </div>
        
        <div class="fineprint">
          If the “Open Gia” button doesn’t work, switch back to the Gia app from your Dock / menu bar.
        </div>
      </div>
    </div>
  </body>
</html>`;
                };

                if (error) {
                    const safeError = escapeHtml(error);
                    const safeDesc = escapeHtml(errorDescription || "");
                    res.end(
                        page({
                            title: "Login failed",
                            heading: "Login failed",
                            variant: "error",
                            body: `<p>${safeError}</p>${
                                safeDesc
                                    ? `<pre>${safeDesc}</pre>`
                                    : `<p>Go back to Gia and try again.</p>`
                            }`,
                        }),
                    );
                } else {
                    res.end(
                        page({
                            title: "Login complete",
                            heading: "Login complete",
                            variant: "success",
                            body: `<p>You’re signed in. Return to Gia to continue setup.</p>`,
                        }),
                    );
                }

                resolve({ code, state, error, errorDescription });
            } catch (e) {
                reject(e);
            } finally {
                // close shortly after responding
                setTimeout(() => {
                    try {
                        server.close();
                    } catch {
                        // ignore
                    }
                }, 25);
            }
        });

        server.on("error", reject);
        server.listen(port, host);
    });
}

async function exchangeCodeForTokens({
    domain,
    clientId,
    redirectUri,
    codeVerifier,
    code,
}) {
    const tokenRes = await fetch(`https://${domain}/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            grant_type: "authorization_code",
            client_id: clientId,
            code_verifier: codeVerifier,
            code,
            redirect_uri: redirectUri,
        }),
    });

    const bodyText = await tokenRes.text();
    if (!tokenRes.ok) throw new Error(`Token exchange failed: ${bodyText}`);
    return JSON.parse(bodyText);
}

async function refreshAccessToken({ domain, clientId, refreshToken }) {
    const tokenRes = await fetch(`https://${domain}/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            grant_type: "refresh_token",
            client_id: clientId,
            refresh_token: refreshToken,
        }),
    });

    const bodyText = await tokenRes.text();
    if (!tokenRes.ok) throw new Error(`Refresh failed: ${bodyText}`);
    return JSON.parse(bodyText);
}

export async function getStoredAccessToken({ allowRefresh = true } = {}) {
    const stored = await readStoredTokens();
    if (!stored?.access_token || !stored?.expires_at) return null;

    if (Date.now() < stored.expires_at) return stored;

    if (!allowRefresh || !stored.refresh_token) return null;

    // attempt refresh
    try {
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
        return next;
    } catch (e) {
        await clearStoredTokens();
        throw e;
    }
}

export async function login({
    domain = DEFAULTS.domain,
    clientId = DEFAULTS.clientId,
    audience = DEFAULTS.audience,
    scopes = DEFAULTS.scopes,
    prompt = "login", // "none" for silent attempt
} = {}) {
    await app.whenReady();
    const requestedScopes = ensureRequiredScopes(scopes);

    const redirectUri = buildRedirectUri(DEFAULTS);

    const state = crypto.randomUUID();
    const codeVerifier = randomString(64);
    const codeChallenge = base64url(
        crypto.createHash("sha256").update(codeVerifier).digest(),
    );

    const authUrl =
        `https://${domain}/authorize?` +
        new URLSearchParams({
            client_id: clientId,
            response_type: "code",
            redirect_uri: redirectUri,
            audience,
            scope: requestedScopes,
            state,
            code_challenge: codeChallenge,
            code_challenge_method: "S256",
            prompt,
        }).toString();

    // Start the loopback server to receive the callback
    const callbackPromise = startLoopbackCallbackServer({
        host: DEFAULTS.redirectHost,
        port: DEFAULTS.redirectPort,
        callbackPath: DEFAULTS.redirectPath,
    });

    // Open auth URL in the system default browser
    await shell.openExternal(authUrl);

    // Wait for the callback from the browser
    const callback = await callbackPromise;

    if (callback?.error) {
        throw new Error(
            `Auth error: ${callback.error}${
                callback.errorDescription
                    ? ` (${callback.errorDescription})`
                    : ""
            }`,
        );
    }

    if (!callback?.code) throw new Error("No authorization code returned");
    if (callback?.state && callback.state !== state)
        throw new Error("Invalid OAuth state");

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
        const t = await getStoredAccessToken({ allowRefresh: false });
        return { authenticated: !!t, accessToken: t?.access_token || null };
    } catch {
        return { authenticated: false, accessToken: null };
    }
}
