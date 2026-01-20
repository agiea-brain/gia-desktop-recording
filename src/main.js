import RecallAiSdk from "@recallai/desktop-sdk";
import {
    app,
    BrowserWindow,
    ipcMain,
    Menu,
    nativeImage,
    shell,
    Tray,
} from "electron";
import * as fs from "fs";
import * as path from "path";
import * as util from "util";
import {
    isAuthenticated,
    login,
    logout,
    getStoredAccessToken,
} from "./utils/auth";
import Api from "./utils/api";

const api = new Api();

// Toggle developer-only tray items.
// Set to true locally when you want quick access to logs.
const DEBUG = true;

let loginInFlight = null;
let userProfileInFlight = null;
let cachedUserProfile = null;

let tray = null;
let isRecording = false;
let isPaused = false;

let logFilePath = null;
let meetingPopupWindow = null;
let currentMeetingInfo = null; // { windowId, uploadToken, url }
let userWantsToRecord = false; // Set to true when user confirms they want to record
let recordingStarted = false; // Ensures recording only starts once per meeting

function setupFileLogging() {
    try {
        const logsDir = app.getPath("logs");
        logFilePath = path.join(logsDir, "gia.log");
        fs.mkdirSync(path.dirname(logFilePath), { recursive: true });

        const wrap = (method) => {
            const original = console[method].bind(console);
            console[method] = (...args) => {
                original(...args);
                try {
                    if (logFilePath) {
                        fs.appendFileSync(
                            logFilePath,
                            util.format(...args) + "\n",
                            "utf8"
                        );
                    }
                } catch {
                    // ignore log write failures
                }
            };
        };

        wrap("log");
        wrap("warn");
        wrap("error");
    } catch {
        // ignore
    }
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

function buildTrayMenu() {
    const status = !isRecording ? "Idle" : isPaused ? "Paused" : "Recording";
    const template = [
        {
            label: `Status: ${status}`,
            enabled: false,
        },
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
                    console.error("[tray] failed to toggle pause:", e);
                }
            },
        },
        {
            label: "Stop Recording",
            enabled: isRecording,
            click: async () => {
                try {
                    await stopMeetingRecording();
                } catch (e) {
                    console.error("[tray] failed to stop recording:", e);
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
                              console.error("[tray] failed to open logs:", e);
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
        tray.setContextMenu(buildTrayMenu());
    }
}

async function pauseMeetingRecording() {
    if (!isRecording) {
        console.log("[recall] not recording, nothing to pause");
        return;
    }
    if (isPaused) {
        console.log("[recall] already paused");
        return;
    }
    if (!currentMeetingInfo?.windowId) {
        throw new Error("Cannot pause recording: missing windowId");
    }
    const { windowId } = currentMeetingInfo;
    await RecallAiSdk.pauseRecording({ windowId });
    console.log("[recall] recording paused for windowId:", windowId);
    setCaptureState({ recording: true, paused: true });
}

async function resumeMeetingRecording() {
    if (!isRecording) {
        console.log("[recall] not recording, nothing to resume");
        return;
    }
    if (!isPaused) {
        console.log("[recall] not paused");
        return;
    }
    if (!currentMeetingInfo?.windowId) {
        throw new Error("Cannot resume recording: missing windowId");
    }
    const { windowId } = currentMeetingInfo;
    await RecallAiSdk.resumeRecording({ windowId });
    console.log("[recall] recording resumed for windowId:", windowId);
    setCaptureState({ recording: true, paused: false });
}

async function ensureAccessToken({ interactive = false, loginOpts = {} } = {}) {
    // First try: stored/refreshable token (no UI)
    const stored = await getStoredAccessToken({ allowRefresh: true });
    if (stored?.access_token) {
        api.setAuthToken(stored.access_token);
        return stored.access_token;
    }

    // No token available and we're not allowed to open UI
    if (!interactive) {
        api.setAuthToken(null);
        return null;
    }

    // Prevent multiple auth popups at once
    if (!loginInFlight) {
        loginInFlight = (async () => {
            await login(loginOpts);
            const after = await getStoredAccessToken({ allowRefresh: true });
            api.setAuthToken(after?.access_token || null);
            return after?.access_token || null;
        })().finally(() => {
            loginInFlight = null;
        });
    }

    return await loginInFlight;
}

function getMeetingPopupPath() {
    // In production, the file is copied to Resources via extraResource
    if (app.isPackaged) {
        const resourcePath = path.join(
            process.resourcesPath,
            "meeting-popup.html"
        );
        console.log("[popup] looking for popup at:", resourcePath);
        if (fs.existsSync(resourcePath)) {
            return resourcePath;
        }
        console.error("[popup] popup HTML not found at:", resourcePath);
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
                console.log("[popup] found popup at:", p);
                return p;
            }
        } catch {
            // ignore and try next candidate
        }
    }

    console.error("[popup] popup HTML not found in any candidate path");
    return candidates[0];
}

function showMeetingPopup() {
    // Close existing popup if any
    if (meetingPopupWindow && !meetingPopupWindow.isDestroyed()) {
        meetingPopupWindow.close();
    }

    const popupPath = getMeetingPopupPath();

    meetingPopupWindow = new BrowserWindow({
        width: 280,
        height: 180,
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

    // Center the window
    meetingPopupWindow.center();

    // Show when ready
    meetingPopupWindow.once("ready-to-show", () => {
        meetingPopupWindow?.show();
    });

    // Clean up on close
    meetingPopupWindow.on("closed", () => {
        meetingPopupWindow = null;
        // If recording hasn't started AND the user didn't confirm, clear meeting info.
        // We close the popup immediately on confirm now, but still need the meeting info
        // to start recording once the URL arrives.
        if (!isRecording && !userWantsToRecord) {
            userWantsToRecord = false;
            recordingStarted = false;
            currentMeetingInfo = null;
        }
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

async function getUploadTokenAndStartRecording({ windowId, meetingUrl }) {
    if (!currentMeetingInfo) {
        throw new Error("No meeting information available");
    }

    if (recordingStarted) {
        console.log("[recall] recording already started, skipping");
        return;
    }

    // Get upload token if we don't have it yet
    if (!currentMeetingInfo.uploadToken) {
        console.log("[recall] requesting upload token...");
        const uploadTokenData = await api.getUploadToken(meetingUrl);
        console.log("[recall] upload token data:", uploadTokenData);

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
            throw new Error(
                `Upload token not found in response: ${JSON.stringify(uploadTokenData)}`
            );
        }

        console.log("[recall] extracted upload token:", uploadToken);
        currentMeetingInfo.uploadToken = uploadToken;
    }

    // Now start the recording
    await startMeetingRecording();
}

async function startMeetingRecording() {
    if (!currentMeetingInfo) {
        throw new Error("No meeting information available");
    }

    if (recordingStarted) {
        console.log("[recall] recording already started, skipping");
        return;
    }

    const { windowId, uploadToken } = currentMeetingInfo;

    if (!uploadToken) {
        throw new Error("No upload token available");
    }

    console.log("[recall] starting recording with windowId:", windowId);
    console.log("[recall] starting recording with uploadToken:", uploadToken);

    // Mark as started BEFORE the async call to prevent race conditions
    recordingStarted = true;

    try {
        await RecallAiSdk.startRecording({
            windowId: windowId,
            uploadToken: uploadToken,
        });

        console.log("[recall] recording started successfully");
        setCaptureState({ recording: true, paused: false });

        // Notify popup that recording started
        if (meetingPopupWindow && !meetingPopupWindow.isDestroyed()) {
            meetingPopupWindow.webContents.send(
                "meeting-popup:recording-started"
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
        console.log("[recall] not recording, nothing to stop");
        return;
    }

    // Need windowId to stop recording - use currentMeetingInfo if available
    if (!currentMeetingInfo || !currentMeetingInfo.windowId) {
        console.warn(
            "[recall] cannot stop recording: no meeting info or windowId"
        );
        // Recording might have already ended, just mark as not recording
        setCaptureState({ recording: false, paused: false });
        return;
    }

    const { windowId } = currentMeetingInfo;

    try {
        // Stop recording via SDK - try with windowId parameter
        await RecallAiSdk.stopRecording({ windowId });
        console.log("[recall] recording stopped with windowId:", windowId);
        setCaptureState({ recording: false, paused: false });
    } catch (error) {
        // If stopRecording with windowId fails, the recording might already be stopped
        // Check error message to see if it's because recording doesn't exist
        if (error.message && error.message.includes("Cannot destructure")) {
            console.warn(
                "[recall] recording may have already ended, marking as stopped"
            );
            setCaptureState({ recording: false, paused: false });
            return;
        }

        console.error("[recall] error stopping recording:", error);
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

        console.log("[meeting-popup] user confirmed recording");
        userWantsToRecord = true;

        // Close the popup immediately after the user confirms.
        // Recording can still start later once we receive the meeting URL.
        closeMeetingPopup();

        // If we already have the URL (from meeting-updated), get token and start recording now
        if (currentMeetingInfo.url && !recordingStarted) {
            try {
                await getUploadTokenAndStartRecording({
                    windowId: currentMeetingInfo.windowId,
                    meetingUrl: currentMeetingInfo.url,
                });
            } catch (error) {
                console.error(
                    "[meeting-popup] failed to start recording:",
                    error
                );
                throw error;
            }
        } else {
            console.log(
                "[meeting-popup] waiting for meeting-updated event with URL..."
            );
            // Popup is closed; no UI update needed.
        }
    });

    ipcMain.handle("meeting-popup:decline-recording", async () => {
        console.log("[meeting-popup] user declined recording");
        userWantsToRecord = false;
        recordingStarted = false;
        currentMeetingInfo = null;
        closeMeetingPopup();
    });

    ipcMain.handle("meeting-popup:minimize", async () => {
        if (meetingPopupWindow && !meetingPopupWindow.isDestroyed()) {
            meetingPopupWindow.minimize();
        }
    });

    ipcMain.handle("meeting-popup:end-recording", async () => {
        if (!isRecording) {
            console.log("[meeting-popup] not recording, nothing to end");
            return;
        }

        try {
            await stopMeetingRecording();
            // Clear meeting info after stopping
            userWantsToRecord = false;
            recordingStarted = false;
            currentMeetingInfo = null;
            closeMeetingPopup();
        } catch (error) {
            console.error("[meeting-popup] failed to end recording:", error);
            // Clear meeting info even on error to prevent stuck state
            userWantsToRecord = false;
            recordingStarted = false;
            currentMeetingInfo = null;
            closeMeetingPopup();
        }
    });
}

async function setupAuthIpc() {
    ipcMain.handle("auth:isAuthenticated", async () => {
        const auth = await isAuthenticated();
        api.setAuthToken(auth.accessToken);
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
        return { accessToken, tokens: stored, ok: !!accessToken };
    });

    ipcMain.handle("auth:logout", async () => {
        await logout();
        api.setAuthToken(null);
        cachedUserProfile = null;
        return { ok: true };
    });
}

async function bootstrap() {
    await app.whenReady();

    // Prevent app from quitting when all windows are closed (menu bar app)
    app.on("window-all-closed", (e) => {
        e.preventDefault();
    });

    setupFileLogging();
    console.log("[app] starting Gia");
    console.log("[app] logs folder:", app.getPath("logs"));

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

    await setupAuthIpc();

    // Lightweight startup check (doesn't force an interactive login).
    const auth = await isAuthenticated();
    console.log("[auth] authenticated:", auth.authenticated);
    api.setAuthToken(auth.accessToken);

    // Default: don't pop an auth window on startup.
    // Set GIA_AUTH_AUTO_LOGIN=1 to force interactive login on startup.
    const shouldAutoLogin = process.env.GIA_AUTH_AUTO_LOGIN === "1";
    if (!auth.authenticated && shouldAutoLogin) {
        try {
            console.log("[auth] starting interactive login...");
            await ensureAccessToken({ interactive: true });
            console.log("[auth] login complete");
        } catch (e) {
            console.warn("[auth] login failed (continuing without auth):", e);
        }
    }

    RecallAiSdk.init({
        api_url: "https://us-east-1.recall.ai",
    });

    RecallAiSdk.addEventListener("meeting-detected", async (evt) => {
        const windowId = evt.window.id;
        const meetingUrl = evt.window.url;
        console.log("[recall] meeting-detected event:", evt.window);
        console.log("[recall] window id:", windowId);
        if (meetingUrl) {
            console.log("[recall] meeting-detected URL available:", meetingUrl);
        } else {
            console.log(
                "[recall] meeting-detected URL not available yet (will wait for meeting-updated)"
            );
        }

        // Don't show popup if we're already recording
        if (isRecording) {
            console.log(
                "[recall] already recording, ignoring new meeting detection"
            );
            return;
        }

        // Reset flags for new meeting
        userWantsToRecord = false;
        recordingStarted = false;

        try {
            console.log("[recall] checking authentication...");
            const accessToken = await ensureAccessToken({ interactive: true });
            console.log("[recall] access token obtained:", !!accessToken);
            if (!accessToken) {
                throw new Error("Not authenticated: no access token available");
            }

            // Store meeting info (without upload token yet - that comes in meeting-updated)
            currentMeetingInfo = {
                windowId: windowId,
                uploadToken: null,
                // If the SDK already provides a URL at detection time, we can start immediately
                // after the user confirms. Otherwise we'll wait for meeting-updated.
                url: meetingUrl || null,
            };

            // Show popup to ask if user wants to record
            console.log("[recall] showing meeting popup...");
            showMeetingPopup();
        } catch (e) {
            console.error("[recall] meeting detection failed:", e);
            currentMeetingInfo = null;
        }
    });

    RecallAiSdk.addEventListener("meeting-updated", async (evt) => {
        const windowId = evt.window.id;
        const meetingUrl = evt.window.url;
        console.log("[recall] meeting-updated event:", evt.window);
        console.log("[recall] window id:", windowId, "url:", meetingUrl);

        // If no current meeting info or different window, ignore
        if (!currentMeetingInfo || currentMeetingInfo.windowId !== windowId) {
            console.log(
                "[recall] meeting-updated for unknown/different meeting, ignoring"
            );
            return;
        }

        // Update URL in meeting info
        currentMeetingInfo.url = meetingUrl;

        // Only proceed if user has confirmed they want to record and we haven't started yet
        if (!userWantsToRecord) {
            console.log(
                "[recall] user hasn't confirmed recording yet, waiting..."
            );
            return;
        }

        if (recordingStarted) {
            console.log(
                "[recall] recording already started, ignoring meeting-updated"
            );
            return;
        }

        // Now we have the URL and user wants to record - get upload token and start
        try {
            await getUploadTokenAndStartRecording({
                windowId: windowId,
                meetingUrl: meetingUrl,
            });
        } catch (e) {
            console.error(
                "[recall] failed to start recording in meeting-updated:",
                e
            );
            // Notify popup of error
            if (meetingPopupWindow && !meetingPopupWindow.isDestroyed()) {
                meetingPopupWindow.webContents.send(
                    "meeting-popup:error",
                    e.message
                );
            }
        }
    });

    RecallAiSdk.addEventListener("sdk-state-change", async (evt) => {
        console.log("[recall] sdk-state-change event:", evt.sdk.state.code);
        switch (evt.sdk.state.code) {
            case "recording":
                console.log("[recall] SDK is recording");
                if (!isRecording || isPaused) {
                    setCaptureState({ recording: true, paused: false });
                }
                break;
            case "idle":
                console.log("[recall] SDK is idle");
                // The SDK doesn't currently expose a distinct "paused" state/event in all versions.
                // If we initiated a pause, we treat idle as "paused" to avoid resetting meeting state.
                if (isPaused) {
                    setCaptureState({ recording: true, paused: true });
                    break;
                }

                setCaptureState({ recording: false, paused: false });
                // Close popup when meeting ends (goes to idle)
                if (meetingPopupWindow && !meetingPopupWindow.isDestroyed()) {
                    console.log("[recall] closing popup due to idle state");
                    meetingPopupWindow.webContents.send(
                        "meeting-popup:recording-ended"
                    );
                    setTimeout(() => {
                        closeMeetingPopup();
                    }, 100);
                }
                // Reset all meeting state
                userWantsToRecord = false;
                recordingStarted = false;
                currentMeetingInfo = null;
                break;
            default:
                console.log("[recall] SDK state:", evt.sdk.state.code);
        }
    });

    RecallAiSdk.addEventListener("recording-ended", async (evt) => {
        console.log("[recall] recording-ended event received");
        console.log("[recall] Uploaded", evt.window);
        setCaptureState({ recording: false, paused: false });
        // Close popup when recording ends
        if (meetingPopupWindow && !meetingPopupWindow.isDestroyed()) {
            console.log("[recall] closing popup due to recording-ended");
            meetingPopupWindow.webContents.send(
                "meeting-popup:recording-ended"
            );
            setTimeout(() => {
                closeMeetingPopup();
            }, 100);
        }
        // Reset all meeting state
        userWantsToRecord = false;
        recordingStarted = false;
        currentMeetingInfo = null;
    });

    // Setup IPC handlers for meeting popup
    await setupMeetingPopupIpc();
}

bootstrap().catch((err) => {
    console.error("Fatal bootstrap error:", err);
});
