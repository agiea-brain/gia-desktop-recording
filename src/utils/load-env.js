import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";
import { fileURLToPath } from "url";

let loaded = false;
let loadedFromPath = null;

function safeExists(p) {
    try {
        return typeof p === "string" && p.length > 0 && fs.existsSync(p);
    } catch {
        return false;
    }
}

function findUp(startDir, filename, maxDepth = 10) {
    let dir = startDir;
    for (let i = 0; i < maxDepth; i++) {
        const candidate = path.join(dir, filename);
        if (safeExists(candidate)) return candidate;
        const parent = path.dirname(dir);
        if (!parent || parent === dir) break;
        dir = parent;
    }
    return null;
}

function getModuleDirname() {
    try {
        const __filename = fileURLToPath(import.meta.url);
        return path.dirname(__filename);
    } catch {
        // In some bundling contexts, import.meta.url may not be available.
        // Fall back to CWD-based searching only.
        return null;
    }
}

/**
 * Load `.env` into process.env in a robust way across:
 * - dev (cwd may not be repo root)
 * - webpack bundle paths
 * - packaged app (optional: include `.env` as an extraResource)
 *
 * You can override the exact file via `GIA_DOTENV_PATH=/path/to/.env`.
 */
export function loadEnv() {
    if (loaded) return { loaded: true, path: loadedFromPath };
    loaded = true;

    const overridePath = process.env.GIA_DOTENV_PATH || null;
    if (safeExists(overridePath)) {
        dotenv.config({ path: overridePath });
        loadedFromPath = overridePath;
        return { loaded: true, path: loadedFromPath };
    }

    const candidates = [];

    // 1) From current working directory upward (works for many dev flows)
    try {
        const cwd = process.cwd();
        const rootFromCwd = findUp(cwd, "package.json", 10);
        if (rootFromCwd) {
            candidates.push(path.join(path.dirname(rootFromCwd), ".env"));
        }
        candidates.push(path.join(cwd, ".env"));
    } catch {
        // ignore
    }

    // 2) From this module's location upward (works when cwd is not project root)
    const moduleDir = getModuleDirname();
    if (moduleDir) {
        const rootFromModule = findUp(moduleDir, "package.json", 10);
        if (rootFromModule) {
            candidates.push(path.join(path.dirname(rootFromModule), ".env"));
        }
    }

    // 3) Packaged apps can optionally ship a `.env` as an extraResource.
    // Electron sets `process.resourcesPath` at runtime (only if running under Electron).
    if (typeof process.resourcesPath === "string") {
        candidates.push(path.join(process.resourcesPath, ".env"));
    }

    for (const p of candidates) {
        if (safeExists(p)) {
            dotenv.config({ path: p });
            loadedFromPath = p;
            return { loaded: true, path: loadedFromPath };
        }
    }

    // Fall back to default dotenv behavior (process.cwd()).
    dotenv.config();
    loadedFromPath = null;
    return { loaded: true, path: loadedFromPath };
}

