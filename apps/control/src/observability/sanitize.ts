import { SECRET_ENV_PATTERN } from "../agent/tool/security";

const MAX_STRING = 800;
const MAX_DEPTH = 6;
const OMIT_VALUE_KEYS = new Set([
    "content",
    "data",
    "fileContents",
    "src",
    "source",
    "code",
    "oldString",
    "newString",
    "replace",
    "search",
]);

function looksLikeSecretValue(value: string): boolean {
    if (SECRET_ENV_PATTERN.test(value) && value.length > 8) return true;
    if (/^(sk-|rk-|ghp_|github_pat_)/i.test(value)) return true;
    if (/bearer\s+[a-z0-9._-]+/i.test(value)) return true;
    return false;
}

function truncate(value: string): string {
    if (value.length <= MAX_STRING) return value;
    return `${value.slice(0, MAX_STRING)}…[truncated ${value.length - MAX_STRING} chars]`;
}

/**
 * One sanitization pass for Langfuse (and any other traces): drop env-shaped
 * secrets, omit bulky file bodies, and cap string size.
 */
export function sanitizeForObservability(value: unknown, depth = 0): unknown {
    if (value == null) return value;
    if (depth > MAX_DEPTH) return "[max-depth]";

    if (typeof value === "string") {
        if (looksLikeSecretValue(value)) return "[redacted]";
        return truncate(value);
    }
    if (typeof value !== "object") return value;

    if (Array.isArray(value)) {
        return value.slice(0, 40).map((item) => sanitizeForObservability(item, depth + 1));
    }

    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
        if (SECRET_ENV_PATTERN.test(key)) {
            out[key] = "[redacted]";
            continue;
        }
        if (OMIT_VALUE_KEYS.has(key) && typeof nested === "string") {
            out[key] = `[omitted ${nested.length} chars]`;
            continue;
        }
        out[key] = sanitizeForObservability(nested, depth + 1);
    }
    return out;
}
