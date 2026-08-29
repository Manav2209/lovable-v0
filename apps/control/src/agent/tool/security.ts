import fs from "fs";
import path from "path";
import { spawn, type ChildProcess } from "node:child_process";

/**
 * Resolve the sandbox root. Tools must only ever touch files inside
 * `<SHARED_DIR>/<PROJECT_ID>` so a prompt-injected tool call cannot read or
 * write outside the pod's workspace.
 */
export function getProjectDir(): string {
    const sharedDir = process.env.SHARED_DIR || "/app/shared";
    const projectId = process.env.PROJECT_ID || "";
    return path.join(sharedDir, projectId);
}

/**
 * Resolves `segments` against `baseDir` and guarantees the result stays
 * inside `baseDir`. Rejects `..` escapes, absolute paths, and (for paths that
 * already exist) symlinks pointing outside the sandbox.
 */
export function resolveSafePath(baseDir: string, ...segments: string[]): string {
    const base = path.resolve(baseDir);
    const resolved = path.resolve(base, ...segments);

    const rel = path.relative(base, resolved);
    if (rel === "") return base;
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
        throw new Error(`Path escapes project directory: "${segments.join(" >= ")}"`);
    }

    if (fs.existsSync(resolved)) {
        const real = fs.realpathSync(resolved);
        const realBase = fs.existsSync(base) ? fs.realpathSync(base) : base;
        const realRel = path.relative(realBase, real);
        if (realRel.startsWith("..") || path.isAbsolute(realRel)) {
            throw new Error(
                `Path escapes project directory via symlink: "${segments.join(" >= ")}"`,
            );
        }
    }

    return resolved;
}

const SECRET_ENV_PATTERN =
    /(?:API_KEY|ACCESS_KEY|SECRET|TOKEN|PASSWORD|JWT|DATABASE_URL|S3_API|PRIVATE|PRESIGN)/i;

/**
 * Environment handed to subprocesses launched by the agent. Cloud credentials
 * and database secrets are stripped so a prompt-injected command cannot read
 * or exfiltrate them.
 */
export function sanitizeSubprocessEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const key of Object.keys(env)) {
        if (SECRET_ENV_PATTERN.test(key)) {
            delete env[key];
        }
    }
    return env;
}

export interface ProcessOptions {
    cwd: string;
    timeoutMs?: number;
    env?: NodeJS.ProcessEnv;
    maxOutputBytes?: number;
}

export interface ProcessResult {
    exitCode: number;
    stdout: string;
    stderr: string;
    timedOut: boolean;
    success: boolean;
    error?: string;
}

const DEFAULT_TIMEOUT_MS = 2 * 60_000;
const DEFAULT_MAX_OUTPUT = 5 * 1024 * 1024;
const MARGINAL_MAX_COMMAND_LENGTH = 10_000;

/**
 * Runs a child process, capturing (and capping) stdout/stderr, enforcing a
 * timeout, and always settling. The returned promise never rejects so callers
 * can rely on the result structure regardless of spawn failures.
 */
function runChild(
    proc: ChildProcess,
    opts: ProcessOptions,
): Promise<ProcessResult> {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxOutput = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let used = 0;
    let settled = false;

    const collect = (chunk: Buffer): void => {
        if (used >= maxOutput) return;
        const target = used + chunk.length > maxOutput ? chunk.subarray(0, maxOutput - used) : chunk;
        stdoutChunks.push(target);
        used += target.length;
    };

    return new Promise((resolve) => {
        const timer = setTimeout(() => {
            settled = true;
            try {
                proc.kill("SIGKILL");
            } catch {
                /* already gone */
            }
            resolve({
                exitCode: -1,
                stdout: Buffer.concat(stdoutChunks).toString(),
                stderr:
                    Buffer.concat(stderrChunks).toString() +
                    `\n[process] timed out after ${timeoutMs}ms`,
                timedOut: true,
                success: false,
                error: `Timed out after ${timeoutMs}ms`,
            });
        }, timeoutMs);

        proc.stdout?.on("data", collect);
        proc.stderr?.on("data", (chunk: Buffer) => {
            if (used >= maxOutput) return;
            const target = used + chunk.length > maxOutput ? chunk.subarray(0, maxOutput - used) : chunk;
            stderrChunks.push(target);
            used += target.length;
        });

        proc.on("error", (err) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            const message = String(err?.message ?? err);
            resolve({
                exitCode: 1,
                stdout: Buffer.concat(stdoutChunks).toString(),
                stderr: message,
                timedOut: false,
                success: false,
                error: message,
            });
        });

        proc.on("close", (code) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve({
                exitCode: code ?? 1,
                stdout: Buffer.concat(stdoutChunks).toString(),
                stderr: Buffer.concat(stderrChunks).toString(),
                timedOut: false,
                success: code === 0,
            });
        });
    });
}

/** Spawns an executable with an explicit argument array (no shell). */
export function runProcess(
    command: string,
    args: string[],
    opts: ProcessOptions,
): Promise<ProcessResult> {
    if (command.length > MARGINAL_MAX_COMMAND_LENGTH) {
        throw new Error("Command line too long");
    }
    const child = spawn(command, args, {
        cwd: opts.cwd,
        shell: false,
        env: opts.env ?? sanitizeSubprocessEnv(),
    });
    return runChild(child, opts);
}

/** Executes a shell command string. Intended for agent-driven execution. */
export function runShellCommand(
    command: string,
    opts: ProcessOptions,
): Promise<ProcessResult> {
    if (command.length > MARGINAL_MAX_COMMAND_LENGTH) {
        throw new Error("Command line too long");
    }
    const child = spawn(command, [], {
        cwd: opts.cwd,
        shell: true,
        env: opts.env ?? sanitizeSubprocessEnv(),
    });
    return runChild(child, opts);
}