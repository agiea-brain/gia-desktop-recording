import * as fs from "fs";
import * as path from "path";
import * as util from "util";
import * as logfire from "logfire";

let logFilePath = null;
let baseContext = {};
let teeToConsole = true;
let logfireConfigured = false;

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

function escapeLogfireMessage(msg) {
    // Logfire uses {field} message templates; util.format of objects includes `{ ... }`
    // which triggers "Formatting error: The field ... is not defined."
    return String(msg).replaceAll("{", "{{").replaceAll("}", "}}");
}

function emit(level, args, context) {
    const msg = formatArgs(args);
    const mergedContext = { ...baseContext, ...(context || {}) };

    if (teeToConsole) {
        try {
            const fn =
                (typeof console?.[level] === "function" && console[level]) ||
                (typeof console?.log === "function" && console.log);
            if (fn) {
                if (Object.keys(mergedContext).length) fn(...args, mergedContext);
                else fn(...args);
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

    // Be conservative with the JS SDK call signature: message first, context second.
    // If the installed Logfire SDK differs, we still want logging to never crash the app.
    try {
        // logfire uses `warning`, not `warn`
        const logfireLevel = level === "warn" ? "warning" : level;
        const fn =
            (typeof logfire[logfireLevel] === "function" && logfire[logfireLevel]) ||
            (typeof logfire.info === "function" && logfire.info);
        if (fn) {
            fn(escapeLogfireMessage(msg), mergedContext);
        }
    } catch {
        // ignore Logfire failures (network, misconfig, API mismatch)
    }
}

const logger = {
    configure(options = {}) {
        try {
            // logfire@0.12.x exposes `configureLogfireApi` (no `configure` export).
            // Keep backwards compatibility if a newer/older SDK changes again.
            if (typeof logfire.configure === "function") {
                logfire.configure(options);
                logfireConfigured = true;
                return;
            }
            if (typeof logfire.configureLogfireApi === "function") {
                logfire.configureLogfireApi(options);
                logfireConfigured = true;
                return;
            }
            if (typeof logfire.default?.configureLogfireApi === "function") {
                logfire.default.configureLogfireApi(options);
                logfireConfigured = true;
                return;
            }
        } catch {
            // ignore
        }
    },

    setBaseContext(ctx = {}) {
        baseContext = { ...(ctx || {}) };
    },

    setLogFilePath(p) {
        logFilePath = p || null;
    },

    setTeeToConsole(enabled) {
        teeToConsole = Boolean(enabled);
    },

    isLogfireConfigured() {
        return logfireConfigured;
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
            level === "debug" || level === "info" || level === "warn"
                ? level
                : "error";
        emit(safeLevel, Array.isArray(args) ? args : [args], context);
    },
};

export default logger;
