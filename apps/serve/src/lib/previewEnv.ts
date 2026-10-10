import { buildPreviewUrl, sanitizeSubprocessEnv } from "types";

/** Trust only this project's public hostname, without exposing supervisor secrets. */
export function previewProcessEnv(projectId: string, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const previewUrl = env.PREVIEW_URL || buildPreviewUrl({
    projectId,
    domain: env.PREVIEW_DOMAIN,
    protocol: env.PREVIEW_PUBLIC_PROTOCOL,
    port: env.PREVIEW_PUBLIC_PORT,
  });
  const hostname = new URL(previewUrl).hostname;
  return {
    ...sanitizeSubprocessEnv(env),
    PORT: "3000",
    HOST: "0.0.0.0",
    __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS: hostname,
  };
}
