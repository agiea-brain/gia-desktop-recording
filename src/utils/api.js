const apiRoutes = {
    getUploadToken: "/api/content/recall/upload-token/",
};

class Api {
    constructor() {
        this.apiUrl = "http://localhost:8080";
        this.authToken = null;
    }

    setAuthToken(authToken) {
        this.authToken = authToken;
    }

    async getUploadToken(meetingUrl) {
        console.log("[recall] getting upload token for meeting URL:", meetingUrl);
        if (!this.authToken) {
            throw new Error("Missing auth token (call setAuthToken first)");
        }
        const response = await fetch(
            `${this.apiUrl}${apiRoutes.getUploadToken}`,
            {
                method: "POST",
                body: JSON.stringify({ meetingUrl }),
                headers: {
                    "Content-Type": "application/json",
                    "Accept": "application/json",
                    Authorization: `Bearer ${this.authToken}`,
                },
            }
        );
        if (!response.ok) {
            const body = await response.text().catch(() => "");
            throw new Error(
                `Failed to get upload token (${response.status}): ${body}`
            );
        }
        const data = (await response.json()) || {};
        // Return the full data object so we can check for both uploadToken and upload_token
        return data;
    }
}

export default Api;
