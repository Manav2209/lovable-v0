# Local Kubernetes deployment

This configuration moves the platform into Kubernetes and uses Caddy as the edge proxy. Project recovery is deferred: project workspaces still use `emptyDir`, so replacing a project Pod loses its workspace. Keep this environment local while learning.

## Understand the request path

1. `app.127.0.0.1.nip.io` reaches Caddy.
2. Caddy sends `/api` and `/api/*` to `backend`; the remaining app paths reach `web`.
3. `*.preview.127.0.0.1.nip.io` reaches `apps-ingress`.
4. The preview gateway validates the project slug and resolves `proj-<id>.lovable-projects.svc.cluster.local:80`.
5. That ClusterIP Service reaches the project's serving container on port 3000.

Caddy has one wildcard rule. The orchestrator creates a Deployment and Service for each project, without creating an Ingress or changing Caddy's configuration.

Agent progress uses SSE through the API. Vite uses WebSockets for preview hot reload; both proxy layers support it. Caddy's streaming and WebSocket behavior is described in the [reverse proxy documentation](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy).

## Learn in this order

1. Read `infra/docker/Dockerfile.backend` and build the six images. Notice that shared packages are included and runtime processes run as UID 1000.
2. Render the local overlay with `kubectl kustomize infra/k8s/overlays/local`. Read the Deployments, Services, ConfigMap, and namespace-scoped Role before applying them.
3. Create dependency Secrets, run database migrations, and start the platform. Confirm the app/API routing before creating a project.
4. Create a project, inspect its two containers and Service, and watch readiness change when its preview starts. Rehearse backend/ingress replication after Redis integration tests pass.

`/healthz` answers whether a supervisor is alive. `/readyz` answers whether it can serve traffic. A new serving supervisor is alive while its generated website is still unready. The orchestrator waits for worker startup before sending initialization, avoiding a circular wait for a website that has not been created yet.

## Prerequisites and configuration

Use a working local Kubernetes context and Docker Linux engine. PostgreSQL, Redis, and S3-compatible object storage must be reachable from Pods. `host.docker.internal` in the examples is intended for Docker Desktop; a K3s VM needs reachable VM/network addresses instead of that hostname. Populate object storage's `template/` prefix with the existing application template before creating a project.

For K3s, disable its bundled Traefik when installing it (`--disable=traefik`) so Caddy's LoadBalancer Service can claim port 80. The project NetworkPolicy requires a CNI that enforces NetworkPolicy; verify this before relying on isolation. See [K3s networking services](https://docs.k3s.io/networking/networking-services).

Edit the non-secret values in `infra/k8s/base/config.yaml`: object storage endpoint, bucket, provider/model, and public hostnames. After later ConfigMap changes, restart the affected platform Deployments so their environment updates. Newly created project Pods read the orchestrator's current configuration.

Copy the placeholder secret files and fill them locally:

```powershell
Copy-Item infra/k8s/examples/platform.env.example infra/k8s/examples/platform.env.local
Copy-Item infra/k8s/examples/runtime.env.example infra/k8s/examples/runtime.env.local
kubectl apply -f infra/k8s/base/namespaces.yaml
kubectl create secret generic platform-secrets -n lovable-system --from-env-file=infra/k8s/examples/platform.env.local
kubectl create secret generic project-runtime-secrets -n lovable-projects --from-env-file=infra/k8s/examples/runtime.env.local
```

The `.env.local` files are ignored by Git and Docker. Platform Secrets hold database/auth credentials. Runtime Secrets hold Redis and object storage/provider credentials. Only control receives provider credentials; serving does not. The orchestrator uses Secret references and has no permission to read Secret contents.

## Build local images

From the repository root:

```powershell
docker build -f infra/docker/Dockerfile.backend -t ghcr.io/manav2209/lovable-backend:local .
docker build -f infra/docker/Dockerfile.web -t ghcr.io/manav2209/lovable-web:local .
docker build -f infra/docker/Dockerfile.ingress -t ghcr.io/manav2209/lovable-ingress:local .
docker build -f infra/docker/Dockerfile.orchestrator -t ghcr.io/manav2209/lovable-orchestrator:local .
docker build -f infra/docker/Dockerfile.control -t ghcr.io/manav2209/lovable-control:local .
docker build -f infra/docker/Dockerfile.serve -t ghcr.io/manav2209/lovable-serve:local .
```

These names match the local overlay. The cluster must have access to the built images: a separate K3s VM needs an image import or registry push. Confirm image availability instead of assuming the host's Docker image store is shared with Kubernetes.

For the first local database setup, run `bun run --cwd packages/database migrate` with a `DATABASE_URL` reachable from your terminal. This uses the checked-in Drizzle migrations. Verify success before starting the backend.

```powershell
kubectl apply -k infra/k8s/overlays/local
kubectl rollout status deployment/backend -n lovable-system --timeout=180s
kubectl rollout status deployment/orchestrator -n lovable-system --timeout=180s
kubectl get pods,services -n lovable-system
```

Open `http://app.127.0.0.1.nip.io`. If the LoadBalancer is pending, use `kubectl port-forward -n lovable-system service/caddy 8080:80`, change `FRONTEND_ORIGIN` to `http://app.127.0.0.1.nip.io:8080` and `PREVIEW_PUBLIC_PORT` to `8080`, reapply, and restart backend/orchestrator. Access the app and previews on port 8080. The hostnames must resolve locally; use hosts entries for the app and each test preview if your DNS blocks loopback answers.

## Published releases and migrations

The deployment workflow checks types, tests against an isolated Redis, builds the frontend, validates Caddy, renders Kubernetes configuration, and builds all six images. Main-branch runs publish SHA tags to GHCR and produce a `release-<full-git-sha>` artifact containing digest-pinned configuration. It does not apply anything to a cluster.

Download that artifact into `infra/k8s/releases/<full-git-sha>/` in a checkout of the same revision. The release records four platform images and both runtime images. Kustomize does not rewrite image strings stored in ConfigMap data, so the helper patches `CONTROL_IMAGE` and `SERVE_IMAGE` explicitly.

For private GHCR images, create a registry pull Secret with the same name in both namespaces. Regenerate the release with `--pull-secret ghcr-creds`, using its `images.json`:

```powershell
bun infra/k8s/scripts/prepare-release.ts --revision <full-git-sha> --images infra/k8s/releases/<full-git-sha>/images.json --pull-secret ghcr-creds
kubectl kustomize infra/k8s/releases/<full-git-sha>
kubectl apply -f infra/k8s/releases/<full-git-sha>/migration-job.yaml
kubectl wait -n lovable-system --for=condition=complete job/lovable-migrate-<first-12-sha-characters> --timeout=300s
```

If the migration fails, inspect the Job logs and stop the release. After it succeeds:

```powershell
kubectl apply -k infra/k8s/releases/<full-git-sha>
kubectl rollout status deployment/backend -n lovable-system --timeout=180s
kubectl rollout status deployment/orchestrator -n lovable-system --timeout=180s
kubectl rollout status deployment/apps-ingress -n lovable-system --timeout=180s
kubectl rollout status deployment/web -n lovable-system --timeout=180s
```

Use backward-compatible database migrations. Reapplying the prior release overlay rolls back platform image/configuration versions; it does not reverse database changes. Existing project Deployments keep their runtime image versions. Updating or deleting them is a separate operation because their ephemeral workspace is not recoverable yet.

Orchestrator and project Deployments use `Recreate` with one replica to avoid overlapping processes owning the same in-memory work. Platform upgrades can interrupt in-flight jobs, and project Pod replacement can lose files. Durable job recovery and workspace restoration remain follow-up work.

## Checks and troubleshooting

```powershell
bun install --frozen-lockfile
bun run check-types
bun test
docker run --rm -e APP_HOST=app.127.0.0.1.nip.io -e PREVIEW_DOMAIN=preview.127.0.0.1.nip.io -v "${PWD}/infra/k8s/base/Caddyfile:/etc/caddy/Caddyfile:ro" caddy:2.10.2-alpine caddy validate --config /etc/caddy/Caddyfile
```

To run the shared-state integration tests locally, start a disposable Redis on a free port, set `TEST_REDIS_URL` to it, and run `bun test apps/backend/src/lib/sharedState.integration.test.ts`. Never point this variable at your production Redis. Without it, these tests are skipped.

After creating a project, inspect `kubectl get pods,services -n lovable-projects`, `kubectl describe pod <pod-name> -n lovable-projects`, and each container's logs. `ImagePullBackOff` means the image or pull credentials are unavailable; `CreateContainerConfigError` often means a required Secret is missing; an unready serving container means its preview has not started or is failing.

The local Caddyfile uses HTTP explicitly. Public HTTPS needs real domains, certificate storage that survives Pod replacement, and a DNS challenge/provider configuration for wildcard preview certificates. The stock Caddy image does not contain arbitrary DNS provider modules. See [Caddy automatic HTTPS](https://caddyserver.com/docs/automatic-https).
