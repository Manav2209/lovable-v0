import * as k8s from "@kubernetes/client-node";

const kc = new k8s.KubeConfig();
kc.loadFromDefault();
// ✅ FORCE context + credentials
const currentContext = kc.getCurrentContext();
kc.setCurrentContext(currentContext);



const appsApi = kc.makeApiClient(k8s.AppsV1Api);
const coreApi = kc.makeApiClient(k8s.CoreV1Api);

export async function createProjectPod(projectId: string) {
    const namespace = "default";
    const name = "pod-" + projectId;

    const deployment: k8s.V1Deployment = {
        apiVersion: "apps/v1",
        kind: "Deployment",
        metadata: {
        name,
        },
        spec: {
        replicas: 1,
        selector: {
            matchLabels: {
            project: projectId,
            },
        },
        template: {
            metadata: {
            labels: {
                project: projectId,
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
                image: "manav2854/control-pod:v0",
                command: ["bun","run" ,"dev"],
                env: [
                    { name: "PROJECT_ID", value: projectId },
                    { name: "SHARED_DIR", value: "/app/shared" },
                ],
                volumeMounts: [
                    {
                    name: "shared",
                    mountPath: "/app/shared",
                    },
                ],
                },
                {
                name: "serving",
                image: "manav2854/serving-pod:v0",
                command: ["bun","run","dev"],
                env: [
                    { name: "PROJECT_ID", value: projectId },
                    { name: "SHARED_DIR", value: "/app/shared" },
                ],
                ports: [
                    {
                    containerPort: 3000,
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

    const service: k8s.V1Service = {
        apiVersion: "v1",
        kind: "Service",
        metadata: {
        name: projectId.toLowerCase(),
        labels: {
            project: projectId,
        },
        },
        spec: {
        selector: {
            project: projectId,
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

    try {
        await appsApi.createNamespacedDeployment({
            namespace,
            body: deployment,
        });
        
        await coreApi.createNamespacedService({
            namespace,
            body: service,
        });

        console.log("K8s pod created for project:", projectId);
    } catch (e: any) {
        if (e?.response?.statusCode === 409) {
        console.log("Pod already exists for", projectId);
        return;
        }

        throw e;
    }
}
