# Orchestrator

The orchestrator is the **control plane** for Lovable project sandboxes. It sits on the host, listens to Redis streams from the backend, provisions Kubernetes pods for each project, and routes work to the **control** (agent) and **serving** (preview) containers.

In local hybrid mode it is the bridge between:

- Host apps: `backend`, `ingress`, Redis via `kubectl port-forward`
- In-cluster: Redis Service, per-project Deployments (control + serving)

## Role in the system

```text
Web ──HTTP──► Backend ──backend:orch──► Orchestrator
                                           │
                     ┌─────────────────────┼─────────────────────┐
                     │                     │                     │
                     ▼                     ▼                     ▼
              K8s API (create         orch:control          orch:serve
              Deploy/Service/         (init/build/          (run preview)
              NodePort)                prompt)
                     │                     │                     │
                     ▼                     ▼                     ▼
              project pod            control container     serving container
              (shared emptyDir)      agent + R2 pull       Vite :3000
                     │                     │                     │
                     │◄──── control:orch / serve:orch ──────────┘
                     │
                     ▼
              orch:backend ──► Backend (unblocks HTTP waiters)
                     │
                     └─► register host ingress → localhost:NodePort
```

The orchestrator does **not** run the LLM agent or Vite itself. It schedules and waits.

## Architecture

### Process layout (local)

| Process | Where | Talks to Redis as |
|---------|--------|-------------------|
| Orchestrator | Host | `REDIS_URL=redis://localhost:6379` (port-forward) |
| Backend / ingress / web | Host | same localhost Redis |
| Control + serving | K8s pod | `POD_REDIS_URL` / `redis://redis.default.svc.cluster.local:6379` |

Host `REDIS_URL` is **never** copied into pods as-is (pods would hit their own localhost and fail with `ECONNREFUSED`).

### What it creates per project

For each `CREATE_PROJECT` (when `SKIP_K8S=false`):

1. **Service** (`NodePort`) — host ingress can reach Vite via `http://127.0.0.1:<nodePort>`
2. **Deployment** — two containers:
   - `control` — `manav2854/control-pod:v0`, readiness on `:3001/health`
   - `serving` — `manav2854/serving-pod:v0`, port `3000` (no readiness; Vite starts only on run)
3. **Ingress** (optional) — K8s Ingress object for `proj-*.preview.localhost` (often unused locally if no nginx controller; `apps/ingress` is the real edge)

Shared volume: `emptyDir` at `/app/shared` for the project workspace.

### Redis listeners

On start, three consumer-group loops (group `orch`):

| Listener | Stream | Handles |
|----------|--------|---------|
| Backend | `backend:orch` | `CREATE_PROJECT`, `PROJECT_BUILD`, `PROJECT_RUN`, `PROMPT` |
| Control | `control:orch` | build / prompt replies → forward to backend |
| Serving | `serve:orch` | `PROJECT_CREATED`, run success/fail → backend + ingress register |

In-flight waiters are keyed by `projectId` (`waitForControl` / `waitForServer`). Late replies after a timeout are still forwarded to `orch:backend`.

## Flows

### Create project

```text
1. Backend publishes CREATE_PROJECT { projectId, userId, prompt }
2. Orchestrator stores pendingInitialPrompts[projectId] = prompt
3. createProjectPod(projectId)
     - NodePort Service → remember host upstream localhost:nodePort
     - Deployment with REDIS_URL = in-cluster Redis, PREVIEW_UPSTREAM = localhost NodePort
     - Wait until Ready (control health)
4. Publish PROJECT_INITIALIZED → orch:control
5. Control pulls R2 template → serving confirms → PROJECT_CREATED on serve:orch
6. Orchestrator publishes PROJECT_INITIALIZED → orch:backend
   (backend HTTP create unblocks)
7. ~2.5s later: auto PROMPT with the initial create prompt
```

### Prompt (agent)

```text
Backend / auto-create
  → orch publishes PROMPT → orch:control
  → waitForControl for PROMPT_RESPONSE
  → forward payload to orch:backend

Control runs the agent (plan → tools → stitchApp → build/fix → run).
Serving starts Vite and registers preview; orchestrator on RUN_SUCCESS
calls registerHostIngressRoute(projectId) so apps/ingress points at NodePort.
```

### Build

```text
Backend PROJECT_BUILD
  → orch:control PROJECT_BUILD
  → wait for PROJECT_BUILD_SUCCESS | FAILED
  → orch:backend
```

### Run

```text
Backend PROJECT_RUN
  → orch:serve PROJECT_RUN
  → wait for PROJECT_RUN_SUCCESS | FAILED
  → orch:backend (+ host ingress register on success)
```

## Preview path (why NodePort)

Host `apps/ingress` cannot dial `*.svc.cluster.local`. Project Services are **NodePort**; upstream registered with ingress is:

```text
http://127.0.0.1:<nodePort>
```

Public URL shape:

```text
http://proj-{sanitized-uuid}.preview.localhost:8080
```

## Environment

Copy / set in `apps/orchestator/.env` (example):

| Variable | Typical local value | Meaning |
|----------|---------------------|---------|
| `REDIS_URL` | `redis://localhost:6379` | Host Redis (port-forward) |
| `POD_REDIS_URL` | `redis://redis.default.svc.cluster.local:6379` | Injected into pods |
| `SKIP_K8S` | `false` | Create real K8s resources |
| `K8S_NAMESPACE` | `default` | Namespace for project resources |
| `PREVIEW_DOMAIN` | `preview.localhost` | Host suffix for preview URLs |
| `PREVIEW_PUBLIC_PORT` | `8080` | Public ingress port in URLs |
| `INGRESS_ADMIN_URL` | `http://host.docker.internal:8080` | Pod → host ingress admin |
| `HOST_INGRESS_ADMIN_URL` | `http://127.0.0.1:8080` | Orchestrator → host ingress register |
| `BUCKET_NAME` / R2 keys / `GROQ_API_KEY` | … | Passed through to control |

Kubeconfig: default client load (`~/.kube/config`). On Windows you may also set `KUBECONFIG` in the shell before `npm run dev`.

## Run locally

Prerequisites:

1. Docker Desktop Kubernetes (or compatible cluster)
2. Redis Deployment + Service in cluster
3. `kubectl port-forward svc/redis 6379:6379`
4. Local images: `manav2854/control-pod:v0`, `manav2854/serving-pod:v0` (`imagePullPolicy: Never`)
5. Backend + ingress running on the host

```bash
cd apps/orchestator
npm run dev
# → npx tsx src/index.ts
```

PowerShell example:

```powershell
$env:KUBECONFIG = "$HOME\.kube\config"
npm run dev
```

## Source map

| Path | Responsibility |
|------|----------------|
| `src/index.ts` | Stream listeners, create/build/run/prompt handlers, waiters |
| `src/handler/project.ts` | K8s Service/Deployment/Ingress, NodePort upstream, ingress register |
| `src/types.ts` | Payload typings |

## Related docs

- Repo root [`flow.md`](../../flow.md) — full product flow (web → backend → orch → pods → preview/SSE)
- Repo root [`decision.md`](../../decision.md) — why NodePort, per-project Redis groups, stitchApp, etc.
- [`apps/ingress/README.md`](../ingress/README.md) — host preview proxy
