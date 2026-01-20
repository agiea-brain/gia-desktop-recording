import { BrowserWindow, app } from "electron";
import http from "http";
import crypto from "crypto";
import fs from "fs/promises";
import path from "path";

/**
 * Auth0 OAuth (Authorization Code + PKCE) helper for Electron main-process.
 *
 * What you need to configure in Auth0:
 * - Allowed Callback URLs must include the redirect URI you use here.
 *   Default in this file: http://127.0.0.1:47823/callback
 */

const DEFAULTS = {
    domain: process.env.AUTH0_DOMAIN || "auth.myagiea.com",
    clientId: process.env.AUTH0_CLIENT_ID || "0E4ov2yLLLONevskQiqYzbRotpGdmX4q",
    audience: process.env.AUTH0_AUDIENCE || "https://api.heygia.com",
    scopes: process.env.AUTH0_SCOPES || "openid profile email",
    redirectHost: process.env.AUTH0_REDIRECT_HOST || "127.0.0.1",
    redirectPort: Number(process.env.AUTH0_REDIRECT_PORT || 47823),
    redirectPath: process.env.AUTH0_REDIRECT_PATH || "/callback",
};

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
                if (error) {
                    res.end(
                        `<h2>Login failed</h2><p>${error}</p><pre>${errorDescription || ""}</pre><p>You can close this window.</p>`
                    );
                } else {
                    res.end(
                        `<h2>Login complete</h2><p>You can close this window and return to the app.</p>`
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

    const redirectUri = buildRedirectUri(DEFAULTS);

    const state = crypto.randomUUID();
    const codeVerifier = randomString(64);
    const codeChallenge = base64url(
        crypto.createHash("sha256").update(codeVerifier).digest()
    );

    const authUrl =
        `https://${domain}/authorize?` +
        new URLSearchParams({
            client_id: clientId,
            response_type: "code",
            redirect_uri: redirectUri,
            audience,
            scope: scopes,
            state,
            code_challenge: codeChallenge,
            code_challenge_method: "S256",
            prompt,
        }).toString();

    const callbackPromise = startLoopbackCallbackServer({
        host: DEFAULTS.redirectHost,
        port: DEFAULTS.redirectPort,
        callbackPath: DEFAULTS.redirectPath,
    });

    const win = new BrowserWindow({
        width: 480,
        height: 720,
        show: true,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
        },
    });

    // If the user closes the window, fail the login.
    const closedPromise = new Promise((_, reject) => {
        win.on("closed", () => reject(new Error("Login window closed")));
    });

    await win.loadURL(authUrl);

    const callback = await Promise.race([callbackPromise, closedPromise]);
    try {
        if (callback?.error) {
            throw new Error(
                `Auth error: ${callback.error}${
                    callback.errorDescription
                        ? ` (${callback.errorDescription})`
                        : ""
                }`
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
            scopes,
            redirect_uri: redirectUri,
        };

        await writeStoredTokens(normalized);
        return normalized;
    } finally {
        try {
            win.close();
        } catch {
            // ignore
        }
    }
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
