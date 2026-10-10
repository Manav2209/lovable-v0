import { randomUUID } from "node:crypto";

const services = {
  backend: { port: 4000, health: "/readyz", expected: 200 },
  control: { port: 3001, health: "/health", expected: 200 },
  ingress: { port: 8080, health: "/_ingress/health", expected: 200 },
  orchestrator: { port: 3003, health: "/readyz", expected: 200 },
  serve: { port: 3002, health: "/healthz", expected: 200 },
  web: { port: 8080, health: "/health", expected: 200 },
} as const;
type Component = keyof typeof services;

async function docker(...args: string[]) {
  const child = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill(), 120_000);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    if (code !== 0) throw new Error(`docker ${args[0]} failed: ${stderr.trim()} ${stdout.trim()}`);
    return args[0] === "logs" ? (stdout + stderr).trim() : stdout.trim();
  } finally { clearTimeout(timer); }
}

async function waitForHttp(url: string, expected: number) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
      await response.body?.cancel();
      if (response.status === expected) return;
    } catch { /* container is still starting */ }
    await Bun.sleep(500);
  }
  throw new Error(`${url} did not return ${expected} within 60 seconds`);
}

async function main() {
  const [componentArg, image] = process.argv.slice(2);
  if (!componentArg || !Object.hasOwn(services, componentArg) || !image) throw new Error("Usage: bun infra/docker/smoke-image.ts <component> <image>");
  const component = componentArg as Component;
  const service = services[component];
  const runId = `lovable-smoke-${component}-${randomUUID().slice(0, 8)}`;
  const network = runId;
  const app = `${runId}-app`;
  const redis = `${runId}-redis`;
  const postgres = `${runId}-postgres`;
  const created: string[] = [];
  let networkCreated = false;
  try {
    const inspection = JSON.parse(await docker("image", "inspect", image))[0];
    if (!/^[1-9][0-9]*(?::[1-9][0-9]*)?$/.test(inspection.Config.User)) throw new Error("Runtime image must declare a numeric non-root user");
    await docker("network", "create", network);
    networkCreated = true;
    if (component !== "web" && component !== "ingress") {
      created.push(redis);
      await docker("run", "--detach", "--name", redis, "--network", network, "redis:7.4-alpine");
    }
    if (component === "backend") {
      created.push(postgres);
      await docker("run", "--detach", "--name", postgres, "--network", network,
        "--env", "POSTGRES_PASSWORD=smoke-only", "--env", "POSTGRES_DB=lovable", "postgres:16-alpine");
      const deadline = Date.now() + 60_000;
      let ready = false;
      while (Date.now() < deadline) {
        try { await docker("exec", postgres, "pg_isready", "-h", "127.0.0.1", "-U", "postgres", "-d", "lovable"); ready = true; break; }
        catch { await Bun.sleep(500); }
      }
      if (!ready) throw new Error("Isolated PostgreSQL did not start");
      // Verify that the backend image contains the database package and migration SQL.
      await docker("run", "--rm", "--network", network, "--cap-drop", "ALL",
        "--env", `DATABASE_URL=postgresql://postgres:smoke-only@${postgres}:5432/lovable`,
        "--entrypoint", "bun", image, "run", "/app/packages/database/migrate.ts");
    }
    const env: Record<string, string> = {
      REDIS_URL: `redis://${redis}:6379`,
      PROJECT_ID: `smoke-${component}`, LANGFUSE_ENABLED: "0", LLM_PROVIDER: "groq",
      GROQ_API_KEY: "smoke-only", SSE_HOST: "0.0.0.0", SKIP_K8S: "true",
      INGRESS_ROUTING_MODE: "cluster", INGRESS_BIND_HOST: "0.0.0.0",
      PREVIEW_ROUTING_MODE: "cluster", JWT_SECRET: "isolated-smoke-test-secret",
      DATABASE_URL: `postgresql://postgres:smoke-only@${postgres}:5432/lovable`,
    };
    created.push(app);
    await docker("run", "--detach", "--name", app, "--network", network,
      "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
      "--publish", `127.0.0.1::${service.port}`,
      ...Object.entries(env).flatMap(([key, value]) => ["--env", `${key}=${value}`]), image);
    const running = JSON.parse(await docker("inspect", app))[0];
    const port = running.NetworkSettings.Ports[`${service.port}/tcp`][0].HostPort;
    const origin = `http://127.0.0.1:${port}`;
    await waitForHttp(origin + service.health, service.expected);
    if (component === "serve") {
      // Supervisor is alive; an app has not been generated yet, so preview stays unready.
      await waitForHttp(origin + "/readyz", 503);
    }
    if (component === "web") {
      const page = await fetch(origin + "/studio", { signal: AbortSignal.timeout(2000) });
      if (page.status !== 200 || !(await page.text()).includes('<div id="root">')) throw new Error("SPA fallback did not return the built application");
      await waitForHttp(origin + "/api/v1/missing", 404);
    } else {
      // Catch dev-only installs and filesystem permission failures in the actual image.
      const probe = `
        import { unlink } from 'node:fs/promises';
        for (const dependency of ['typescript', 'turbo', 'prettier']) {
          let present = false;
          try { Bun.resolveSync(dependency, process.cwd()); present = true; } catch {}
          if (present) throw new Error('Development tool in runtime: ' + dependency);
        }
        for (const path of ['/app/shared/.smoke-write', '/app/tmp/.smoke-write']) {
          await Bun.write(path, 'ok'); await unlink(path);
        }
        console.log('Production dependencies and writable runtime paths verified');
      `;
      console.log(await docker("exec", app, "bun", "-e", probe));
    }
    console.log(`${component}: non-root startup and HTTP checks passed`);
  } catch (error) {
    try { console.error(await docker("logs", app)); } catch { /* container may not exist yet */ }
    throw error;
  } finally {
    for (const container of created.reverse()) {
      try { await docker("rm", "--force", container); } catch { /* failed creation */ }
    }
    if (networkCreated) await docker("network", "rm", network);
  }
}

if (import.meta.main) await main();
