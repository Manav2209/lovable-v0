import { expect, test } from "bun:test";
import type { V1Pod } from "@kubernetes/client-node";
import { projectResources, workersStarted } from "./projectResources";

const env = { CONTROL_IMAGE: "control:test", SERVE_IMAGE: "serve:test", PREVIEW_DOMAIN: "preview.example.test", PREVIEW_PUBLIC_PORT: "80" };

test("initialization can proceed while the generated preview is still unready", () => {
  const pod: V1Pod = { status: { containerStatuses: [
    { name: "control", ready: true, started: true, image: "control", imageID: "control", restartCount: 0 },
    { name: "serving", ready: false, started: true, image: "serve", imageID: "serve", restartCount: 0 },
  ] } };
  expect(workersStarted(pod)).toBe(true);
  pod.status!.containerStatuses![1]!.started = false;
  expect(workersStarted(pod)).toBe(false);
  pod.status!.containerStatuses![1]!.started = true;
  pod.metadata = { deletionTimestamp: new Date() };
  expect(workersStarted(pod)).toBe(false);
});

test("project workload has stable routing, a shared writable group, and no Kubernetes/provider credentials in serving", () => {
  const { deployment, service, upstream, previewUrl } = projectResources("abc", env);
  const pod = deployment.spec!.template.spec!;
  expect(upstream).toBe("http://proj-abc.lovable-projects.svc.cluster.local:80");
  expect(previewUrl).toBe("http://proj-abc.preview.example.test");
  expect(service.spec!.type).toBe("ClusterIP");
  expect(pod.automountServiceAccountToken).toBe(false);
  expect(pod.securityContext!.fsGroup).toBe(pod.securityContext!.runAsGroup);
  expect(pod.containers[1]!.env!.some(e => e.name === "AIROUTER_API_KEY" || e.name === "SECRET_ACCESS_KEY")).toBe(false);
  expect(deployment.spec!.strategy!.type).toBe("Recreate");
});

test("unsafe project identities and missing images are rejected before provisioning", () => {
  expect(() => projectResources("../outside", env)).toThrow();
  expect(() => projectResources("abc", {})).toThrow("CONTROL_IMAGE");
});
