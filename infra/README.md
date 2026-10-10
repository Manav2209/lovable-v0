# Infrastructure

All container definitions and Kubernetes configuration live here. Build Docker images from the repository root so Bun can resolve the workspace packages.

- `docker/`: Dockerfiles for backend, web, ingress, orchestrator, control, and serve, plus the container smoke check.
- `k8s/base/`: platform Deployments, Services, Caddy routing, namespaces, RBAC, and project policies.
- `k8s/overlays/local/`: local Kubernetes entry point.
- `k8s/examples/`: placeholder environment files for creating Secrets.
- `k8s/scripts/`: release preparation helper.

Start with the [Kubernetes learning and deployment guide](k8s/README.md).

The GitHub Actions entry point is `.github/workflows/deployment-images.yml`. The application code that creates each project's Deployment and Service remains in `apps/orchestator/src/handler/projectResources.ts`.

Each Dockerfile runs `turbo prune <workspace> --docker`. The dependency stage receives pruned manifests and `bun.lock` before the source stage, so source edits can reuse the dependency installation. Bun services install production dependencies into a fresh stage, then copy the full pruned tree to preserve workspace-local dependencies and symlinks. Web keeps its build tools in the builder stage and copies only static output into nginx.

After a build, run `bun infra/docker/smoke-image.ts <component> <image>` to verify non-root startup, health, writable Bun runtime paths, and the absence of development tools. The smoke check creates and removes its own Docker network and disposable dependency containers. CI runs these checks for pushes to `ops`, pull requests, and `main`; main publishes each image only after its smoke check passes.
