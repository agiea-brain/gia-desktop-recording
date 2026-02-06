import RecallAiSdk from "@recallai/desktop-sdk";
import {
    app,
    BrowserWindow,
    dialog,
    ipcMain,
    Menu,
    nativeImage,
    shell,
    systemPreferences,
    Tray,
} from "electron";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
    isAuthenticated,
    login,
    logout,
    getStoredAccessToken,
} from "./utils/auth";
import Api from "./utils/api";
import logger from "./utils/logger";
import { loadEnv } from "./utils/load-env";

loadEnv();

const DEEPLINK_SCHEME = process.env.GIA_DEEPLINK_SCHEME || "gia";

logger.configure({
    apiUrl: "https://r0ng0htend.execute-api.us-east-2.amazonaws.com/stage/desktop-sdk-logger",
});
logger.setBaseContext({
    process: "main",
    service: "desktop-sdk",
    userId: null,
    user_id: null,
});
logger.info(
    "[logging] remote configured:",
    logger.isRemoteLoggingConfigured?.() ?? null,
);

function setupAutoUpdates() {
    // Option A: GitHub Releases + update.electronjs.org.
    // Only run in packaged mac builds (autoUpdater will not work in dev).
    if (!app.isPackaged) return;
    if (process.platform !== "darwin") return;

    import("update-electron-app")
        .then(({ updateElectronApp, UpdateSourceType }) => {
            updateElectronApp({
                updateSource: {
                    type: UpdateSourceType.ElectronPublicUpdateService,
                    repo: "agiea-brain/gia-desktop-recording",
                },
                logger: {
                    log: (...args) => logger.info("[auto-update]", ...args),
                },
            });
            const currentVersion = app.getVersion();
            logger.info("[auto-update] current version", currentVersion);
            logger.info("[auto-update] update-electron-app initialized");
        })
        .catch((err) => {
            logger.error("[auto-update] failed to initialize", err);
        });
}

setupAutoUpdates();

const api = new Api();

// Toggle developer-only tray items.
// Set to true locally when you want quick access to logs.
const DEBUG = process.env.DEBUG === "true";
const START_ON_LOGIN = true;

let loginInFlight = null;

let tray = null;
let isRecording = false;
let isPaused = false;

let logFilePath = null;
let meetingPopupWindow = null;
let debugControlsWindow = null;
let onboardingWindow = null;
let currentMeetingInfo = null; // { windowId, meetingUrl, uploadToken, recordingId, sdkUploadId, lastRegisteredMeetingUrl, lastRegisterAttemptUrl, lastRegisterAttemptAt }
let userWantsToRecord = false; // Set to true when user confirms they want to record
let recordingStarted = false; // Ensures recording only starts once per meeting

function bringWindowToFront(win, reason = "unknown") {
    try {
        if (!win || win.isDestroyed()) return false;
        if (win.isMinimized?.()) win.restore();
        // Best-effort focus/raise (macOS permission prompts can steal focus)
        app.focus?.({ steal: true });
        win.show();
        win.moveTop?.();
        win.focus();
        return true;
    } catch (e) {
        logger.warn("[window] failed to bring to front", {
            reason,
            error: e?.message,
        });
        return false;
    }
}

function handleDeepLinkUrl(rawUrl, source = "unknown") {
    try {
        if (typeof rawUrl !== "string" || rawUrl.length === 0) return;
        const u = new URL(rawUrl);
        if (u.protocol !== `${DEEPLINK_SCHEME}:`) return;

        const action = (u.hostname || "").toLowerCase();
        logger.info("[deeplink] received", { source, url: rawUrl, action });

        if (action === "open") {
            if (bringWindowToFront(onboardingWindow, "deeplink-open")) return;
            if (bringWindowToFront(debugControlsWindow, "deeplink-open"))
                return;
            if (bringWindowToFront(meetingPopupWindow, "deeplink-open")) return;
            // Tray-only app: best-effort focus the app.
            app.focus?.({ steal: true });
        }
    } catch (e) {
        logger.warn("[deeplink] failed to handle url", {
            source,
            url: rawUrl,
            error: e?.message,
        });
    }
}

function registerDeepLinkProtocol() {
    try {
        // On macOS, this enables `gia://...` links to re-focus the app.
        // In dev, Electron requires passing executable + app path.
        const ok = process.defaultApp
            ? app.setAsDefaultProtocolClient(
                  DEEPLINK_SCHEME,
                  process.execPath,
                  [path.resolve(process.argv[1])],
              )
            : app.setAsDefaultProtocolClient(DEEPLINK_SCHEME);
        logger.info("[deeplink] protocol registration", {
            scheme: DEEPLINK_SCHEME,
            ok,
        });
    } catch (e) {
        logger.warn("[deeplink] protocol registration failed", {
            scheme: DEEPLINK_SCHEME,
            error: e?.message,
        });
    }
}

// macOS delivers deep links to the running instance via this event.
app.on("open-url", (event, url) => {
    try {
        event.preventDefault();
    } catch {
        // ignore
    }
    handleDeepLinkUrl(url, "open-url");
});

// Track window IDs where the user has stopped/declined recording.
// This prevents the popup from re-appearing for the SAME meeting after the user
// manually stops or declines. The SDK can re-emit meeting-detected while the
// meeting window is still active.
const suppressedMeetingWindowIds = new Set();

function suppressMeetingPopupForWindow(windowId, reason) {
    if (windowId) {
        suppressedMeetingWindowIds.add(windowId);
        logger.info(
            `[popup] suppress meeting popup for windowId=${windowId} (reason=${reason})`,
        );
    }
}

function clearMeetingPopupSuppression(windowId) {
    if (windowId && suppressedMeetingWindowIds.has(windowId)) {
        suppressedMeetingWindowIds.delete(windowId);
        logger.info(`[popup] cleared suppression for windowId=${windowId}`);
    }
}

let userProfileFetchInFlight = null;
let userProfileToken = null;
let cachedUserId = null;

let desktopDiagnosticsInFlight = null;
let desktopDiagnosticsToken = null;
let desktopDiagnosticsLastPermissionsSig = null;
let desktopDiagnosticsLastSentAt = 0;

// Latest permission statuses observed from the Recall SDK.
let recallPermissionStatuses = {};
let recallPermissionStatusesUpdatedAt = null;

function stableStringify(value) {
    // Deterministic JSON stringify (sort object keys).
    // Avoids spurious "changed" detection due to key order.
    const seen = new WeakSet();
    const helper = (v) => {
        if (v === null || typeof v !== "object") return v;
        if (seen.has(v)) return "[Circular]";
        seen.add(v);
        if (Array.isArray(v)) return v.map(helper);
        const out = {};
        for (const k of Object.keys(v).sort()) out[k] = helper(v[k]);
        return out;
    };
    return JSON.stringify(helper(value));
}

function buildPlatformString() {
    // Keep it stable + human-readable.
    // Example: "darwin 25.0.0 (arm64)"
    try {
        return `${process.platform} ${os.release()} (${os.arch()})`;
    } catch {
        return `${process.platform}`;
    }
}

function buildAppVersionString() {
    try {
        // Electron app version (typically package.json version).
        return typeof app.getVersion === "function" ? app.getVersion() : null;
    } catch {
        return null;
    }
}

function buildPermissionsDiagnostics() {
    // Include both OS-level permission state and the latest Recall SDK status events.
    const osPermissions = readPermissionStates();
    return {
        os: osPermissions,
        recall: {
            statuses: recallPermissionStatuses,
            updatedAt: recallPermissionStatusesUpdatedAt,
        },
    };
}

async function sendDesktopSdkDiagnosticsIfNeeded() {
    const token = api?.authToken || null;
    if (!token) return;

    const permissions = buildPermissionsDiagnostics();
    const permissionsSig = stableStringify(permissions);

    // Only send once per token+permissions snapshot (re-send when permissions change).
    if (
        desktopDiagnosticsToken === token &&
        desktopDiagnosticsLastPermissionsSig === permissionsSig
    ) {
        return;
    }

    // Throttle if permissions are changing rapidly.
    const now = Date.now();
    if (
        desktopDiagnosticsToken === token &&
        now - desktopDiagnosticsLastSentAt < 5_000
    ) {
        return;
    }
    if (desktopDiagnosticsInFlight) return await desktopDiagnosticsInFlight;

    desktopDiagnosticsInFlight = (async () => {
        try {
            await api.updateDesktopSdkDiagnostics({
                timestamp: new Date(),
                platform: buildPlatformString(),
                version: buildAppVersionString(),
                permissions,
            });
            desktopDiagnosticsToken = token;
            desktopDiagnosticsLastPermissionsSig = permissionsSig;
            desktopDiagnosticsLastSentAt = Date.now();
            logger.info("[auth] desktop sdk diagnostics updated");
        } catch (e) {
            // Best-effort only: never block auth on diagnostics.
            logger.warn("[auth] failed to update desktop sdk diagnostics", e);
        } finally {
            desktopDiagnosticsInFlight = null;
        }
    })();

    return await desktopDiagnosticsInFlight;
}

async function syncUserIdFromProfile() {
    const token = api?.authToken || null;
    if (!token) {
        cachedUserId = null;
        userProfileToken = null;
        logger.setUserId(null);
        return null;
    }

    // Avoid refetching if token hasn't changed and we already have a user id.
    if (userProfileToken === token && cachedUserId) {
        logger.setUserId(cachedUserId);
        return cachedUserId;
    }

    // De-dupe concurrent fetches for the same token.
    if (userProfileFetchInFlight && userProfileToken === token) {
        return await userProfileFetchInFlight;
    }

    userProfileToken = token;
    userProfileFetchInFlight = (async () => {
        try {
            const profile = await api.getUserProfile();
            const uid = typeof profile?._id === "string" ? profile._id : null;
            cachedUserId = uid;
            logger.setUserId(uid);
            return uid;
        } catch (e) {
            cachedUserId = null;
            logger.setUserId(null);
            logger.warn("[auth] failed to fetch user profile for userId", e);
            return null;
        } finally {
            userProfileFetchInFlight = null;
        }
    })();

    return await userProfileFetchInFlight;
}

function readPermissionStates() {
    // We currently request: accessibility, microphone, screen-capture
    const platform = process.platform;

    const getMediaStatus = (type) => {
        try {
            if (
                platform === "darwin" &&
                systemPreferences &&
                typeof systemPreferences.getMediaAccessStatus === "function"
            ) {
                return systemPreferences.getMediaAccessStatus(type);
            }
        } catch {
            // ignore
        }
        return "unsupported";
    };

    const getAccessibilityTrusted = () => {
        try {
            if (
                platform === "darwin" &&
                systemPreferences &&
                typeof systemPreferences.isTrustedAccessibilityClient ===
                    "function"
            ) {
                return Boolean(
                    systemPreferences.isTrustedAccessibilityClient(false),
                );
            }
        } catch {
            // ignore
        }
        return null; // unknown / unsupported
    };

    return {
        accessibility: getAccessibilityTrusted(), // true/false/null
        microphone: getMediaStatus("microphone"), // granted/denied/not-determined/restricted/unknown
        // Electron calls this media type "screen" (Recall SDK calls it "screen-capture").
        screenCapture: getMediaStatus("screen"),
    };
}

let accessibilityTrustedAtStartup = null; // true/false/null (unknown)
let accessibilityRelaunchInFlight = false;

function captureAccessibilityTrustedAtStartupOnce() {
    if (accessibilityTrustedAtStartup !== null)
        return accessibilityTrustedAtStartup;
    const current = readPermissionStates().accessibility;
    // Only lock in explicit true/false. If unknown, keep null.
    if (current === true) accessibilityTrustedAtStartup = true;
    if (current === false) accessibilityTrustedAtStartup = false;
    return accessibilityTrustedAtStartup;
}

async function relaunchApp({ reason = "unknown" } = {}) {
    if (accessibilityRelaunchInFlight) return;
    accessibilityRelaunchInFlight = true;

    logger.info("[app] relaunch requested", { reason });

    // Best-effort: inform the user before restarting.
    try {
        await dialog.showMessageBox({
            type: "info",
            title: "Restarting Gia",
            message:
                "Accessibility permission enabled. Gia will restart to finish setup.",
            buttons: ["Restart now"],
            defaultId: 0,
            noLink: true,
        });
    } catch {
        // ignore (e.g. app shutting down)
    }

    // Give logs a beat to flush before exiting.
    setTimeout(() => {
        try {
            app.relaunch();
        } catch (e) {
            logger.error("[app] failed to relaunch", e);
        }
        try {
            app.exit(0);
        } catch {
            try {
                app.quit();
            } catch {
                // ignore
            }
        }
    }, 250).unref?.();
}

async function maybeRelaunchAfterAccessibilityGranted({
    prev,
    next,
    reason = "unknown",
} = {}) {
    if (process.platform !== "darwin") return;

    // Skip auto-relaunch during onboarding - we handle restart ourselves
    if (!isOnboardingComplete()) return;

    // Only relaunch on an actual transition from not granted -> granted.
    if (prev?.accessibility === false && next?.accessibility === true) {
        // Guard against relaunching on startup when it's already granted.
        captureAccessibilityTrustedAtStartupOnce();
        if (accessibilityTrustedAtStartup === false) {
            await relaunchApp({ reason: `accessibility-granted:${reason}` });
        }
    }
}

function setupPermissionLogging({ onChange } = {}) {
    let last = null;

    const log = (reason = "unknown") => {
        const next = readPermissionStates();
        const prev = last;

        // Only log when something changed, unless it's the first run.
        const changed =
            !last ||
            next.accessibility !== last.accessibility ||
            next.microphone !== last.microphone ||
            next.screenCapture !== last.screenCapture;

        if (changed) {
            logger.info("[permissions] state changed", {
                reason,
                permissions: next,
            });
            try {
                onChange?.({ prev, next, reason });
            } catch (e) {
                logger.warn("[permissions] onChange handler failed", e);
            }
            last = next;
        }
    };

    // Initial snapshot
    log("startup");

    // Best-effort event for mic/cam (and sometimes screen) changes on macOS.
    try {
        if (
            process.platform === "darwin" &&
            systemPreferences &&
            typeof systemPreferences.on === "function"
        ) {
            systemPreferences.on("media-access-change", (_event, mediaType) => {
                if (
                    mediaType === "microphone" ||
                    mediaType === "camera" ||
                    mediaType === "screen"
                ) {
                    log(`media-access-change:${mediaType}`);
                }
            });
        }
    } catch {
        // ignore
    }

    // No reliable OS event for Accessibility / Screen Recording changes; re-check periodically
    // and also when the app becomes active again.
    app.on("activate", () => log("app:activate"));
    app.on("browser-window-focus", () => log("app:browser-window-focus"));
    app.on("resume", () => log("app:resume"));

    setInterval(() => log("poll"), 2000).unref?.();
}

function setupFileLogging() {
    try {
        const logsDir = app.getPath("logs");
        logFilePath = path.join(logsDir, "gia.log");
        fs.mkdirSync(path.dirname(logFilePath), { recursive: true });
        logger.setLogFilePath(logFilePath);
    } catch {
        // ignore
    }
}

// Onboarding state management
function getOnboardingStatePath() {
    return path.join(app.getPath("userData"), "onboarding.json");
}

function readOnboardingState() {
    try {
        const raw = fs.readFileSync(getOnboardingStatePath(), "utf8");
        return JSON.parse(raw);
    } catch {
        return { completed: false, showReady: false };
    }
}

function writeOnboardingState(state) {
    try {
        const statePath = getOnboardingStatePath();
        fs.mkdirSync(path.dirname(statePath), { recursive: true });
        fs.writeFileSync(statePath, JSON.stringify(state, null, 2), "utf8");
    } catch (e) {
        logger.error("[onboarding] failed to write state:", e);
    }
}

function isOnboardingComplete() {
    const state = readOnboardingState();
    return state.completed === true;
}

function shouldShowReadyScreen() {
    const state = readOnboardingState();
    return state.showReady === true;
}

function markOnboardingComplete() {
    writeOnboardingState({ completed: true, showReady: true });
}

function clearShowReadyFlag() {
    const state = readOnboardingState();
    writeOnboardingState({ ...state, showReady: false });
}

function setupAppLoggingIpc() {
    // Renderer/popup processes send logs here so everything routes through Logfire.
    ipcMain.on("app-log", (_event, payload) => {
        logger.emitFromIpc({
            ...(payload || {}),
            context: {
                source: payload?.context?.source || "renderer",
                ...(payload?.context || {}),
            },
        });
    });
}

function getTrayIconPath() {
    // In production, we copy the tray icon into Resources via forge `extraResource`.
    const prodPath = path.join(process.resourcesPath, "gia-tray.png");
    if (app.isPackaged) return prodPath;

    // In dev, `__dirname` can be webpack-transformed; try a few stable locations.
    const candidates = [
        path.join(process.cwd(), "src", "assets", "gia-tray.png"),
        path.join(app.getAppPath(), "src", "assets", "gia-tray.png"),
        path.resolve(__dirname, "..", "..", "src", "assets", "gia-tray.png"),
    ];

    for (const p of candidates) {
        try {
            if (fs.existsSync(p)) return p;
        } catch {
            // ignore and try next candidate
        }
    }

    return candidates[0];
}

function refreshTrayMenu() {
    if (!tray) return;
    tray.setContextMenu(buildTrayMenu());
}

async function showUploadTokenErrorDialog(error) {
    try {
        const parent =
            BrowserWindow.getFocusedWindow() ||
            (meetingPopupWindow && !meetingPopupWindow.isDestroyed()
                ? meetingPopupWindow
                : null);

        const status =
            typeof error?.status === "number"
                ? error.status
                : (() => {
                      const msg =
                          error instanceof Error
                              ? error.message
                              : typeof error === "string"
                                ? error
                                : "";
                      const m = msg.match(/\((\d{3})\)/);
                      return m ? Number(m[1]) : null;
                  })();

        const isForbidden = status === 403;

        const detail =
            error instanceof Error
                ? error.message
                : typeof error === "string"
                  ? error
                  : JSON.stringify(error);

        await dialog.showMessageBox(parent ?? undefined, {
            type: "error",
            title: "Couldn’t start recording",
            message: isForbidden
                ? "Botless recordings are not enabled. Enable Botless Recordings in the platform to use this feature."
                : "We couldn’t start the recording. Please try again. If the problem persists, please contact support.",
            detail,
            buttons: ["OK"],
            defaultId: 0,
            noLink: true,
        });
    } catch {
        // ignore dialog failures (e.g. app shutting down)
    }
}

async function startMeetingRecordingWithAuth({ source = "unknown" } = {}) {
    if (!currentMeetingInfo) {
        throw new Error("No meeting information available");
    }
    if (isRecording) return;

    logger.info(`[recall] start recording requested (source=${source})`);
    userWantsToRecord = true;
    closeMeetingPopup();
    refreshTrayMenu();

    logger.info(
        `[recall] currentMeetingInfo: ${JSON.stringify(currentMeetingInfo)}`,
    );

    try {
        const accessToken = await ensureAccessToken({ interactive: true });
        if (!accessToken) {
            throw new Error("Not authenticated: no access token available");
        }

        await getUploadTokenAndStoreInfo();
        logger.info(`[recall] uploadToken: ${currentMeetingInfo.uploadToken}`);
        await registerCurrentMeetingUrlIfNeeded();
        logger.info(`[recall] meeting URL registration check complete`);
        await startMeetingRecording();
    } catch (error) {
        logger.error(
            `[recall] failed to start recording (source=${source}):`,
            error,
        );
        // Keep meeting info so the user can retry while meeting is still active.
        userWantsToRecord = false;
        recordingStarted = false;
        refreshTrayMenu();
        throw error;
    }
}

function buildTrayMenu() {
    const status = !isRecording ? "Idle" : isPaused ? "Paused" : "Recording";
    // Treat "Start Recording" as another way to accept the popup:
    // if a meeting is active and we're not already recording, allow manual start.
    const canManualStart =
        !!currentMeetingInfo && !isRecording && !userWantsToRecord;
    const template = [
        {
            label: `Status: ${status}`,
            enabled: false,
        },
        ...(canManualStart
            ? [
                  {
                      label: "Start Recording",
                      enabled: true,
                      click: async () => {
                          try {
                              await startMeetingRecordingWithAuth({
                                  source: "tray",
                              });
                          } catch (e) {
                              logger.error(
                                  "[tray] failed to start recording:",
                                  e,
                              );
                          }
                      },
                  },
              ]
            : []),
        {
            label: isPaused ? "Resume Recording" : "Pause Recording",
            enabled: isRecording,
            click: async () => {
                try {
                    if (isPaused) {
                        await resumeMeetingRecording();
                    } else {
                        await pauseMeetingRecording();
                    }
                } catch (e) {
                    logger.error("[tray] failed to toggle pause:", e);
                }
            },
        },
        {
            label: "Stop Recording",
            enabled: isRecording,
            click: async () => {
                try {
                    const windowId = currentMeetingInfo?.windowId;
                    suppressMeetingPopupForWindow(windowId, "tray-stop");
                    await stopMeetingRecording();
                } catch (e) {
                    logger.error("[tray] failed to stop recording:", e);
                } finally {
                    // Clear meeting state after the stop attempt to avoid stuck UI/state.
                    userWantsToRecord = false;
                    recordingStarted = false;
                    currentMeetingInfo = null;
                    closeMeetingPopup();
                }
            },
        },
        { type: "separator" },
        ...(DEBUG
            ? [
                  {
                      label: "Show Debug Controls",
                      enabled: isRecording,
                      click: async () => {
                          try {
                              showDebugControlsWindow({ focus: true });
                          } catch (e) {
                              logger.error(
                                  "[tray] failed to show debug controls:",
                                  e,
                              );
                          }
                      },
                  },
                  {
                      label: "Open Logs",
                      click: async () => {
                          try {
                              const logsDir = app.getPath("logs");
                              const target =
                                  logFilePath && fs.existsSync(logFilePath)
                                      ? logFilePath
                                      : logsDir;
                              await shell.openPath(target);
                          } catch (e) {
                              logger.error("[tray] failed to open logs:", e);
                          }
                      },
                  },
                  { type: "separator" },
              ]
            : []),
        {
            label: "Quit",
            click: () => app.quit(),
        },
    ];

    return Menu.buildFromTemplate(template);
}

function createTray() {
    if (tray) return tray;
    const iconPath = getTrayIconPath();
    let image = nativeImage.createFromPath(iconPath);
    if (process.platform === "darwin") {
        // Menubar icons look best when explicitly sized.
        image = image.resize({ width: 18, height: 18 });
        try {
            image.setTemplateImage(true);
        } catch {
            // ignore
        }
    }
    tray = new Tray(image);
    tray.setToolTip(app.getName());
    // Icon-only in the menu bar when idle; a small dot appears when recording (set in setRecordingState).
    if (process.platform === "darwin" && image.isEmpty()) {
        // If we couldn't load the icon, show something so it's discoverable.
        tray.setTitle("!");
    } else if (process.platform === "darwin") {
        tray.setTitle("");
    }
    tray.setContextMenu(buildTrayMenu());
    tray.on("click", () => {
        tray?.popUpContextMenu();
    });
    return tray;
}

function setCaptureState({ recording, paused }) {
    isRecording = !!recording;
    isPaused = !!paused;
    if (!isRecording) isPaused = false;

    if (tray && process.platform === "darwin") {
        // Show a subtle indicator in the menu bar.
        // - Recording: ●
        // - Paused:   Ⅱ
        tray.setTitle(isRecording ? (isPaused ? "Ⅱ" : "●") : "");
    }

    if (tray) {
        const status = !isRecording
            ? "Idle"
            : isPaused
              ? "Paused"
              : "Recording";
        tray.setToolTip(`${app.getName()} — ${status}`);
        refreshTrayMenu();
    }

    // Developer-only floating controls while recording.
    if (DEBUG) {
        if (isRecording) {
            showDebugControlsWindow({ focus: false });
            sendDebugControlsState();
        } else {
            closeDebugControlsWindow();
        }
    }
}

async function pauseMeetingRecording() {
    if (!isRecording) {
        logger.info("[recall] not recording, nothing to pause");
        return;
    }
    if (isPaused) {
        logger.info("[recall] already paused");
        return;
    }
    if (!currentMeetingInfo?.windowId) {
        throw new Error("Cannot pause recording: missing windowId");
    }
    const { windowId } = currentMeetingInfo;
    await RecallAiSdk.pauseRecording({ windowId });
    logger.info("[recall] recording paused for windowId:", windowId);
    setCaptureState({ recording: true, paused: true });
}

async function resumeMeetingRecording() {
    if (!isRecording) {
        logger.info("[recall] not recording, nothing to resume");
        return;
    }
    if (!isPaused) {
        logger.info("[recall] not paused");
        return;
    }
    if (!currentMeetingInfo?.windowId) {
        throw new Error("Cannot resume recording: missing windowId");
    }
    const { windowId } = currentMeetingInfo;
    await RecallAiSdk.resumeRecording({ windowId });
    logger.info("[recall] recording resumed for windowId:", windowId);
    setCaptureState({ recording: true, paused: false });
}

async function ensureAccessToken({ interactive = false, loginOpts = {} } = {}) {
    logger.info(`[recall] ensureAccessToken: ${JSON.stringify(loginOpts)}`);
    // First try: stored/refreshable token (no UI)
    const stored = await getStoredAccessToken({ allowRefresh: true });
    if (stored?.access_token) {
        api.setAuthToken(stored.access_token);
        await syncUserIdFromProfile();
        sendDesktopSdkDiagnosticsIfNeeded();
        return stored.access_token;
    }

    // No token available and we're not allowed to open UI
    if (!interactive) {
        api.setAuthToken(null);
        await syncUserIdFromProfile();
        return null;
    }

    // Prevent multiple auth popups at once
    if (!loginInFlight) {
        loginInFlight = (async () => {
            await login(loginOpts);
            const after = await getStoredAccessToken({ allowRefresh: true });
            api.setAuthToken(after?.access_token || null);
            await syncUserIdFromProfile();
            sendDesktopSdkDiagnosticsIfNeeded();
            return after?.access_token || null;
        })().finally(() => {
            loginInFlight = null;
        });
    }

    logger.info(`[recall] loginInFlight: ${loginInFlight}`);

    return await loginInFlight;
}

function getMeetingPopupPath() {
    // In production, the file is copied to Resources via extraResource
    if (app.isPackaged) {
        const resourcePath = path.join(
            process.resourcesPath,
            "meeting-popup.html",
        );
        logger.info("[popup] looking for popup at:", resourcePath);
        if (fs.existsSync(resourcePath)) {
            return resourcePath;
        }
        logger.error("[popup] popup HTML not found at:", resourcePath);
    }

    // In dev, try a few locations
    const candidates = [
        path.join(process.cwd(), "src", "meeting-popup.html"),
        path.join(app.getAppPath(), "src", "meeting-popup.html"),
        path.resolve(__dirname, "..", "..", "src", "meeting-popup.html"),
        path.resolve(__dirname, "..", "meeting-popup.html"),
    ];

    for (const p of candidates) {
        try {
            if (fs.existsSync(p)) {
                logger.info("[popup] found popup at:", p);
                return p;
            }
        } catch {
            // ignore and try next candidate
        }
    }

    logger.error("[popup] popup HTML not found in any candidate path");
    return candidates[0];
}

function getDebugControlsPath() {
    // In production, the file can be copied to Resources via forge extraResource.
    if (app.isPackaged) {
        const resourcePath = path.join(
            process.resourcesPath,
            "debug-controls.html",
        );
        if (fs.existsSync(resourcePath)) return resourcePath;
    }

    // In dev, try a few locations
    const candidates = [
        path.join(process.cwd(), "src", "debug-controls.html"),
        path.join(app.getAppPath(), "src", "debug-controls.html"),
        path.resolve(__dirname, "..", "..", "src", "debug-controls.html"),
        path.resolve(__dirname, "..", "debug-controls.html"),
    ];

    for (const p of candidates) {
        try {
            if (fs.existsSync(p)) return p;
        } catch {
            // ignore and try next candidate
        }
    }

    return candidates[0];
}

function sendDebugControlsState() {
    if (!debugControlsWindow || debugControlsWindow.isDestroyed()) return;
    debugControlsWindow.webContents.send("debug-controls:state", {
        recording: isRecording,
        paused: isPaused,
        windowId: currentMeetingInfo?.windowId ?? null,
    });
}

function showDebugControlsWindow({ focus = false } = {}) {
    if (!DEBUG) return;

    if (debugControlsWindow && !debugControlsWindow.isDestroyed()) {
        debugControlsWindow.show();
        if (focus) debugControlsWindow.focus();
        sendDebugControlsState();
        return;
    }

    const debugPath = getDebugControlsPath();
    debugControlsWindow = new BrowserWindow({
        width: 340,
        height: 220,
        resizable: false,
        minimizable: true,
        maximizable: false,
        closable: true,
        alwaysOnTop: true,
        frame: true,
        transparent: false,
        backgroundColor: "#0b0f14",
        show: false,
        skipTaskbar: false,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
        },
    });

    debugControlsWindow.loadFile(debugPath);
    debugControlsWindow.center();

    debugControlsWindow.once("ready-to-show", () => {
        debugControlsWindow?.show();
        if (focus) debugControlsWindow?.focus();
    });

    debugControlsWindow.webContents.on("did-finish-load", () => {
        sendDebugControlsState();
    });

    debugControlsWindow.webContents.on("will-navigate", (e) => {
        e.preventDefault();
    });

    debugControlsWindow.on("closed", () => {
        debugControlsWindow = null;
    });
}

function closeDebugControlsWindow() {
    if (debugControlsWindow && !debugControlsWindow.isDestroyed()) {
        debugControlsWindow.destroy();
        debugControlsWindow = null;
    }
}

function getOnboardingPopupPath() {
    // In production, the file is copied to Resources via extraResource
    if (app.isPackaged) {
        const resourcePath = path.join(
            process.resourcesPath,
            "onboarding-popup.html",
        );
        if (fs.existsSync(resourcePath)) {
            return resourcePath;
        }
    }

    // In dev, try a few locations
    const candidates = [
        path.join(process.cwd(), "src", "onboarding-popup.html"),
        path.join(app.getAppPath(), "src", "onboarding-popup.html"),
        path.resolve(__dirname, "..", "..", "src", "onboarding-popup.html"),
        path.resolve(__dirname, "..", "onboarding-popup.html"),
    ];

    for (const p of candidates) {
        try {
            if (fs.existsSync(p)) {
                return p;
            }
        } catch {
            // ignore
        }
    }

    return candidates[0];
}

function showOnboardingPopup({ view = "login" } = {}) {
    // Close existing onboarding window if any
    if (onboardingWindow && !onboardingWindow.isDestroyed()) {
        onboardingWindow.close();
    }

    const popupPath = getOnboardingPopupPath();
    logger.info("[onboarding] showing popup, view:", view);

    onboardingWindow = new BrowserWindow({
        width: 440,
        height: view === "ready" ? 480 : view === "permissions" ? 520 : 340,
        resizable: false,
        minimizable: true,
        maximizable: false,
        closable: true,
        alwaysOnTop: false,
        frame: false,
        transparent: false,
        backgroundColor: "#ffffff",
        show: false,
        skipTaskbar: false,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
        },
    });

    onboardingWindow.loadFile(popupPath);

    onboardingWindow.webContents.on("did-finish-load", () => {
        try {
            // Send the Gia logo
            const iconPath = getTrayIconPath();
            const img = nativeImage.createFromPath(iconPath);
            const dataUrl = img?.isEmpty?.() ? null : img.toDataURL();
            if (onboardingWindow && !onboardingWindow.isDestroyed()) {
                onboardingWindow.webContents.send("onboarding:logo", {
                    dataUrl,
                });

                // Send initial state
                const permissions = readPermissionStates();
                onboardingWindow.webContents.send("onboarding:init", {
                    view,
                    permissions: {
                        microphone: permissions.microphone === "granted",
                        accessibility: permissions.accessibility === true,
                        screen: permissions.screenCapture === "granted",
                    },
                });
            }
        } catch (e) {
            logger.error("[onboarding] failed to send init data:", e);
        }
    });

    onboardingWindow.center();

    onboardingWindow.once("ready-to-show", () => {
        onboardingWindow?.show();
    });

    onboardingWindow.on("closed", () => {
        onboardingWindow = null;
    });

    onboardingWindow.webContents.on("will-navigate", (e) => {
        e.preventDefault();
    });

    return onboardingWindow;
}

function closeOnboardingPopup() {
    if (onboardingWindow && !onboardingWindow.isDestroyed()) {
        onboardingWindow.destroy();
        onboardingWindow = null;
    }
}

function bringOnboardingToFront(reason = "unknown") {
    bringWindowToFront(onboardingWindow, reason);
}

// Track if SDK has been initialized (for lazy initialization during onboarding)
let sdkInitialized = false;
let recallRuntimeListenersRegistered = false;

function ensureRecallRuntimeListenersRegistered() {
    if (recallRuntimeListenersRegistered) return;
    recallRuntimeListenersRegistered = true;

    logger.info("[recall] registering runtime listeners (post-onboarding)");

    RecallAiSdk.addEventListener("meeting-detected", async (evt) => {
        const windowId = evt.window.id;
        const meetingPlatform = evt.window?.platform;
        logger.info("[recall] meeting-detected event:", evt.window);
        logger.info("[recall] window id:", windowId);

        // Don't show popup if this meeting was already stopped/declined by the user
        if (suppressedMeetingWindowIds.has(windowId)) {
            logger.info(
                "[recall] meeting-detected ignored (user already stopped/declined this meeting)",
            );
            return;
        }

        if (meetingPlatform === "slack") {
            logger.info(
                "[recall] slack meeting detected, skipping popup and recording",
            );
            return;
        }

        // Don't show popup if we're already recording
        if (isRecording) {
            logger.info(
                "[recall] already recording, ignoring new meeting detection",
            );
            return;
        }

        // Reset flags for new meeting
        userWantsToRecord = false;
        recordingStarted = false;

        try {
            logger.info(
                "[recall] meeting detected: initializing meeting state",
            );
            // Store meeting info. Important: do NOT call the API here.
            // We only authenticate + fetch upload token after the user confirms.
            currentMeetingInfo = {
                windowId: windowId,
                meetingUrl: null,
                uploadToken: null,
                recordingId: null,
                sdkUploadId: null,
                lastRegisteredMeetingUrl: null,
                lastRegisterAttemptUrl: null,
                lastRegisterAttemptAt: 0,
            };

            // Show popup to ask if user wants to record
            logger.info("[recall] showing meeting popup...");
            showMeetingPopup();
            refreshTrayMenu();
        } catch (e) {
            logger.error("[recall] meeting detection failed:", e);
            currentMeetingInfo = null;
            refreshTrayMenu();
        }
    });

    // Global permission-status listener (diagnostics + relaunch behavior)
    RecallAiSdk.addEventListener("permission-status", (evt) => {
        const { permission, status } = evt;
        logger.info(
            `[recall] permission-status event: ${permission}, ${status}`,
        );

        // Track latest permission statuses for diagnostics.
        try {
            if (typeof permission === "string") {
                recallPermissionStatuses = {
                    ...(recallPermissionStatuses || {}),
                    [permission]: status,
                };
                recallPermissionStatusesUpdatedAt = new Date().toISOString();
                sendDesktopSdkDiagnosticsIfNeeded();
            }
        } catch (e) {
            logger.warn("[recall] failed to store permission-status", e);
        }

        // Notify onboarding popup if it's open
        if (onboardingWindow && !onboardingWindow.isDestroyed()) {
            const permissionMap = {
                microphone: "microphone",
                accessibility: "accessibility",
                "screen-capture": "screen",
            };
            const mappedPermission = permissionMap[permission];
            if (mappedPermission && status === "granted") {
                onboardingWindow.webContents.send(
                    "onboarding:permission-status",
                    {
                        permission: mappedPermission,
                        granted: true,
                    },
                );
                if (mappedPermission === "microphone") {
                    bringOnboardingToFront("microphone-granted:global");
                }
            }
        }

        // Prefer the SDK event: once Accessibility becomes granted, relaunch to ensure
        // downstream frameworks pick up the new TCC permission.
        // But only if onboarding is complete (we handle restart ourselves during onboarding)
        if (
            process.platform === "darwin" &&
            permission === "accessibility" &&
            status === "granted" &&
            isOnboardingComplete()
        ) {
            captureAccessibilityTrustedAtStartupOnce();
            if (accessibilityTrustedAtStartup === false) {
                relaunchApp({ reason: "recall-permission-status" });
            }
        }
    });

    RecallAiSdk.addEventListener("meeting-updated", async (evt) => {
        const meetingUrl = evt.window?.url ?? null;
        const windowId = evt.window?.id ?? null;
        logger.info("[recall] meeting-updated event:", evt.window);
        logger.info("[recall] meeting-updated URL:", meetingUrl);

        if (!meetingUrl) return;

        // Only register URLs for the meeting we're currently tracking.
        if (
            !currentMeetingInfo ||
            !windowId ||
            currentMeetingInfo.windowId !== windowId
        ) {
            logger.info(
                "[recall] meeting-updated ignored (no current meeting or window mismatch)",
            );
            return;
        }

        // Always keep the latest meeting URL, but only call the API after user confirms.
        currentMeetingInfo.meetingUrl = meetingUrl;
        logger.info(
            "[recall] stored meeting URL (confirmed=%s)",
            userWantsToRecord,
        );

        if (!userWantsToRecord) {
            logger.info(
                "[recall] deferring meeting URL registration until confirm",
            );
            return;
        }

        await registerCurrentMeetingUrlIfNeeded();
    });

    RecallAiSdk.addEventListener("sdk-state-change", async (evt) => {
        logger.info("[recall] sdk-state-change event:", evt.sdk.state.code);
        switch (evt.sdk.state.code) {
            case "recording":
                logger.info("[recall] SDK is recording");
                if (!isRecording || isPaused) {
                    setCaptureState({ recording: true, paused: false });
                }
                break;
            case "idle":
                logger.info("[recall] SDK is idle");
                // If we initiated a pause, treat idle as paused to avoid resetting meeting state.
                if (isPaused) {
                    setCaptureState({ recording: true, paused: true });
                    break;
                }

                setCaptureState({ recording: false, paused: false });
                // Close popup when meeting ends (goes to idle)
                if (meetingPopupWindow && !meetingPopupWindow.isDestroyed()) {
                    logger.info("[recall] closing popup due to idle state");
                    meetingPopupWindow.webContents.send(
                        "meeting-popup:recording-ended",
                    );
                    setTimeout(() => {
                        closeMeetingPopup();
                    }, 100);
                }
                // Clear suppression for this meeting since it truly ended
                clearMeetingPopupSuppression(currentMeetingInfo?.windowId);
                // Reset all meeting state
                userWantsToRecord = false;
                recordingStarted = false;
                currentMeetingInfo = null;
                refreshTrayMenu();
                break;
            default:
                logger.info("[recall] SDK state:", evt.sdk.state.code);
        }
    });

    RecallAiSdk.addEventListener("recording-ended", async (evt) => {
        logger.info("[recall] recording-ended event received");
        logger.info("[recall] Uploaded", evt.window);
        setCaptureState({ recording: false, paused: false });
        // Close popup when recording ends
        if (meetingPopupWindow && !meetingPopupWindow.isDestroyed()) {
            logger.info("[recall] closing popup due to recording-ended");
            meetingPopupWindow.webContents.send(
                "meeting-popup:recording-ended",
            );
            setTimeout(() => {
                closeMeetingPopup();
            }, 100);
        }
        // Clear suppression for this meeting since it truly ended
        const endedWindowId = evt.window?.id || currentMeetingInfo?.windowId;
        clearMeetingPopupSuppression(endedWindowId);
        // Reset all meeting state
        userWantsToRecord = false;
        recordingStarted = false;
        currentMeetingInfo = null;
        refreshTrayMenu();
    });
}

function ensureSdkInitialized() {
    if (!sdkInitialized) {
        logger.info(
            "[recall] Lazy initializing SDK for onboarding permission request",
        );
        const onboardingComplete = Boolean(isOnboardingComplete?.());
        const initOptions = onboardingComplete
            ? {
                  apiUrl: "https://us-east-1.recall.ai",
              }
            : {
                  apiUrl: "https://us-east-1.recall.ai",
                  // Critical: prevent SDK from auto-requesting other permissions on init during onboarding
                  // so one click => one permission prompt.
                  acquirePermissionsOnStartup: [],
              };
        RecallAiSdk.init(initOptions);
        sdkInitialized = true;

        // Register permission-status listener for onboarding
        RecallAiSdk.addEventListener("permission-status", (evt) => {
            const { permission, status } = evt;
            logger.info(
                `[recall] onboarding permission-status: ${permission}, ${status}`,
            );

            // Notify onboarding popup if it's open
            if (onboardingWindow && !onboardingWindow.isDestroyed()) {
                const permissionMap = {
                    microphone: "microphone",
                    accessibility: "accessibility",
                    "screen-capture": "screen",
                };
                const mappedPermission = permissionMap[permission];
                if (mappedPermission) {
                    const granted = status === "granted" || status === true;
                    logger.info(
                        `[onboarding] sending permission status: ${mappedPermission} = ${granted}`,
                    );
                    onboardingWindow.webContents.send(
                        "onboarding:permission-status",
                        {
                            permission: mappedPermission,
                            granted,
                        },
                    );
                    // If the user just granted mic, macOS may have pushed our window behind others.
                    if (mappedPermission === "microphone" && granted) {
                        bringOnboardingToFront("microphone-granted");
                    }
                }
            }
        });
    }
}

async function setupOnboardingIpc() {
    ipcMain.handle("onboarding:close", async () => {
        closeOnboardingPopup();
    });

    ipcMain.handle("onboarding:minimize", async () => {
        if (onboardingWindow && !onboardingWindow.isDestroyed()) {
            onboardingWindow.minimize();
        }
    });

    ipcMain.handle("onboarding:resize", async (_event, { width, height }) => {
        if (onboardingWindow && !onboardingWindow.isDestroyed()) {
            logger.info(`[onboarding] resizing window to ${width}x${height}`);
            onboardingWindow.setSize(width, height, true);
            onboardingWindow.center();
        }
    });

    ipcMain.handle("onboarding:login", async () => {
        try {
            logger.info("[onboarding] starting login...");
            const accessToken = await ensureAccessToken({ interactive: true });
            if (accessToken) {
                logger.info("[onboarding] login successful");
                return { success: true };
            } else {
                logger.warn("[onboarding] login returned no token");
                return { success: false, error: "No token returned" };
            }
        } catch (e) {
            logger.error("[onboarding] login failed:", e);
            return { success: false, error: e.message };
        }
    });

    ipcMain.handle(
        "onboarding:request-permission",
        async (_event, permission) => {
            logger.info("[onboarding] requesting permission:", permission);

            // Initialize SDK if needed so we can listen for permission-status events
            ensureSdkInitialized();

            try {
                const permissionMap = {
                    microphone: "microphone",
                    accessibility: "accessibility",
                    screen: "screen-capture",
                };

                const sdkPermission = permissionMap[permission];
                if (!sdkPermission) {
                    return {
                        granted: false,
                        error: `Unknown permission: ${permission}`,
                    };
                }

                // IMPORTANT:
                // During onboarding we do NOT open System Settings ourselves and do NOT use
                // Electron's native permission APIs. We let the Recall SDK drive the flow.
                // One click => one RecallAiSdk.requestPermission(permission).
                logger.info(
                    "[onboarding] requesting permission via Recall SDK:",
                    sdkPermission,
                );
                try {
                    // requestPermission is documented as sync, but tolerate promise return.
                    await Promise.resolve(
                        RecallAiSdk.requestPermission(sdkPermission),
                    );
                } catch (e) {
                    logger.warn(
                        "[onboarding] Recall SDK requestPermission threw",
                        e,
                    );
                }

                // Best-effort immediate snapshot (usually still false until user acts).
                const os = readPermissionStates();
                let granted = false;
                if (permission === "microphone")
                    granted = os.microphone === "granted";
                if (permission === "screen")
                    granted = os.screenCapture === "granted";
                if (permission === "accessibility")
                    granted = os.accessibility === true;

                logger.info(
                    `[onboarding] permission ${permission} granted:`,
                    granted,
                );
                return { granted };
            } catch (e) {
                logger.error("[onboarding] permission request failed:", e);
                return { granted: false, error: e.message };
            }
        },
    );

    // Add a handler to check current permission status (for polling)
    ipcMain.handle(
        "onboarding:check-permission",
        async (_event, permission) => {
            try {
                let granted = false;

                if (permission === "microphone") {
                    const status =
                        systemPreferences.getMediaAccessStatus("microphone");
                    granted = status === "granted";
                } else if (permission === "accessibility") {
                    granted = systemPreferences.isTrustedAccessibilityClient({
                        prompt: false,
                    });
                } else if (permission === "screen") {
                    const status =
                        systemPreferences.getMediaAccessStatus("screen");
                    granted = status === "granted";
                }

                return { granted };
            } catch (e) {
                logger.error("[onboarding] check permission failed:", e);
                return { granted: false };
            }
        },
    );

    ipcMain.handle("onboarding:complete", async () => {
        logger.info("[onboarding] onboarding complete (no relaunch)");

        // Mark onboarding complete WITHOUT forcing a relaunch flow.
        // (We show the ready screen immediately in the existing window.)
        writeOnboardingState({ completed: true, showReady: false });

        // Ensure auth/diagnostics are in sync now that onboarding is done.
        try {
            const auth = await isAuthenticated();
            api.setAuthToken(auth.accessToken);
            await syncUserIdFromProfile();
            sendDesktopSdkDiagnosticsIfNeeded();
        } catch (e) {
            logger.warn("[onboarding] post-complete auth sync failed", e);
        }

        // Now that onboarding is complete, register full runtime listeners (meeting detection, etc.)
        try {
            captureAccessibilityTrustedAtStartupOnce();
            setupPermissionLogging({
                onChange: ({ prev, next, reason }) => {
                    maybeRelaunchAfterAccessibilityGranted({
                        prev,
                        next,
                        reason,
                    });
                    sendDesktopSdkDiagnosticsIfNeeded();
                },
            });
        } catch (e) {
            logger.warn("[onboarding] failed to setup permission logging", e);
        }

        try {
            ensureRecallRuntimeListenersRegistered();
        } catch (e) {
            logger.warn("[onboarding] failed to register runtime listeners", e);
        }

        // Show the ready view in the existing onboarding window.
        try {
            if (onboardingWindow && !onboardingWindow.isDestroyed()) {
                onboardingWindow.setSize(440, 480, true);
                onboardingWindow.center();
                const permissions = readPermissionStates();
                onboardingWindow.webContents.send("onboarding:init", {
                    view: "ready",
                    permissions: {
                        microphone: permissions.microphone === "granted",
                        accessibility: permissions.accessibility === true,
                        screen: permissions.screenCapture === "granted",
                    },
                });
                bringOnboardingToFront("onboarding-complete-ready");
            }
        } catch (e) {
            logger.warn("[onboarding] failed to show ready view", e);
        }

        return { success: true };
    });

    ipcMain.handle("onboarding:get-started", async () => {
        logger.info("[onboarding] user clicked get started, restarting app");

        // Clear the show ready flag
        clearShowReadyFlag();

        // Close the onboarding window
        closeOnboardingPopup();

        // Restart the app so it launches fresh with all permissions active
        app.relaunch();
        app.exit(0);
    });
}

function showMeetingPopup() {
    // Destroy existing popup if any (use destroy() not close() to ensure synchronous cleanup)
    if (meetingPopupWindow && !meetingPopupWindow.isDestroyed()) {
        meetingPopupWindow.destroy();
        meetingPopupWindow = null;
    }

    const popupPath = getMeetingPopupPath();

    meetingPopupWindow = new BrowserWindow({
        width: 340,
        height: 220,
        resizable: false,
        minimizable: true,
        maximizable: false,
        closable: false,
        alwaysOnTop: true,
        frame: false,
        transparent: false,
        backgroundColor: "#ffffff",
        show: false,
        skipTaskbar: false,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
        },
    });

    // Load the popup HTML
    meetingPopupWindow.loadFile(popupPath);

    // Send the Gia logo (as a data URL) to the popup so the asset
    // path works in both dev and packaged builds.
    meetingPopupWindow.webContents.on("did-finish-load", () => {
        try {
            const iconPath = getTrayIconPath();
            const img = nativeImage.createFromPath(iconPath);
            const dataUrl = img?.isEmpty?.() ? null : img.toDataURL();
            if (meetingPopupWindow && !meetingPopupWindow.isDestroyed()) {
                meetingPopupWindow.webContents.send("meeting-popup:logo", {
                    dataUrl,
                });
            }
        } catch (e) {
            logger.error("[popup] failed to send logo:", e);
        }
    });

    // Center the window
    meetingPopupWindow.center();

    // Show when ready
    meetingPopupWindow.once("ready-to-show", () => {
        meetingPopupWindow?.show();
    });

    // Clean up on close
    meetingPopupWindow.on("closed", () => {
        meetingPopupWindow = null;
        // Keep meeting info while the meeting is active so the user can start
        // recording later from the tray (even if they closed/declined the popup).
    });

    // Prevent navigation
    meetingPopupWindow.webContents.on("will-navigate", (e) => {
        e.preventDefault();
    });
}

function closeMeetingPopup() {
    if (meetingPopupWindow && !meetingPopupWindow.isDestroyed()) {
        meetingPopupWindow.destroy();
        meetingPopupWindow = null;
    }
}

async function getUploadTokenAndStoreInfo() {
    if (!currentMeetingInfo) {
        throw new Error("No meeting information available");
    }

    // Get upload token if we don't have it yet
    if (!currentMeetingInfo.uploadToken) {
        logger.info("[recall] requesting upload token...");
        let uploadTokenData;
        try {
            uploadTokenData = await api.getUploadToken();
        } catch (error) {
            logger.error("[recall] failed to get upload token:", error);
            await showUploadTokenErrorDialog(error);
            throw error;
        }
        logger.info("[recall] upload token data:", uploadTokenData);

        // Check both possible response formats - token may be nested
        let uploadToken;
        if (uploadTokenData.uploadToken?.upload_token) {
            // Nested format: { uploadToken: { upload_token: "..." } }
            uploadToken = uploadTokenData.uploadToken.upload_token;
        } else if (uploadTokenData.upload_token) {
            // Direct format: { upload_token: "..." }
            uploadToken = uploadTokenData.upload_token;
        } else if (typeof uploadTokenData.uploadToken === "string") {
            // String format: { uploadToken: "..." }
            uploadToken = uploadTokenData.uploadToken;
        }

        if (!uploadToken) {
            const error = new Error(
                `Upload token not found in response: ${JSON.stringify(uploadTokenData)}`,
            );
            await showUploadTokenErrorDialog(error);
            throw error;
        }

        logger.info("[recall] extracted upload token:", uploadToken);
        currentMeetingInfo.uploadToken = uploadToken;

        const recordingId = uploadTokenData.uploadToken?.recording_id ?? null;
        if (recordingId) {
            logger.info("[recall] extracted recording id:", recordingId);
        }
        currentMeetingInfo.recordingId = recordingId;

        // Store sdk upload id (if provided by the API)
        const sdkUploadId =
            uploadTokenData.uploadToken?.sdk_upload_id ??
            uploadTokenData.sdk_upload_id ??
            uploadTokenData.uploadToken?.sdkUploadId ??
            uploadTokenData.sdkUploadId ??
            null;
        if (sdkUploadId) {
            logger.info("[recall] extracted sdk upload id:", sdkUploadId);
        }
        currentMeetingInfo.sdkUploadId = sdkUploadId;
    }
}

async function registerCurrentMeetingUrlIfNeeded() {
    if (!currentMeetingInfo) {
        logger.info("[recall] register meeting URL skipped (no meeting info)");
        return;
    }

    const meetingUrl = currentMeetingInfo.meetingUrl ?? null;
    if (!meetingUrl) {
        logger.info(
            "[recall] register meeting URL skipped (no meeting URL yet)",
        );
        return;
    }

    // Dedupe and throttle to avoid spamming the API.
    const now = Date.now();
    const alreadyRegistered =
        currentMeetingInfo.lastRegisteredMeetingUrl === meetingUrl;
    const recentlyAttemptedSameUrl =
        currentMeetingInfo.lastRegisterAttemptUrl === meetingUrl &&
        now - (currentMeetingInfo.lastRegisterAttemptAt || 0) < 15_000;

    if (alreadyRegistered) {
        logger.info(
            "[recall] register meeting URL skipped (already registered)",
        );
        return;
    }
    if (recentlyAttemptedSameUrl) {
        logger.info("[recall] register meeting URL skipped (throttled)");
        return;
    }

    try {
        logger.info("[recall] registering meeting URL...");
        const accessToken = await ensureAccessToken({ interactive: false });
        if (!accessToken) {
            logger.info(
                "[recall] cannot register meeting URL (not authenticated)",
            );
            return;
        }

        const recordingId = currentMeetingInfo.recordingId ?? null;
        const sdkUploadId = currentMeetingInfo.sdkUploadId ?? null;

        if (!recordingId || !sdkUploadId) {
            logger.info(
                "[recall] cannot register meeting URL (no recording ID or SDK upload ID)",
            );
            return;
        }

        // Only throttle/dedupe after we have the required identifiers and are
        // actually going to make the API call. This prevents race conditions
        // (e.g. meeting-updated firing before upload token info is stored)
        // from permanently blocking later registration.
        currentMeetingInfo.lastRegisterAttemptUrl = meetingUrl;
        currentMeetingInfo.lastRegisterAttemptAt = now;

        await api.registerMeetingUrl({
            meetingUrl,
            recordingId,
            sdkUploadId,
        });

        currentMeetingInfo.lastRegisteredMeetingUrl = meetingUrl;
        logger.info("[recall] registered meeting URL");
    } catch (e) {
        logger.error("[recall] failed to register meeting URL:", e);
    }
}

async function startMeetingRecording() {
    if (!currentMeetingInfo) {
        throw new Error("No meeting information available");
    }

    if (recordingStarted) {
        logger.info("[recall] recording already started, skipping");
        return;
    }

    const { windowId, uploadToken } = currentMeetingInfo;

    if (!uploadToken) {
        throw new Error("No upload token available");
    }

    logger.info("[recall] starting recording with windowId:", windowId);
    logger.info("[recall] starting recording with uploadToken:", uploadToken);

    // Mark as started BEFORE the async call to prevent race conditions
    recordingStarted = true;

    try {
        await RecallAiSdk.startRecording({
            windowId: windowId,
            uploadToken: uploadToken,
        });

        logger.info("[recall] recording started successfully");
        setCaptureState({ recording: true, paused: false });

        // Notify popup that recording started
        if (meetingPopupWindow && !meetingPopupWindow.isDestroyed()) {
            meetingPopupWindow.webContents.send(
                "meeting-popup:recording-started",
            );
        }
    } catch (error) {
        // Reset flag on failure so it can be retried
        recordingStarted = false;
        throw error;
    }
}

async function stopMeetingRecording() {
    if (!isRecording) {
        logger.info("[recall] not recording, nothing to stop");
        return;
    }

    // Need windowId to stop recording - use currentMeetingInfo if available
    if (!currentMeetingInfo || !currentMeetingInfo.windowId) {
        logger.warn(
            "[recall] cannot stop recording: no meeting info or windowId",
        );
        // Recording might have already ended, just mark as not recording
        setCaptureState({ recording: false, paused: false });
        return;
    }

    const { windowId } = currentMeetingInfo;

    try {
        // Stop recording via SDK - try with windowId parameter
        await RecallAiSdk.stopRecording({ windowId });
        logger.info("[recall] recording stopped with windowId:", windowId);
        setCaptureState({ recording: false, paused: false });
    } catch (error) {
        // If stopRecording with windowId fails, the recording might already be stopped
        // Check error message to see if it's because recording doesn't exist
        if (error.message && error.message.includes("Cannot destructure")) {
            logger.warn(
                "[recall] recording may have already ended, marking as stopped",
            );
            setCaptureState({ recording: false, paused: false });
            return;
        }

        logger.error("[recall] error stopping recording:", error);
        // Even if stopping fails, mark as not recording
        setCaptureState({ recording: false, paused: false });
        throw error;
    }
}

async function setupMeetingPopupIpc() {
    ipcMain.handle("meeting-popup:confirm-recording", async () => {
        if (!currentMeetingInfo) {
            throw new Error("No meeting information available");
        }

        logger.info("[meeting-popup] user confirmed recording");
        userWantsToRecord = true;

        // Close the popup immediately after the user confirms.
        closeMeetingPopup();

        try {
            await startMeetingRecordingWithAuth({ source: "popup" });
        } catch (error) {
            logger.error("[meeting-popup] failed to start recording:", error);
            // Reset state so we don't get stuck in a "confirmed" flow on failure.
            userWantsToRecord = false;
            recordingStarted = false;
            currentMeetingInfo = null;
            refreshTrayMenu();
            throw error;
        }
    });

    ipcMain.handle("meeting-popup:decline-recording", async () => {
        logger.info("[meeting-popup] user declined recording");
        const windowId = currentMeetingInfo?.windowId;
        suppressMeetingPopupForWindow(windowId, "popup-decline");
        userWantsToRecord = false;
        recordingStarted = false;
        closeMeetingPopup();
        refreshTrayMenu();
    });

    ipcMain.handle("meeting-popup:minimize", async () => {
        if (meetingPopupWindow && !meetingPopupWindow.isDestroyed()) {
            meetingPopupWindow.minimize();
        }
    });

    ipcMain.handle("meeting-popup:end-recording", async () => {
        if (!isRecording) {
            logger.info("[meeting-popup] not recording, nothing to end");
            return;
        }

        const windowId = currentMeetingInfo?.windowId;
        suppressMeetingPopupForWindow(windowId, "popup-end-recording");
        try {
            await stopMeetingRecording();
            // Clear meeting info after stopping
            userWantsToRecord = false;
            recordingStarted = false;
            currentMeetingInfo = null;
            closeMeetingPopup();
        } catch (error) {
            logger.error("[meeting-popup] failed to end recording:", error);
            // Clear meeting info even on error to prevent stuck state
            userWantsToRecord = false;
            recordingStarted = false;
            currentMeetingInfo = null;
            closeMeetingPopup();
        }
    });
}

async function setupDebugControlsIpc() {
    ipcMain.handle("debug-controls:get-state", async () => {
        return {
            recording: isRecording,
            paused: isPaused,
            windowId: currentMeetingInfo?.windowId ?? null,
        };
    });

    ipcMain.handle("debug-controls:toggle-pause", async () => {
        if (!isRecording) return { ok: false, reason: "not_recording" };
        try {
            if (isPaused) {
                await resumeMeetingRecording();
            } else {
                await pauseMeetingRecording();
            }
            return { ok: true };
        } finally {
            sendDebugControlsState();
        }
    });

    ipcMain.handle("debug-controls:stop", async () => {
        if (!isRecording) return { ok: false, reason: "not_recording" };

        const windowId = currentMeetingInfo?.windowId;
        suppressMeetingPopupForWindow(windowId, "debug-controls-stop");
        try {
            await stopMeetingRecording();
            return { ok: true };
        } finally {
            // Clear meeting state after the stop attempt to avoid stuck UI/state.
            userWantsToRecord = false;
            recordingStarted = false;
            currentMeetingInfo = null;
            closeMeetingPopup();
            setCaptureState({ recording: false, paused: false });
            closeDebugControlsWindow();
        }
    });

    ipcMain.handle("debug-controls:open-logs", async () => {
        try {
            const logsDir = app.getPath("logs");
            const target =
                logFilePath && fs.existsSync(logFilePath)
                    ? logFilePath
                    : logsDir;
            await shell.openPath(target);
            return { ok: true };
        } catch (e) {
            logger.error("[debug-controls] failed to open logs:", e);
            return { ok: false };
        }
    });
}

async function setupAuthIpc() {
    ipcMain.handle("auth:isAuthenticated", async () => {
        const auth = await isAuthenticated();
        api.setAuthToken(auth.accessToken);
        await syncUserIdFromProfile();
        sendDesktopSdkDiagnosticsIfNeeded();
        return auth;
    });

    ipcMain.handle("auth:getAccessToken", async () => {
        const accessToken = await ensureAccessToken({ interactive: false });
        return { accessToken };
    });

    ipcMain.handle("auth:login", async (_evt, opts = {}) => {
        // opts can include { prompt: "login" | "none" }
        const accessToken = await ensureAccessToken({
            interactive: true,
            loginOpts: opts,
        });

        const stored = await getStoredAccessToken({ allowRefresh: true });
        await syncUserIdFromProfile();
        return { accessToken, tokens: stored, ok: !!accessToken };
    });

    ipcMain.handle("auth:logout", async () => {
        await logout();
        api.setAuthToken(null);
        await syncUserIdFromProfile();
        return { ok: true };
    });
}

async function bootstrap() {
    await app.whenReady();
    registerDeepLinkProtocol();
    setupAppLoggingIpc();

    // Prevent app from quitting when all windows are closed (menu bar app)
    app.on("window-all-closed", (e) => {
        e.preventDefault();
    });

    if (START_ON_LOGIN) {
        try {
            app.setLoginItemSettings({
                openAtLogin: true,
                openAsHidden: true,
            });
        } catch (e) {
            logger.warn("[app] failed to set login item:", e);
        }
    }

    setupFileLogging();
    logger.info("[app] starting Gia");
    logger.info("[app] logs folder:", app.getPath("logs"));

    // macOS: run as a menu bar app (no dock icon).
    if (process.platform === "darwin") {
        try {
            app.setActivationPolicy?.("accessory");
        } catch {
            // ignore
        }
        try {
            app.dock?.hide();
        } catch {
            // ignore
        }
    }

    app.setName("Gia");
    createTray();

    // Check if onboarding is complete BEFORE initializing the SDK
    // The SDK init can trigger permission prompts, so we delay it during onboarding
    const onboardingAlreadyComplete = isOnboardingComplete();

    logger.info(
        "[app] onboarding already complete:",
        onboardingAlreadyComplete,
    );

    if (onboardingAlreadyComplete) {
        // Initialize SDK and register event listeners
        logger.info("[app] onboarding complete, initializing SDK");
        RecallAiSdk.init({
            // NOTE: Recall SDK expects `apiUrl` (camelCase)
            apiUrl: "https://us-east-1.recall.ai",
        });
        sdkInitialized = true;

        // Capture initial Accessibility state once so we only relaunch on a real grant transition.
        captureAccessibilityTrustedAtStartupOnce();

        setupPermissionLogging({
            onChange: ({ prev, next, reason }) => {
                // Keep existing relaunch behavior and also update diagnostics.
                maybeRelaunchAfterAccessibilityGranted({ prev, next, reason });
                sendDesktopSdkDiagnosticsIfNeeded();
            },
        });

        // Request permissions
        logger.info("[permissions] requesting permissions");
        RecallAiSdk.requestPermission("accessibility");
        RecallAiSdk.requestPermission("microphone");
        RecallAiSdk.requestPermission("screen-capture");
        logger.info(`[recall] Registering event listeners`);

        RecallAiSdk.addEventListener("meeting-detected", async (evt) => {
            const windowId = evt.window.id;
            const meetingPlatform = evt.window?.platform;
            logger.info("[recall] meeting-detected event:", evt.window);
            logger.info("[recall] window id:", windowId);

            // Don't show popup if this meeting was already stopped/declined by the user
            if (suppressedMeetingWindowIds.has(windowId)) {
                logger.info(
                    "[recall] meeting-detected ignored (user already stopped/declined this meeting)",
                );
                return;
            }

            if (meetingPlatform === "slack") {
                logger.info(
                    "[recall] slack meeting detected, skipping popup and recording",
                );
                return;
            }

            // Don't show popup if we're already recording
            if (isRecording) {
                logger.info(
                    "[recall] already recording, ignoring new meeting detection",
                );
                return;
            }

            // Reset flags for new meeting
            userWantsToRecord = false;
            recordingStarted = false;

            try {
                logger.info(
                    "[recall] meeting detected: initializing meeting state",
                );
                // Store meeting info. Important: do NOT call the API here.
                // We only authenticate + fetch upload token after the user confirms.
                currentMeetingInfo = {
                    windowId: windowId,
                    meetingUrl: null,
                    uploadToken: null,
                    recordingId: null,
                    sdkUploadId: null,
                    lastRegisteredMeetingUrl: null,
                    lastRegisterAttemptUrl: null,
                    lastRegisterAttemptAt: 0,
                };

                // Show popup to ask if user wants to record
                logger.info("[recall] showing meeting popup...");
                showMeetingPopup();
                refreshTrayMenu();
            } catch (e) {
                logger.error("[recall] meeting detection failed:", e);
                currentMeetingInfo = null;
                refreshTrayMenu();
            }
        });

        RecallAiSdk.addEventListener("permission-status", (evt) => {
            const { permission, status } = evt;
            logger.info(
                `[recall] permission-status event: ${permission}, ${status}`,
            );

            // Track latest permission statuses for diagnostics.
            try {
                if (typeof permission === "string") {
                    recallPermissionStatuses = {
                        ...(recallPermissionStatuses || {}),
                        [permission]: status,
                    };
                    recallPermissionStatusesUpdatedAt =
                        new Date().toISOString();
                    sendDesktopSdkDiagnosticsIfNeeded();
                }
            } catch (e) {
                logger.warn("[recall] failed to store permission-status", e);
            }

            // Notify onboarding popup if it's open
            if (onboardingWindow && !onboardingWindow.isDestroyed()) {
                const permissionMap = {
                    microphone: "microphone",
                    accessibility: "accessibility",
                    "screen-capture": "screen",
                };
                const mappedPermission = permissionMap[permission];
                if (mappedPermission && status === "granted") {
                    onboardingWindow.webContents.send(
                        "onboarding:permission-status",
                        {
                            permission: mappedPermission,
                            granted: true,
                        },
                    );
                    if (mappedPermission === "microphone") {
                        bringOnboardingToFront("microphone-granted:global");
                    }
                }
            }

            // Prefer the SDK event: once Accessibility becomes granted, relaunch to ensure
            // downstream frameworks pick up the new TCC permission.
            // But only if onboarding is complete (we handle restart ourselves during onboarding)
            if (
                process.platform === "darwin" &&
                permission === "accessibility" &&
                status === "granted" &&
                isOnboardingComplete()
            ) {
                captureAccessibilityTrustedAtStartupOnce();
                if (accessibilityTrustedAtStartup === false) {
                    relaunchApp({ reason: "recall-permission-status" });
                }
            }
        });

        RecallAiSdk.addEventListener("meeting-updated", async (evt) => {
            const meetingUrl = evt.window?.url ?? null;
            const windowId = evt.window?.id ?? null;
            logger.info("[recall] meeting-updated event:", evt.window);
            logger.info("[recall] meeting-updated URL:", meetingUrl);

            if (!meetingUrl) return;

            // Only register URLs for the meeting we're currently tracking.
            if (
                !currentMeetingInfo ||
                !windowId ||
                currentMeetingInfo.windowId !== windowId
            ) {
                logger.info(
                    "[recall] meeting-updated ignored (no current meeting or window mismatch)",
                );
                return;
            }

            // Always keep the latest meeting URL, but only call the API after user confirms.
            currentMeetingInfo.meetingUrl = meetingUrl;
            logger.info(
                "[recall] stored meeting URL (confirmed=%s)",
                userWantsToRecord,
            );

            if (!userWantsToRecord) {
                logger.info(
                    "[recall] deferring meeting URL registration until confirm",
                );
                return;
            }

            await registerCurrentMeetingUrlIfNeeded();
        });

        RecallAiSdk.addEventListener("sdk-state-change", async (evt) => {
            logger.info("[recall] sdk-state-change event:", evt.sdk.state.code);
            switch (evt.sdk.state.code) {
                case "recording":
                    logger.info("[recall] SDK is recording");
                    if (!isRecording || isPaused) {
                        setCaptureState({ recording: true, paused: false });
                    }
                    break;
                case "idle":
                    logger.info("[recall] SDK is idle");
                    // The SDK doesn't currently expose a distinct "paused" state/event in all versions.
                    // If we initiated a pause, we treat idle as "paused" to avoid resetting meeting state.
                    if (isPaused) {
                        setCaptureState({ recording: true, paused: true });
                        break;
                    }

                    setCaptureState({ recording: false, paused: false });
                    // Close popup when meeting ends (goes to idle)
                    if (
                        meetingPopupWindow &&
                        !meetingPopupWindow.isDestroyed()
                    ) {
                        logger.info("[recall] closing popup due to idle state");
                        meetingPopupWindow.webContents.send(
                            "meeting-popup:recording-ended",
                        );
                        setTimeout(() => {
                            closeMeetingPopup();
                        }, 100);
                    }
                    // Clear suppression for this meeting since it truly ended
                    clearMeetingPopupSuppression(currentMeetingInfo?.windowId);
                    // Reset all meeting state
                    userWantsToRecord = false;
                    recordingStarted = false;
                    currentMeetingInfo = null;
                    refreshTrayMenu();
                    break;
                default:
                    logger.info("[recall] SDK state:", evt.sdk.state.code);
            }
        });

        RecallAiSdk.addEventListener("recording-ended", async (evt) => {
            logger.info("[recall] recording-ended event received");
            logger.info("[recall] Uploaded", evt.window);
            setCaptureState({ recording: false, paused: false });
            // Close popup when recording ends
            if (meetingPopupWindow && !meetingPopupWindow.isDestroyed()) {
                logger.info("[recall] closing popup due to recording-ended");
                meetingPopupWindow.webContents.send(
                    "meeting-popup:recording-ended",
                );
                setTimeout(() => {
                    closeMeetingPopup();
                }, 100);
            }
            // Clear suppression for this meeting since it truly ended
            const endedWindowId =
                evt.window?.id || currentMeetingInfo?.windowId;
            clearMeetingPopupSuppression(endedWindowId);
            // Reset all meeting state
            userWantsToRecord = false;
            recordingStarted = false;
            currentMeetingInfo = null;
            refreshTrayMenu();
        });
    } else {
        logger.info("[app] onboarding not complete, SDK not initialized yet");
    }

    // Setup IPC handlers for meeting popup and other features
    await setupMeetingPopupIpc();
    await setupAuthIpc();
    await setupDebugControlsIpc();
    await setupOnboardingIpc();

    // Check onboarding state
    const onboardingComplete = isOnboardingComplete();
    const showReady = shouldShowReadyScreen();

    logger.info(
        "[onboarding] complete:",
        onboardingComplete,
        "showReady:",
        showReady,
    );

    // If onboarding is complete and we need to show the ready screen (just restarted after permissions)
    if (onboardingComplete && showReady) {
        logger.info("[onboarding] showing ready screen after restart");
        showOnboardingPopup({ view: "ready" });

        // Still sync auth state
        const auth = await isAuthenticated();
        api.setAuthToken(auth.accessToken);
        await syncUserIdFromProfile();
        sendDesktopSdkDiagnosticsIfNeeded();
        return;
    }

    // If onboarding is complete, just do normal auth flow
    if (onboardingComplete) {
        const auth = await isAuthenticated();
        logger.info("[auth] authenticated:", auth.authenticated);
        api.setAuthToken(auth.accessToken);
        await syncUserIdFromProfile();
        sendDesktopSdkDiagnosticsIfNeeded();

        // If somehow not authenticated after onboarding, show login
        if (!auth.authenticated) {
            try {
                logger.info("[auth] starting interactive login...");
                await ensureAccessToken({ interactive: true });
                logger.info("[auth] login complete");
            } catch (e) {
                logger.warn(
                    "[auth] login failed (continuing without auth):",
                    e,
                );
            }
        }
        return;
    }

    // Onboarding not complete - show onboarding popup
    logger.info("[onboarding] starting onboarding flow");

    // Check if already authenticated (returning user who hasn't completed new onboarding)
    const auth = await isAuthenticated();
    if (auth.authenticated) {
        // User is authenticated, go straight to permissions
        logger.info(
            "[onboarding] user already authenticated, showing permissions",
        );
        api.setAuthToken(auth.accessToken);
        await syncUserIdFromProfile();
        sendDesktopSdkDiagnosticsIfNeeded();
        showOnboardingPopup({ view: "permissions" });
    } else {
        // Show login screen
        showOnboardingPopup({ view: "login" });
    }
}

bootstrap().catch((err) => {
    logger.error("Fatal bootstrap error:", err);
});
