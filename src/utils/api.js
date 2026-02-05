import { loadEnv } from "./load-env";
import logger from "./logger";

// Ensure env is loaded even when cwd isn't repo root.
loadEnv();

const apiRoutes = {
    getUploadToken: "/api/content/recall/upload-token/",
    registerMeetingUrl: "/api/content/recall/register-meeting-url/",
    getUserProfile: "/api/users/profile",
    updateDesktopSdkDiagnostics: "/api/users/desktop-sdk-diagnostics",
};

class Api {
    constructor() {
        this.apiUrl = "https://api.myagiea.com";
        this.authToken = null;
    }

    setAuthToken(authToken) {
        this.authToken = authToken;
    }

    async getUploadToken() {
        if (!this.authToken) {
            throw new Error("Missing auth token (call setAuthToken first)");
        }
        const response = await fetch(
            `${this.apiUrl}${apiRoutes.getUploadToken}`,
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Accept: "application/json",
                    Authorization: `Bearer ${this.authToken}`,
                },
            },
        );
        if (!response.ok) {
            const body = await response.text().catch(() => "");
            const err = new Error(
                `Failed to get upload token (${response.status}): ${body}`,
            );
            // Attach structured metadata for better error handling upstream.
            err.status = response.status;
            err.body = body;
            throw err;
        }
        const data = (await response.json()) || {};
        // Return the full data object so we can check for both uploadToken and upload_token
        return data;
    }

    async registerMeetingUrl({ meetingUrl, recordingId, sdkUploadId }) {
        if (!meetingUrl || !recordingId || !sdkUploadId) {
            logger.info(
                `[recall] registerMeetingUrl: Missing meeting URL, recording ID, or SDK upload ID: ${meetingUrl}, ${recordingId}, ${sdkUploadId}`,
            );
            return;
        }
        if (!this.authToken) {
            throw new Error("Missing auth token (call setAuthToken first)");
        }
        const response = await fetch(
            `${this.apiUrl}${apiRoutes.registerMeetingUrl}`,
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Accept: "application/json",
                    Authorization: `Bearer ${this.authToken}`,
                },
                body: JSON.stringify({ meetingUrl, recordingId, sdkUploadId }),
            },
        );

        if (!response.ok) {
            const body = await response.text().catch(() => "");
            throw new Error(
                `Failed to register meeting URL (${response.status}): ${body}`,
            );
        }
        const data = (await response.json()) || {};
        return data;
    }

    async getUserProfile() {
        if (!this.authToken) {
            throw new Error("Missing auth token (call setAuthToken first)");
        }

        const response = await fetch(
            `${this.apiUrl}${apiRoutes.getUserProfile}`,
            {
                method: "GET",
                headers: {
                    Accept: "application/json",
                    Authorization: `Bearer ${this.authToken}`,
                },
            },
        );

        if (!response.ok) {
            const body = await response.text().catch(() => "");
            const err = new Error(
                `Failed to get user profile (${response.status}): ${body}`,
            );
            err.status = response.status;
            err.body = body;
            throw err;
        }

        const data = (await response.json()) || {};
        return data;
    }

    async updateDesktopSdkDiagnostics({
        timestamp,
        platform,
        version,
        permissions,
    }) {
        if (!this.authToken) {
            throw new Error("Missing auth token (call setAuthToken first)");
        }

        const response = await fetch(
            `${this.apiUrl}${apiRoutes.updateDesktopSdkDiagnostics}`,
            {
                method: "PUT",
                headers: {
                    "Content-Type": "application/json",
                    Accept: "application/json",
                    Authorization: `Bearer ${this.authToken}`,
                },
                body: JSON.stringify({
                    timestamp,
                    platform,
                    version,
                    permissions,
                }),
            },
        );

        if (!response.ok) {
            const body = await response.text().catch(() => "");
            const err = new Error(
                `Failed to update desktop sdk diagnostics (${response.status}): ${body}`,
            );
            err.status = response.status;
            err.body = body;
            throw err;
        }

        const data = (await response.json().catch(() => null)) || {};
        return data;
    }
}

export default Api;
