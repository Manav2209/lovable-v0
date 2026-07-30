import * as k8s from "@kubernetes/client-node";

const kc = new k8s.KubeConfig();
kc.loadFromDefault();
const currentContext = kc.getCurrentContext();
kc.setCurrentContext(currentContext);



const appsApi = kc.makeApiClient(k8s.AppsV1Api);
const coreApi = kc.makeApiClient(k8s.CoreV1Api);

export async function createProjectPod(projectId: string) {
    const namespace = "default";
    const name = "pod-" + projectId;

     // List of env vars to pass to both containers
    const envVars = [
        { name: "PROJECT_ID", value: projectId },
        { name: "SHARED_DIR", value: "/app/shared" },
        { name: "REDIS_URL", value: "redis://10.102.241.81:6379" },
        { name: "BUCKET_NAME", value: process.env.BUCKET_NAME || "lovable" },
        { name: "S3_API", value: process.env.S3_API || "" },
        { name: "ACCESS_KEY_ID", value: process.env.ACCESS_KEY_ID || "" },
        { name: "SECRET_ACCESS_KEY", value: process.env.SECRET_ACCESS_KEY || "" },
        { name: "GROQ_API_KEY", value: process.env.GROQ_API_KEY || "" },
        // Add any other env vars your control/serving pods need
    ].filter(env => env.value !== ""); // optionally filter out empty values

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
                imagePullPolicy: "Never",
                image: "manav2854/control-pod:v0",
                command: ["bun","run" ,"dev"],
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
                imagePullPolicy:"Never",
                image: "manav2854/serving-pod:v0",
                command: ["bun","run","dev"],
                env: envVars,
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
