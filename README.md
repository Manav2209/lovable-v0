# Lovable

Prompt-to-app builder: describe a product, an agent scaffolds and edits a React sandbox, and you get a live preview.

This monorepo (Bun workspaces + Turborepo) runs in a **hybrid** layout locally:

- **Host:** `web`, `backend`, `orchestator`, `ingress`, Redis via `kubectl port-forward`
- **Kubernetes:** Redis Service + one Deployment per project (`control` + `serving` containers)

## Architecture

```text
Browser
  ├─ web :5173  ──/api──►  backend :4000
  │                            │
  │                            │ Redis streams (backend:orch / orch:backend)
  │                            ▼
  │                       orchestator (host)
  │                            │
  │              ┌─────────────┼─────────────┐
  │              │ K8s API     │ orch:control│ orch:serve
  │              ▼             ▼             ▼
  │         project pod    control       serving
  │         NodePort       agent/R2      Vite :3000
  │              │             │             │
  │              └──────── Redis (cluster) ──┘
  │
  └─ Host header ──► ingress :8080 ──► http://127.0.0.1:<NodePort>
```

### Apps

| App | Role |
|-----|------|
| [`apps/web`](apps/web) | Product UI: landing `/`, studio `/studio`, project workspace |
| [`apps/backend`](apps/backend) | Auth, projects API, Redis publish/subscribe, SSE relay |
| [`apps/orchestator`](apps/orchestator) | Control plane: create K8s sandboxes, route build/run/prompt |
| [`apps/control`](apps/control) | In-pod agent (plan → tools → stitch → build → run) |
| [`apps/serve`](apps/serve) | In-pod Vite preview server |
| [`apps/ingress`](apps/ingress) | Host reverse proxy for `*.preview.localhost` |
| [`apps/template`](apps/template) | Base React/Vite/Tailwind/shadcn project (also mirrored in R2) |
| [`apps/evals`](apps/evals) | Headless eval harness: seeds a template, drives the real agent, runs deterministic + AST checks, scores & reports |

### Packages

| Package | Role |
|---------|------|
| `packages/types` | Stream names, message types, preview URL helpers |
| `packages/shared-redis` | Redis clients, consumer groups, publish/parse |
| `packages/database` | Drizzle/Prisma schema + DB access |
| `packages/r2` | Template / project object storage |

## End-to-end flow

### 1. Create project

```text
Web POST /api/v1/project { prompt }
  → Backend writes DB + conversationHistory
  → Redis CREATE_PROJECT (includes prompt)
  → Orchestrator:
       NodePort Service + Deployment (control, serving)
       wait Ready → PROJECT_INITIALIZED → control
  → Control pulls template from R2 into /app/shared/{id}
  → Serving confirms → PROJECT_CREATED
  → Orchestrator → PROJECT_INITIALIZED to backend (HTTP unblocks)
  → ~2.5s later: auto PROMPT with the initial brief
  → Web opens /project/:id + SSE
```

### 2. Agent prompt

```text
PROMPT → control
  → LangGraph: analyze → plan → tools → stitchApp → validate/fix → run
  → Events on Redis pub/sub agent:sse:{projectId}
  → Backend GET /api/v1/project/:id/events?token=… streams to browser
  → Serving starts Vite :3000, registers preview
  → Orchestrator registers host ingress → localhost:NodePort
```

`stitchApp` ensures new components are wired into `src/App.tsx` (avoids leaving the Hello World template).

### 3. Preview

```text
http://proj-{uuid}.preview.localhost:8080
  → apps/ingress
  → http://127.0.0.1:<NodePort>  (Docker Desktop)
  → serving container :3000
```

Cluster DNS (`*.svc.cluster.local`) is **not** used as the host ingress upstream.

### 4. Manual build / run

Workspace buttons publish `PROJECT_BUILD` / `PROJECT_RUN` through the same Redis + orchestrator path (control builds; serving runs Vite).

## Redis streams (summary)

| Stream | Direction |
|--------|-----------|
| `backend:orch` | API → orchestrator |
| `orch:backend` | orchestrator → API |
| `orch:control` / `control:orch` | orchestrator ↔ agent |
| `orch:serve` / `serve:orch` | orchestrator ↔ preview |
| `control:serving` / `serving:control` | agent ↔ preview (init) |
| `preview:register` | register ingress routes |
| `agent:sse:{projectId}` | live UI events (pub/sub) |

Control/serving use **per-project** consumer groups (`control-{id}`, `serve-{id}`) starting at `$` so pods do not steal each other’s messages.

## Local development

### Prerequisites

1. Bun + Docker Desktop Kubernetes  
2. Redis in-cluster + `kubectl port-forward svc/redis 6379:6379`  
3. Images built locally: `manav2854/control-pod:v0`, `manav2854/serving-pod:v0`  
4. Env files for `apps/backend`, `apps/orchestator` (see orchestrator README for pod Redis / R2 / keys)

### Typical processes

```text
kubectl port-forward svc/redis 6379:6379
apps/backend          → :4000
apps/orchestator      → SKIP_K8S=false, npm run dev
apps/ingress          → :8080
apps/web              → :5173 (proxies /api → :4000)
```

### Product URLs

| URL | Page |
|-----|------|
| `http://localhost:5173/` | Landing |
| `http://localhost:5173/studio` | Create project (auth) |
| `http://localhost:5173/project/:id` | Workspace + preview |
| `http://proj-….preview.localhost:8080` | Live sandbox |

## Docs

| Doc | Contents |
|-----|----------|
| [`flow.md`](flow.md) | Detailed system flow + failure map |
| [`decision.md`](decision.md) | Why NodePort, Redis split, stitchApp, timeouts, etc. |
| [`apps/orchestator/README.md`](apps/orchestator/README.md) | Orchestrator-focused runbook |
| [`apps/ingress/README.md`](apps/ingress/README.md) | Preview proxy |
| [`apps/evals/DECISIONS.md`](apps/evals/DECISIONS.md) | Eval system: decisions + methodology (why/how) |
| [`apps/evals/PR_DESCRIPTION.md`](apps/evals/PR_DESCRIPTION.md) | Eval system change summary (M1–M8 + observability) |

## Monorepo scripts

```sh
bun install
bun run build      # turbo build
bun run dev        # turbo dev (all workspace dev tasks)
bun run lint
bun run check-types
```
