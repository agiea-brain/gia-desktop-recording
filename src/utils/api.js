const apiRoutes = {
    getUploadToken: "/api/content/recall/upload-token/",
    registerMeetingUrl: "/api/content/recall/register-meeting-url/",
};

const ENVIRONMENT = "development";

function getApiUrl() {
    if (ENVIRONMENT === "local") {
        return "http://localhost:8080";
    } else if (ENVIRONMENT === "production") {
        return "https://api.myagiea.com";
    } else {
        return "https://r0ng0htend.execute-api.us-east-2.amazonaws.com/stage";
    }
}

class Api {
    constructor() {
        this.apiUrl = getApiUrl();
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
            throw new Error(
                `Failed to get upload token (${response.status}): ${body}`,
            );
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
