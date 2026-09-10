export function assertEnv(keys: string[]): void {
    const missing = keys.filter((key) => !process.env[key]);
    if (missing.length === 0) return;
    console.error(`Missing required environment variable(s): ${missing.join(", ")}`);
    process.exit(1);
}