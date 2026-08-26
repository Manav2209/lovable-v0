import fs from "fs";
import path from "path";

/**
 * Loads KEY=VALUE env files without overriding already-set variables.
 * Precedence (lowest → highest):
 *   apps/control/.env  (agent runtime defaults: GROQ_API_KEY, BUCKET_NAME, ...)
 *   <repoRoot>/.env
 *   apps/evals/.env    (eval-specific overrides)
 */
export function bootstrapEnv(): void {
    const evalsDir = path.resolve(import.meta.dir, "..");
    const repoRoot = path.resolve(evalsDir, "..", "..");

    loadEnvFile(path.join(repoRoot, "apps", "control", ".env"));
    loadEnvFile(path.join(repoRoot, ".env"));
    loadEnvFile(path.join(evalsDir, ".env"));
}

function loadEnvFile(filePath: string): void {
    if (!fs.existsSync(filePath)) return;

    const content = fs.readFileSync(filePath, "utf8");
    for (const rawLine of content.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith("#")) continue;

        const eq = line.indexOf("=");
        if (eq === -1) continue;

        const key = line.slice(0, eq).trim();
        let value = line.slice(eq + 1).trim();
        if (
            (value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))
        ) {
            value = value.slice(1, -1);
        }

        if (key && process.env[key] === undefined) {
            process.env[key] = value;
        }
    }
}
