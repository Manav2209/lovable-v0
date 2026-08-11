import * as k8s from "@kubernetes/client-node";
import { buildPreviewUrl, toPreviewSlug } from "types";

const kc = new k8s.KubeConfig();
kc.loadFromDefault();
const currentContext = kc.getCurrentContext();
kc.setCurrentContext(currentContext);

const appsApi = kc.makeApiClient(k8s.AppsV1Api);
const coreApi = kc.makeApiClient(k8s.CoreV1Api);
const netApi = kc.makeApiClient(k8s.NetworkingV1Api);

const NAMESPACE = process.env.K8S_NAMESPACE || "default";
const PREVIEW_DOMAIN = process.env.PREVIEW_DOMAIN || "preview.localhost";
const INGRESS_CLASS = process.env.INGRESS_CLASS || "nginx";
/** Host ingress admin — pods reach the host via Docker Desktop gateway */
const INGRESS_ADMIN_URL =
    process.env.INGRESS_ADMIN_URL || "http://host.docker.internal:8080";

/**
 * Host apps use REDIS_URL=redis://localhost:6379 via `kubectl port-forward svc/redis 6379:6379`.
 * Project pods must use the in-cluster service DNS — never the host REDIS_URL.
 */
function resolvePodRedisUrl(): string {
    return (
        process.env.POD_REDIS_URL ||
        `redis://redis.${NAMESPACE}.svc.cluster.local:6379`
    );
}

async function waitForDeploymentReady(
    name: string,
    timeoutMs = 120_000,
): Promise<void> {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
        try {
            const dep = await appsApi.readNamespacedDeploymentStatus({
                name,
                namespace: NAMESPACE,
            });
            const ready = dep.status?.readyReplicas ?? 0;
            const desired = dep.spec?.replicas ?? 1;
            if (ready >= desired && desired > 0) {
                console.log(`Deployment ${name} is ready (${ready}/${desired})`);
                return;
            }
        } catch (err) {
            console.warn(`Waiting for deployment ${name}:`, err);
        }
        await new Promise((r) => setTimeout(r, 2000));
    }
    throw new Error(
        `Timed out waiting for deployment ${name} to become ready`,
    );
}

function httpNodePortFromService(svc: k8s.V1Service): number | null {
    const port = svc.spec?.ports?.find(
        (p) => p.name === "http" || p.port === 3000,
    );
    return port?.nodePort ?? null;
}

/**
 * Host-side ingress cannot reach ClusterIP DNS. Expose NodePort and return
 * an upstream the host process can dial (localhost:nodePort on Docker Desktop).
 */
export async function getHostPreviewUpstream(
    projectId: string,
): Promise<string | null> {
    const name = toPreviewSlug(projectId);
    try {
        const svc = await coreApi.readNamespacedService({
            name,
            namespace: NAMESPACE,
        });
        const nodePort = httpNodePortFromService(svc);
        if (!nodePort) return null;
        return `http://127.0.0.1:${nodePort}`;
    } catch {
        return null;
    }
}

export async function registerHostIngressRoute(
    projectId: string,
    upstream?: string,
): Promise<void> {
    const resolved = upstream || (await getHostPreviewUpstream(projectId));
    if (!resolved) {
        console.warn(
            `[${projectId}] No NodePort upstream available for ingress register`,
        );
        return;
    }
    const slug = toPreviewSlug(projectId);
    const admin =
        process.env.HOST_INGRESS_ADMIN_URL || "http://127.0.0.1:8080";
    try {
        const res = await fetch(`${admin}/_ingress/register`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ projectId, slug, upstream: resolved }),
        });
        if (!res.ok) {
            console.warn(
                `[${projectId}] Host ingress register failed:`,
                await res.text(),
            );
            return;
        }
        console.log(
            `[${projectId}] Host ingress registered ${slug} → ${resolved}`,
        );
    } catch (err) {
        console.warn(`[${projectId}] Host ingress unreachable at ${admin}:`, err);
    }
}

async function ensureNodePortService(
    name: string,
    projectId: string,
): Promise<number> {
    const service: k8s.V1Service = {
        apiVersion: "v1",
        kind: "Service",
        metadata: {
            name,
            labels: {
                project: name,
                projectId,
            },
        },
        spec: {
            type: "NodePort",
            selector: {
                project: name,
            },
            ports: [
                {
                    name: "http",
                    port: 3000,
                    targetPort: 3000,
                },
                {
                    name: "sse",
                    port: 3001,
                    targetPort: 3001,
                },
            ],
        },
    };

    try {
        const created = await coreApi.createNamespacedService({
            namespace: NAMESPACE,
            body: service,
        });
        const nodePort = httpNodePortFromService(created);
        if (!nodePort) {
            throw new Error(`Service ${name} created without http nodePort`);
        }
        return nodePort;
    } catch (e: unknown) {
        const status = (e as { response?: { statusCode?: number } })?.response
            ?.statusCode;
        if (status !== 409) throw e;

        const existing = await coreApi.readNamespacedService({
            name,
            namespace: NAMESPACE,
        });
        // Upgrade ClusterIP → NodePort if needed
        if (existing.spec?.type !== "NodePort") {
            existing.spec = existing.spec || {};
            existing.spec.type = "NodePort";
            const patched = await coreApi.replaceNamespacedService({
                name,
                namespace: NAMESPACE,
                body: existing,
            });
            const nodePort = httpNodePortFromService(patched);
            if (!nodePort) {
                throw new Error(`Service ${name} patched without http nodePort`);
            }
            return nodePort;
        }
        const nodePort = httpNodePortFromService(existing);
        if (!nodePort) {
            throw new Error(`Existing service ${name} has no http nodePort`);
        }
        return nodePort;
    }
}

export async function createProjectPod(projectId: string) {
    const name = toPreviewSlug(projectId);
    const previewUrl = buildPreviewUrl({ projectId });
    const podRedisUrl = resolvePodRedisUrl();

    // Create NodePort first so host ingress can reach the preview via localhost.
    const httpNodePort = await ensureNodePortService(name, projectId);
    const hostUpstream = `http://127.0.0.1:${httpNodePort}`;
    console.log(
        `Preview NodePort for ${name}: ${httpNodePort} (host upstream ${hostUpstream})`,
    );

    const envVars = [
        { name: "PROJECT_ID", value: projectId },
        { name: "SHARED_DIR", value: "/app/shared" },
        {
            name: "REDIS_URL",
            value: podRedisUrl,
        },
        { name: "BUCKET_NAME", value: process.env.BUCKET_NAME || "lovable" },
        { name: "S3_API", value: process.env.S3_API || "" },
        { name: "ACCESS_KEY_ID", value: process.env.ACCESS_KEY_ID || "" },
        { name: "SECRET_ACCESS_KEY", value: process.env.SECRET_ACCESS_KEY || "" },
        { name: "GROQ_API_KEY", value: process.env.GROQ_API_KEY || "" },
        { name: "PREVIEW_DOMAIN", value: PREVIEW_DOMAIN },
        {
            name: "PREVIEW_PUBLIC_PORT",
            value: process.env.PREVIEW_PUBLIC_PORT || "8080",
        },
        {
            name: "PREVIEW_PUBLIC_PROTOCOL",
            value: process.env.PREVIEW_PUBLIC_PROTOCOL || "http",
        },
        // Host ingress dials this (Docker Desktop exposes NodePorts on localhost).
        { name: "PREVIEW_UPSTREAM", value: hostUpstream },
        { name: "INGRESS_ADMIN_URL", value: INGRESS_ADMIN_URL },
        { name: "PREVIEW_URL", value: previewUrl },
    ].filter((env) => env.value !== "");

    const deployment: k8s.V1Deployment = {
        apiVersion: "apps/v1",
        kind: "Deployment",
        metadata: {
            name,
            labels: { project: projectId, app: "lovable-project" },
        },
        spec: {
            replicas: 1,
            selector: {
                matchLabels: {
                    project: name,
                },
            },
            template: {
                metadata: {
                    labels: {
                        project: name,
                        projectId,
                    },
                },
                spec: {
                    volumes: [
                        {
                            name: "shared",
                            emptyDir: {},
                        },
                    ],
                    containers: [
                        {
                            name: "control",
                            imagePullPolicy: "Never",
                            image: "manav2854/control-pod:v0",
                            command: ["bun", "run", "src/index.ts"],
                            env: envVars,
                            ports: [
                                {
                                    containerPort: 3001,
                                    name: "sse",
                                },
                            ],
                            readinessProbe: {
                                httpGet: { path: "/health", port: 3001 },
                                initialDelaySeconds: 2,
                                periodSeconds: 3,
                            },
                            volumeMounts: [
                                {
                                    name: "shared",
                                    mountPath: "/app/shared",
                                },
                            ],
                        },
                        {
                            name: "serving",
                            imagePullPolicy: "Never",
                            image: "manav2854/serving-pod:v0",
                            command: ["bun", "run", "src/index.ts"],
                            env: envVars,
                            ports: [
                                {
                                    containerPort: 3000,
                                    name: "http",
                                },
                            ],
                            volumeMounts: [
                                {
                                    name: "shared",
                                    mountPath: "/app/shared",
                                },
                            ],
                        },
                    ],
                },
            },
        },
    };

    const ingress: k8s.V1Ingress = {
        apiVersion: "networking.k8s.io/v1",
        kind: "Ingress",
        metadata: {
            name,
            labels: {
                project: name,
                projectId,
            },
            annotations: {
                "kubernetes.io/ingress.class": INGRESS_CLASS,
                "nginx.ingress.kubernetes.io/proxy-body-size": "32m",
            },
        },
        spec: {
            ingressClassName: INGRESS_CLASS,
            rules: [
                {
                    host: `${name}.${PREVIEW_DOMAIN}`,
                    http: {
                        paths: [
                            {
                                path: "/",
                                pathType: "Prefix",
                                backend: {
                                    service: {
                                        name,
                                        port: { number: 3000 },
                                    },
                                },
                            },
                        ],
                    },
                },
            ],
        },
    };

    try {
        try {
            await appsApi.createNamespacedDeployment({
                namespace: NAMESPACE,
                body: deployment,
            });
        } catch (depErr: unknown) {
            const status = (depErr as { response?: { statusCode?: number } })
                ?.response?.statusCode;
            if (status !== 409) throw depErr;
            console.log("Deployment already exists for", name);
        }

        try {
            await netApi.createNamespacedIngress({
                namespace: NAMESPACE,
                body: ingress,
            });
            console.log(
                `K8s Ingress created: ${name}.${PREVIEW_DOMAIN} → svc/${name}:3000`,
            );
        } catch (ingErr: unknown) {
            const status =
                (ingErr as { response?: { statusCode?: number } })?.response
                    ?.statusCode;
            if (status === 409) {
                console.log("Ingress already exists for", name);
            } else {
                console.warn(
                    "Failed to create K8s Ingress (apps/ingress proxy can still route):",
                    ingErr,
                );
            }
        }

        console.log("K8s resources created for project:", projectId, "as", name);
        console.log("Preview URL:", previewUrl);
        console.log("Pod REDIS_URL:", podRedisUrl);
        console.log("Host preview upstream:", hostUpstream);
        await waitForDeploymentReady(name);
        return { name, previewUrl, hostUpstream };
    } catch (e: unknown) {
        const status = (e as { response?: { statusCode?: number } })?.response
            ?.statusCode;
        if (status === 409) {
            console.log("Pod already exists for", projectId);
            await waitForDeploymentReady(name).catch((err) =>
                console.warn("Existing deployment not ready yet:", err),
            );
            return { name, previewUrl, hostUpstream };
        }
        throw e;
    }
}
