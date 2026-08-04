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

export async function createProjectPod(projectId: string) {
    const name = toPreviewSlug(projectId);
    const previewUrl = buildPreviewUrl({ projectId });

    const envVars = [
        { name: "PROJECT_ID", value: projectId },
        { name: "SHARED_DIR", value: "/app/shared" },
        {
            name: "REDIS_URL",
            value: process.env.REDIS_URL || "redis://redis.default.svc.cluster.local:6379",
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
        {
            name: "PREVIEW_UPSTREAM",
            value: `http://${name}.${NAMESPACE}.svc.cluster.local:3000`,
        },
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
                            readinessProbe: {
                                tcpSocket: { port: 3000 },
                                initialDelaySeconds: 5,
                                periodSeconds: 5,
                            },
                        },
                    ],
                },
            },
        },
    };

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
            selector: {
                project: name,
            },
            ports: [
                {
                    name: "http",
                    port: 3000,
                    targetPort: 3000,
                },
            ],
            type: "ClusterIP",
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
        await appsApi.createNamespacedDeployment({
            namespace: NAMESPACE,
            body: deployment,
        });

        await coreApi.createNamespacedService({
            namespace: NAMESPACE,
            body: service,
        });

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
                // Cluster may not have ingress API / controller — apps/ingress still works
                console.warn(
                    "Failed to create K8s Ingress (apps/ingress proxy can still route):",
                    ingErr,
                );
            }
        }

        console.log("K8s resources created for project:", projectId, "as", name);
        console.log("Preview URL:", previewUrl);
        return { name, previewUrl };
    } catch (e: unknown) {
        const status = (e as { response?: { statusCode?: number } })?.response
            ?.statusCode;
        if (status === 409) {
            console.log("Pod already exists for", projectId);
            return { name, previewUrl };
        }
        throw e;
    }
}
