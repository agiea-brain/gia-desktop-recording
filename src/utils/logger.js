import * as fs from "fs";
import * as path from "path";
import * as util from "util";

let logFilePath = null;
let baseContext = {};
let teeToConsole = true;
let loggingApiUrl = null;
let remoteLoggingConfigured = false;
let traceEnabled = true;
let traceFlags = "01";
let currentTrace = {
    traceId: null,
    spanId: null,
    traceparent: null,
};
let traceStartInFlight = null;
let bufferedRemotePayloads = [];
const MAX_BUFFERED_REMOTE_PAYLOADS = 100;

function normalizeUserId(ctx) {
    if (!ctx || typeof ctx !== "object") return null;
    if (typeof ctx.userId === "string" && ctx.userId.length) return ctx.userId;
    if (typeof ctx.user_id === "string" && ctx.user_id.length) return ctx.user_id;
    if (typeof ctx.uid === "string" && ctx.uid.length) return ctx.uid;
    return null;
}

function safeJson(value) {
    try {
        return JSON.stringify(value);
    } catch {
        return "[unserializable]";
    }
}

function formatArgs(args) {
    try {
        return util.format(...args);
    } catch {
        return args
            .map((a) => (typeof a === "string" ? a : safeJson(a)))
            .join(" ");
    }
}

function appendToFile(line) {
    if (!logFilePath) return;
    try {
        fs.mkdirSync(path.dirname(logFilePath), { recursive: true });
        fs.appendFileSync(logFilePath, line + "\n", "utf8");
    } catch {
        // ignore local file logging failures
    }
}

function toApiLevel(level) {
    if (level === "error") return "error";
    if (level === "warn") return "warning";
    return "info"; // debug/info fall back to info
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
    const fl = typeof flags === "string" && /^[0-9a-f]{2}$/i.test(flags) ? flags : "01";
    return `00-${traceId.toLowerCase()}-${spanId.toLowerCase()}-${fl.toLowerCase()}`;
}

function setCurrentTraceFromResponse(data) {
    try {
        if (!data || typeof data !== "object") return;
        // Prefer explicit traceparent if provided by API in the future.
        if (typeof data.traceparent === "string" && data.traceparent.length) {
            currentTrace = { traceId: null, spanId: null, traceparent: data.traceparent };
            return;
        }
        const traceId = typeof data.trace_id === "string" ? data.trace_id : null;
        const spanId = typeof data.span_id === "string" ? data.span_id : null;
        const tp = buildTraceparent(traceId, spanId, traceFlags);
        if (!tp) return;
        currentTrace = { traceId, spanId, traceparent: tp };
    } catch {
        // ignore
    }
}

function postToLoggingApi(
    payload,
    { traceparentOverride = null, startTrace = false } = {},
) {
    if (!remoteLoggingConfigured || !loggingApiUrl) return;
    try {
        const fetchFn = globalThis.fetch;
        if (typeof fetchFn !== "function") return;

        const controller =
            typeof AbortController === "function"
                ? new AbortController()
                : null;
        const timeout = controller
            ? setTimeout(() => controller.abort(), 2500)
            : null;

        const traceparentToSend =
            typeof traceparentOverride === "string" && traceparentOverride.length
                ? traceparentOverride
                : null;

        const headers = { "content-type": "application/json" };
        if (!startTrace && traceparentToSend) {
            headers.traceparent = traceparentToSend;
        }

        const bodyPayload = startTrace ? { ...(payload || {}), trace: true } : payload;

        // Fire-and-forget. Never let remote logging crash the app.
        const p = Promise.resolve(
            fetchFn(loggingApiUrl, {
                method: "POST",
                headers,
                body: JSON.stringify(bodyPayload),
                signal: controller?.signal,
            }),
        )
            .catch(() => {})
            .finally(() => {
                if (timeout) clearTimeout(timeout);
            });
        return p;
    } catch {
        // ignore
    }
}

function emit(level, args, context) {
    const msg = formatArgs(args);
    const mergedContext = { ...baseContext, ...(context || {}) };
    // Ensure userId is present on every log (null if unknown).
    const userId = normalizeUserId(mergedContext);
    mergedContext.userId = userId;
    mergedContext.user_id = userId;

    // Allow per-log override: `traceparent` / `traceParent` in context.
    const traceparentOverrideRaw =
        mergedContext.traceparent || mergedContext.traceParent || null;
    const traceparentOverride =
        typeof traceparentOverrideRaw === "string" && traceparentOverrideRaw.length
            ? traceparentOverrideRaw
            : null;
    // Don't include trace plumbing in properties by default.
    delete mergedContext.traceparent;
    delete mergedContext.traceParent;

    if (teeToConsole) {
        try {
            const fn =
                (typeof console?.[level] === "function" && console[level]) ||
                (typeof console?.log === "function" && console.log);
            if (fn) {
                const ts = `[${new Date().toISOString()}]`;
                if (Object.keys(mergedContext).length)
                    fn(ts, ...args, mergedContext);
                else fn(ts, ...args);
            }
        } catch {
            // ignore console logging failures
        }
    }

    appendToFile(
        `[${new Date().toISOString()}] [${level}] ${msg}${
            Object.keys(mergedContext).length
                ? ` ${safeJson(mergedContext)}`
                : ""
        }`,
    );

    const remotePayload = {
        message: msg,
        level: toApiLevel(level),
        properties: {
            ...mergedContext,
            userId,
            user_id: userId,
            originalLevel: level,
        },
    };

    // If caller explicitly supplies a traceparent, always use it immediately.
    if (traceparentOverride) {
        postToLoggingApi(remotePayload, { traceparentOverride });
        return;
    }

    // If a trace is being created, buffer logs so we don't accidentally start multiple traces
    // during app startup / bursts of logging.
    if (traceEnabled && !currentTrace?.traceparent) {
        if (traceStartInFlight) {
            if (bufferedRemotePayloads.length < MAX_BUFFERED_REMOTE_PAYLOADS) {
                bufferedRemotePayloads.push(remotePayload);
            }
            return;
        }

        traceStartInFlight = Promise.resolve(
            postToLoggingApi(remotePayload, { startTrace: true }),
        )
            .then(async (res) => {
                if (!res || !res.ok) return;
                const data = await res.json().catch(() => null);
                setCurrentTraceFromResponse(data);
            })
            .catch(() => {})
            .finally(() => {
                const tp = currentTrace?.traceparent || null;
                const toFlush = bufferedRemotePayloads;
                bufferedRemotePayloads = [];
                traceStartInFlight = null;
                // Flush buffered logs continuing the trace if we have one.
                for (const p of toFlush) {
                    postToLoggingApi(p, { traceparentOverride: tp });
                }
            });

        return;
    }

    postToLoggingApi(remotePayload, { traceparentOverride: currentTrace?.traceparent || null });
}

const logger = {
    configure(options = {}) {
        // Accept either `apiUrl` or `loggingApiUrl` for convenience.
        const apiUrl = options.apiUrl || options.loggingApiUrl || null;
        loggingApiUrl =
            typeof apiUrl === "string" && apiUrl.length ? apiUrl : null;
        remoteLoggingConfigured = Boolean(loggingApiUrl);

        if (typeof options.enableTraces === "boolean") {
            traceEnabled = options.enableTraces;
        }
        if (typeof options.traceFlags === "string" && /^[0-9a-f]{2}$/i.test(options.traceFlags)) {
            traceFlags = options.traceFlags.toLowerCase();
        }
    },

    setBaseContext(ctx = {}) {
        baseContext = { ...(ctx || {}) };
    },

    setUserId(userId) {
        const normalized =
            typeof userId === "string" && userId.length ? userId : null;
        baseContext = { ...(baseContext || {}), userId: normalized, user_id: normalized };
    },

    setLogFilePath(p) {
        logFilePath = p || null;
    },

    setTeeToConsole(enabled) {
        teeToConsole = Boolean(enabled);
    },

    // Tracing helpers
    getTraceparent() {
        return currentTrace?.traceparent || null;
    },
    setTraceparent(traceparent) {
        const tp = typeof traceparent === "string" && traceparent.length ? traceparent : null;
        currentTrace = { traceId: null, spanId: null, traceparent: tp };
    },
    clearTrace() {
        currentTrace = { traceId: null, spanId: null, traceparent: null };
    },

    isRemoteLoggingConfigured() {
        return remoteLoggingConfigured;
    },

    debug(...args) {
        emit("debug", args);
    },
    info(...args) {
        emit("info", args);
    },
    warn(...args) {
        emit("warn", args);
    },
    error(...args) {
        emit("error", args);
    },

    // For IPC: accept an args array already packed.
    emitFromIpc({ level = "info", args = [], context = {} } = {}) {
        const safeLevel =
            level === "debug" ||
            level === "info" ||
            level === "warn" ||
            level === "error"
                ? level
                : "error";
        emit(safeLevel, Array.isArray(args) ? args : [args], context);
    },
};

export default logger;
