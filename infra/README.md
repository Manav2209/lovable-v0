# Infrastructure

All container definitions and Kubernetes configuration live here. Build Docker images from the repository root so Bun can resolve the workspace packages.

- `docker/`: Dockerfiles for backend, web, ingress, orchestrator, control, and serve.
- `k8s/base/`: platform Deployments, Services, Caddy routing, namespaces, RBAC, and project policies.
- `k8s/overlays/local/`: local Kubernetes entry point.
- `k8s/examples/`: placeholder environment files for creating Secrets.
- `k8s/scripts/`: release preparation helper.

Start with the [Kubernetes learning and deployment guide](k8s/README.md).

The GitHub Actions entry point is `.github/workflows/deployment-images.yml`. The application code that creates each project's Deployment and Service remains in `apps/orchestator/src/handler/projectResources.ts`.
