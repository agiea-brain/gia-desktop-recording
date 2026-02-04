const express = require("express");
const axios = require("axios");
const util = require("util");
const app = express();

require("dotenv").config();

// Best-effort remote logging (no SDK tokens needed).
const LOGGING_API_URL =
    "https://r0ng0htend.execute-api.us-east-2.amazonaws.com/stage/desktop-sdk-logger";
const TRACE_FLAGS = "01";
let currentTraceparent = null;
let traceStartInFlight = null;
let bufferedRemotePayloads = [];
const MAX_BUFFERED_REMOTE_PAYLOADS = 100;

function toApiLevel(level) {
    if (level === "error") return "error";
    if (level === "warn" || level === "warning") return "warning";
    return "info";
}

function isHex(str, len) {
    return (
        typeof str === "string" &&
        str.length === len &&
        /^[0-9a-f]+$/i.test(str)
    );
}

function buildTraceparent(traceId, spanId, flags) {
    if (!isHex(traceId, 32)) return null;
    if (!isHex(spanId, 16)) return null;
    const fl =
        typeof flags === "string" && /^[0-9a-f]{2}$/i.test(flags)
            ? flags
            : "01";
    return `00-${traceId.toLowerCase()}-${spanId.toLowerCase()}-${fl.toLowerCase()}`;
}

function postToLoggingApi(level, message, properties = {}) {
    if (!LOGGING_API_URL) return;
    try {
        if (!currentTraceparent && traceStartInFlight) {
            if (bufferedRemotePayloads.length < MAX_BUFFERED_REMOTE_PAYLOADS) {
                bufferedRemotePayloads.push({ level, message, properties });
            }
            return;
        }

        const shouldStartTraceNow = !currentTraceparent;
        const payload = shouldStartTraceNow
            ? {
                  message,
                  level: toApiLevel(level),
                  trace: true,
                  properties,
              }
            : {
                  message,
                  level: toApiLevel(level),
                  properties,
              };

        const headers = { "content-type": "application/json" };
        if (!shouldStartTraceNow && currentTraceparent) {
            headers.traceparent = currentTraceparent;
        }

        const req = axios.post(LOGGING_API_URL, payload, {
            timeout: 2500,
            headers,
        });

        if (shouldStartTraceNow) {
            traceStartInFlight = Promise.resolve(req)
                .then((res) => {
                    const data = res?.data || null;
                    const traceId =
                        typeof data?.trace_id === "string" ? data.trace_id : null;
                    const spanId =
                        typeof data?.span_id === "string" ? data.span_id : null;
                    const tp = buildTraceparent(traceId, spanId, TRACE_FLAGS);
                    if (tp) currentTraceparent = tp;
                })
                .catch(() => {})
                .finally(() => {
                    const tp = currentTraceparent;
                    const toFlush = bufferedRemotePayloads;
                    bufferedRemotePayloads = [];
                    traceStartInFlight = null;
                    for (const item of toFlush) {
                        axios
                            .post(
                                LOGGING_API_URL,
                                {
                                    message: item.message,
                                    level: toApiLevel(item.level),
                                    properties: item.properties,
                                },
                                {
                                    timeout: 2500,
                                    headers: tp
                                        ? {
                                              "content-type": "application/json",
                                              traceparent: tp,
                                          }
                                        : { "content-type": "application/json" },
                                },
                            )
                            .catch(() => {});
                    }
                });
        }

        req
            .catch(() => {
                // ignore
            });
    } catch {
        // ignore
    }
}

function log(level, ...args) {
    const msg = util.format(...args);
    postToLoggingApi(level, msg, {
        process: "server",
        service: "gia-server",
        userId: null,
        user_id: null,
    });

    // Fallback to stdout/stderr without using console.
    const stream = level === "error" ? process.stderr : process.stdout;
    try {
        stream.write(msg + "\n");
    } catch {
        // ignore
    }
}

// API configuration for Recall.ai
const RECALLAI_API_URL =
    process.env.RECALLAI_API_URL || "https://api.recall.ai";
const RECALLAI_API_KEY = process.env.RECALLAI_API_KEY;

app.get("/start-recording", async (req, res) => {
    log(
        "info",
        `Creating upload token with API key: ${RECALLAI_API_KEY.slice(0, 4)}...`,
    );

    if (!RECALLAI_API_KEY) {
        log("error", "RECALLAI_API_KEY is missing! Set it in .env file");
        return res.json({
            status: "error",
            message: "RECALLAI_API_KEY is missing",
        });
    }

    const url = `${RECALLAI_API_URL}/api/v1/sdk_upload/`;

    try {
        const response = await axios.post(
            url,
            {
                recording_config: {
                    transcript: {
                        provider: {
                            assembly_ai_v3_streaming: {},
                        },
                    },
                    realtime_endpoints: [
                        {
                            type: "desktop_sdk_callback",
                            events: [
                                "participant_events.join",
                                "video_separate_png.data",
                                "transcript.data",
                                "transcript.provider_data",
                            ],
                        },
                    ],
                },
            },
            {
                headers: { Authorization: `Token ${RECALLAI_API_KEY}` },
                timeout: 9000,
            },
        );

        res.json({
            status: "success",
            upload_token: response.data.upload_token,
        });
    } catch (e) {
        log(
            "error",
            "Error creating upload token:",
            JSON.stringify(e.errors || e.response?.data || e.message),
        );
        res.json({ status: "error", message: e.message });
    }
});

if (require.main === module) {
    app.listen(13373, () => {
        log("info", `Server listening on http://localhost:13373`);
    });
}

module.exports = app;
