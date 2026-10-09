import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

export const components = ["backend", "web", "ingress", "orchestrator", "control", "serve"] as const;
type Component = typeof components[number];
type Images = Record<Component, string>;

/** Kustomize does not transform image strings stored inside ConfigMap data. */
export function releaseFiles(revision: string, images: Images, basePath: string, pullSecret?: string) {
  if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error("revision must be a full Git SHA");
  for (const component of components) {
    if (!/^[a-z0-9][a-z0-9._:/-]*@sha256:[a-f0-9]{64}$/.test(images[component] || "")) {
      throw new Error(`${component} must use a repository@sha256:digest image reference`);
    }
  }
  if (pullSecret && !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(pullSecret)) throw new Error("Invalid image pull secret name");
  const platform = ["backend", "web", "apps-ingress", "orchestrator"];
  const kustomization = {
    apiVersion: "kustomize.config.k8s.io/v1beta1", kind: "Kustomization",
    resources: [basePath],
    images: components.filter(c => c !== "control" && c !== "serve").map(component => {
      const [newName, digest] = images[component].split("@");
      return { name: `ghcr.io/manav2209/lovable-${component}`, newName, digest };
    }),
    patches: [
      { patch: JSON.stringify({
        apiVersion: "v1", kind: "ConfigMap",
        metadata: { name: "platform-config", namespace: "lovable-system" },
        data: {
          CONTROL_IMAGE: images.control, SERVE_IMAGE: images.serve,
          ...(pullSecret ? { PROJECT_IMAGE_PULL_SECRET: pullSecret } : {}),
        },
      }) },
      ...platform.map(name => ({ patch: JSON.stringify({
        apiVersion: "apps/v1", kind: "Deployment", metadata: { name, namespace: "lovable-system" },
        spec: { template: {
          metadata: { annotations: { "lovable.dev/revision": revision } },
          ...(pullSecret ? { spec: { imagePullSecrets: [{ name: pullSecret }] } } : {}),
        } },
      }) })),
    ],
  };
  const migration = {
    apiVersion: "batch/v1", kind: "Job",
    metadata: { name: `lovable-migrate-${revision.slice(0, 12)}`, namespace: "lovable-system" },
    spec: {
      backoffLimit: 0, activeDeadlineSeconds: 300, ttlSecondsAfterFinished: 86400,
      template: { spec: {
        restartPolicy: "Never", automountServiceAccountToken: false,
        securityContext: { runAsUser: 1000, runAsGroup: 1000, runAsNonRoot: true, seccompProfile: { type: "RuntimeDefault" } },
        ...(pullSecret ? { imagePullSecrets: [{ name: pullSecret }] } : {}),
        containers: [{
          name: "migrate", image: images.backend,
          command: ["bun", "run", "/app/packages/database/migrate.ts"],
          env: [{ name: "DATABASE_URL", valueFrom: { secretKeyRef: { name: "platform-secrets", key: "DATABASE_URL" } } }],
          resources: { requests: { cpu: "100m", memory: "128Mi" }, limits: { cpu: "1", memory: "512Mi" } },
          securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: ["ALL"] } },
        }],
      } },
    },
  };
  return { kustomization, migration };
}

async function main() {
  const args = process.argv.slice(2);
  const option = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const revision = option("--revision");
  const manifest = option("--images");
  if (!revision || !manifest) throw new Error("Usage: bun infra/k8s/scripts/prepare-release.ts --revision <40-char-sha> --images <images.json> [--pull-secret ghcr-creds] [--out infra/k8s/releases/<sha>]");
  const root = resolve(import.meta.dir, "../../..");
  const output = resolve(option("--out") || `infra/k8s/releases/${revision}`);
  const releases = resolve(root, "infra/k8s/releases");
  const within = relative(releases, output);
  if (!within || isAbsolute(within) || within.startsWith("..") || within.includes(`..${sep}`)) throw new Error("Output must be a subdirectory of infra/k8s/releases");
  const images = JSON.parse(await readFile(resolve(manifest), "utf8")) as Images;
  const basePath = relative(output, resolve(root, "infra/k8s/base")).replaceAll("\\", "/");
  const { kustomization, migration } = releaseFiles(revision, images, basePath, option("--pull-secret"));
  await mkdir(output, { recursive: true });
  for (const [name, value] of Object.entries({ "kustomization.yaml": kustomization, "migration-job.yaml": migration, "images.json": { revision, ...images } })) {
    await writeFile(resolve(output, name), JSON.stringify(value, null, 2) + "\n");
  }
  console.log(`Prepared release ${revision} in ${output}`);
  console.log("Run the migration Job successfully before applying this overlay. See infra/k8s/README.md.");
}

if (import.meta.main) await main();
