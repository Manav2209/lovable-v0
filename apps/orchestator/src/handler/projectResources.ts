import type { V1Deployment, V1Service, V1EnvVar, V1Pod } from "@kubernetes/client-node";
import { assertSafeProjectId, buildPreviewUrl, projectServiceUrl, toPreviewSlug } from "types";

export function projectResources(projectId: string, env: NodeJS.ProcessEnv = process.env) {
  assertSafeProjectId(projectId);
  const name = toPreviewSlug(projectId);
  const namespace = env.K8S_NAMESPACE || "lovable-projects";
  const upstream = projectServiceUrl(name, namespace);
  const controlImage = env.CONTROL_IMAGE;
  const serveImage = env.SERVE_IMAGE;
  if (!controlImage || !serveImage) throw new Error("CONTROL_IMAGE and SERVE_IMAGE are required");
  const serviceType = env.PROJECT_SERVICE_TYPE || "ClusterIP";
  if (serviceType !== "ClusterIP" && serviceType !== "NodePort") throw new Error("Invalid PROJECT_SERVICE_TYPE");
  const secret = env.PROJECT_RUNTIME_SECRET || "project-runtime-secrets";
  const previewUrl = buildPreviewUrl({
    projectId,
    domain: env.PREVIEW_DOMAIN || "preview.localhost",
    protocol: env.PREVIEW_PUBLIC_PROTOCOL || "http",
    port: env.PREVIEW_PUBLIC_PORT || "80",
  });
  const common: V1EnvVar[] = [
    { name: "PROJECT_ID", value: projectId },
    { name: "SHARED_DIR", value: "/app/shared" },
    { name: "REDIS_URL", valueFrom: { secretKeyRef: { name: secret, key: "REDIS_URL" } } },
    { name: "PREVIEW_URL", value: previewUrl },
    { name: "PREVIEW_DOMAIN", value: env.PREVIEW_DOMAIN || "preview.localhost" },
    { name: "PREVIEW_PUBLIC_PORT", value: env.PREVIEW_PUBLIC_PORT || "80" },
    { name: "PREVIEW_PUBLIC_PROTOCOL", value: env.PREVIEW_PUBLIC_PROTOCOL || "http" },
  ];
  const controlEnv: V1EnvVar[] = [
    ...common,
    { name: "SSE_HOST", value: "0.0.0.0" },
    { name: "BUCKET_NAME", value: env.BUCKET_NAME || "lovable" },
    { name: "S3_API", value: env.S3_API || "" },
    ...["ACCESS_KEY_ID", "SECRET_ACCESS_KEY", "GROQ_API_KEY", "AIROUTER_API_KEY", "LANGFUSE_PUBLIC_KEY", "LANGFUSE_SECRET_KEY"].map(key => ({
      name: key, valueFrom: { secretKeyRef: { name: secret, key, optional: true } },
    })),
    ...["LLM_PROVIDER", "GROQ_MODEL", "AIROUTER_BASE_URL", "AIROUTER_MODEL", "LANGFUSE_ENABLED", "LANGFUSE_BASE_URL", "LANGFUSE_TRACING_ENVIRONMENT"].filter(key => env[key]).map(key => ({ name: key, value: env[key]! })),
  ];
  const securityContext = {
    allowPrivilegeEscalation: false, runAsNonRoot: true,
    capabilities: { drop: ["ALL"] },
  };
  const resources = {
    requests: { cpu: "250m", memory: "256Mi", "ephemeral-storage": "256Mi" },
    limits: { cpu: "1", memory: "1Gi", "ephemeral-storage": "2Gi" },
  };
  const volumeMounts = [{ name: "shared", mountPath: "/app/shared" }];
  const deployment: V1Deployment = {
    apiVersion: "apps/v1", kind: "Deployment",
    metadata: { name, namespace, labels: { app: "lovable-project", project: name } },
    spec: {
      replicas: 1, strategy: { type: "Recreate" },
      selector: { matchLabels: { project: name } },
      template: {
        metadata: { labels: { app: "lovable-project", project: name, projectId } },
        spec: {
          automountServiceAccountToken: false,
          securityContext: { runAsUser: 1000, runAsGroup: 1000, fsGroup: 1000, seccompProfile: { type: "RuntimeDefault" } },
          ...(env.PROJECT_IMAGE_PULL_SECRET ? { imagePullSecrets: [{ name: env.PROJECT_IMAGE_PULL_SECRET }] } : {}),
          volumes: [{ name: "shared", emptyDir: { sizeLimit: "2Gi" } }],
          containers: [
            {
              name: "control", image: controlImage, imagePullPolicy: "IfNotPresent", env: controlEnv,
              ports: [{ name: "control", containerPort: 3001 }],
              startupProbe: { httpGet: { path: "/health", port: "control" }, timeoutSeconds: 5, periodSeconds: 2, failureThreshold: 60 },
              readinessProbe: { httpGet: { path: "/health", port: "control" }, timeoutSeconds: 5, periodSeconds: 3 },
              livenessProbe: { httpGet: { path: "/health", port: "control" }, timeoutSeconds: 5, periodSeconds: 15, failureThreshold: 6 },
              securityContext, resources, volumeMounts,
            },
            {
              name: "serving", image: serveImage, imagePullPolicy: "IfNotPresent", env: [...common, { name: "PREVIEW_ROUTING_MODE", value: serviceType === "ClusterIP" ? "cluster" : "registered" }],
              ports: [{ name: "http", containerPort: 3000 }, { name: "supervisor", containerPort: 3002 }],
              startupProbe: { httpGet: { path: "/healthz", port: "supervisor" }, timeoutSeconds: 5, periodSeconds: 2, failureThreshold: 60 },
              readinessProbe: { httpGet: { path: "/readyz", port: "supervisor" }, timeoutSeconds: 5, periodSeconds: 3 },
              livenessProbe: { httpGet: { path: "/healthz", port: "supervisor" }, timeoutSeconds: 5, periodSeconds: 15, failureThreshold: 6 },
              securityContext, resources, volumeMounts,
            },
          ],
        },
      },
    },
  };
  const service: V1Service = {
    apiVersion: "v1", kind: "Service", metadata: { name, namespace },
    spec: { type: serviceType, selector: { project: name }, ports: [{ name: "http", port: 80, targetPort: "http" }] },
  };
  return { name, namespace, previewUrl, upstream, deployment, service };
}

/** Preview readiness intentionally stays false until generation/run finishes. */
export function workersStarted(pod: V1Pod): boolean {
  if (pod.metadata?.deletionTimestamp) return false;
  const statuses = pod.status?.containerStatuses || [];
  return statuses.some(c => c.name === "control" && c.ready) &&
    statuses.some(c => c.name === "serving" && c.started === true);
}
