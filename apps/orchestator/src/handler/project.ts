import * as k8s from "@kubernetes/client-node";
import { toPreviewSlug } from "types";
import { projectResources, workersStarted } from "./projectResources";

const kc = new k8s.KubeConfig();
if (process.env.KUBERNETES_SERVICE_HOST) kc.loadFromCluster();
else kc.loadFromDefault();
const appsApi = kc.makeApiClient(k8s.AppsV1Api);
const coreApi = kc.makeApiClient(k8s.CoreV1Api);
const namespace = () => process.env.K8S_NAMESPACE || "lovable-projects";

function statusCode(error: unknown): number | undefined {
  const e = error as { code?: number; statusCode?: number; response?: { statusCode?: number } };
  return e.code || e.statusCode || e.response?.statusCode;
}

async function waitForWorkers(name: string, timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pods = await coreApi.listNamespacedPod({ namespace: namespace(), labelSelector: `project=${name}` });
    if (pods.items.some(workersStarted)) return;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error(`Timed out waiting for control and serving workers for ${name}`);
}

/** Kept for the optional host-development router; cluster routing needs no registration. */
export async function registerHostIngressRoute(projectId: string, upstream?: string): Promise<void> {
  if (process.env.PROJECT_SERVICE_TYPE !== "NodePort") return;
  const resolved = upstream || await getHostPreviewUpstream(projectId);
  if (!resolved) throw new Error("Project Service has no NodePort");
  const admin = process.env.HOST_INGRESS_ADMIN_URL || "http://127.0.0.1:8080";
  const res = await fetch(`${admin}/_ingress/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.INGRESS_ADMIN_TOKEN || ""}` },
    body: JSON.stringify({ projectId, slug: toPreviewSlug(projectId), upstream: resolved }),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`Host ingress registration failed: ${res.status}`);
}

export async function getHostPreviewUpstream(projectId: string): Promise<string | null> {
  const svc = await coreApi.readNamespacedService({ name: toPreviewSlug(projectId), namespace: namespace() });
  const port = svc.spec?.ports?.find(p => p.name === "http")?.nodePort;
  return port ? `http://127.0.0.1:${port}` : null;
}

export async function createProjectPod(projectId: string) {
  const resources = projectResources(projectId);
  const { name, service, deployment, previewUrl } = resources;
  let existingService: k8s.V1Service;
  try {
    existingService = await coreApi.createNamespacedService({ namespace: namespace(), body: service });
  } catch (error) {
    if (statusCode(error) !== 409) throw error;
    existingService = await coreApi.readNamespacedService({ namespace: namespace(), name });
    if (existingService.spec?.type !== service.spec?.type) {
      throw new Error(`Service ${name} has a different type; migrate it explicitly before reuse`);
    }
  }
  let hostUpstream = resources.upstream;
  if (service.spec?.type === "NodePort") {
    const nodePort = existingService.spec?.ports?.find(p => p.name === "http")?.nodePort;
    if (!nodePort) throw new Error("Project Service is missing its NodePort");
    hostUpstream = `http://127.0.0.1:${nodePort}`;
    deployment.spec!.template.spec!.containers.find(c => c.name === "serving")!.env!.push(
      { name: "PREVIEW_UPSTREAM", value: hostUpstream },
      { name: "INGRESS_ADMIN_URL", value: process.env.INGRESS_ADMIN_URL || "http://host.docker.internal:8080" },
      { name: "INGRESS_ADMIN_TOKEN", valueFrom: { secretKeyRef: { name: process.env.PROJECT_RUNTIME_SECRET || "project-runtime-secrets", key: "INGRESS_ADMIN_TOKEN", optional: true } } },
    );
  }
  try {
    await appsApi.createNamespacedDeployment({ namespace: namespace(), body: deployment });
  } catch (error) {
    if (statusCode(error) !== 409) throw error;
    // Existing workspaces are ephemeral: updating their image here would erase work.
    console.log(`Deployment ${name} already exists`);
  }
  // Both workers must have their Redis groups before initialization is dispatched.
  // The Pod itself can remain unready until the generated preview starts.
  await waitForWorkers(name);
  return { name, previewUrl, hostUpstream };
}