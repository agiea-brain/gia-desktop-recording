import * as dotenv from "dotenv";
dotenv.config();

const API_URL = process.env.API_URL || "http://localhost:8080";

const apiRoutes = {
    getUploadToken: "/api/content/recall/upload-token/",
    registerMeetingUrl: "/api/content/recall/register-meeting-url/",
};

class Api {
    constructor() {
        this.apiUrl = API_URL;
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
}

export default Api;
