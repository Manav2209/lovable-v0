# Architecture & debugging decisions

Decisions made while bringing local K8s hybrid create → agent → preview to a working state (Aug 2026).

## Environment model

### Decision: Hybrid host + Kubernetes

**Choice:** Run web, backend, orchestrator, and ingress on the host; run per-project control/serving in Docker Desktop Kubernetes.

**Why:** Faster iteration on host services; isolate project sandboxes in pods with shared emptyDir + R2 templates.

**Consequence:** Anything the host must dial cannot use ClusterIP DNS (`*.svc.cluster.local`). Anything a pod must dial as “localhost Redis” cannot use the host’s `REDIS_URL` unchanged.

---

## Redis

### Decision: One Redis in the cluster; host uses port-forward

**Choice:** Deploy Redis in K8s; `kubectl port-forward svc/redis 6379:6379` for host apps; pods use `redis://redis.default.svc.cluster.local:6379`.

**Why:** Single message bus for streams/pub-sub across host and pods.

**Rejected:** Host-only Redis with `host.docker.internal` from pods — workable, but user already ran Redis in-cluster.

### Decision: Never inject host `REDIS_URL` into pods

**Choice:** `POD_REDIS_URL` / default in-cluster DNS for pod env. Orchestrator’s `REDIS_URL=localhost` stays on the host only.

**Why:** First outage was control `ECONNREFUSED` on `redis://localhost:6379` inside the pod.

### Decision: Per-project consumer groups starting at `$`

**Choice:** Groups named `control-{projectId}` / `serve-{projectId}`, created with start ID `$`.

**Why:** A shared `control` / `serve` group load-balanced messages to the wrong project pod (stolen INIT/BUILD). Starting at `0` also replayed the entire stream history on every new pod and delayed real work past timeouts.

**Tradeoff:** Messages published before the group exists are missed — mitigated by waiting for deployment Ready (control `/health`) before `PROJECT_INITIALIZED`, and starting listeners before exposing health.

---

## Kubernetes project resources

### Decision: Control readiness on SSE `:3001`; no serving readiness on `:3000`

**Choice:** Control HTTP GET `/health` on 3001. Serving has no readiness probe on 3000.

**Why:** Serving only binds `:3000` after PROJECT_RUN (Vite). Probing 3000 kept pods at `1/2` Ready and raced init.

### Decision: Service type NodePort for preview

**Choice:** Expose project Service as `NodePort`; host upstream = `http://127.0.0.1:<nodePort>`.

**Why:** Host `apps/ingress` cannot resolve/connect to ClusterIP DNS. NodePort is reachable on Docker Desktop via localhost.

**Also:** On `PROJECT_RUN_SUCCESS`, orchestrator calls host ingress `/_ingress/register` with that upstream (belt-and-suspenders vs pod Redis register).

### Decision: Pod `INGRESS_ADMIN_URL=http://host.docker.internal:8080`

**Choice:** Pods register preview over HTTP to the host ingress via Docker Desktop gateway.

**Why:** `127.0.0.1:8080` from inside the pod is the pod itself → ConnectionRefused.

---

## Timeouts & async replies

### Decision: Long waits for build/run/prompt (up to ~10 minutes)

**Choice:** Orchestrator/backend waiters raised substantially for BUILD / RUN / PROMPT.

**Why:** Cold `bun install` + Vite/tsc in-pod routinely exceeded 60–180s; success arrived after the HTTP client already saw TIMEOUT.

### Decision: Forward late replies when no waiter

**Choice:** If BUILD_*/RUN_*/PROMPT_RESPONSE arrives after timeout cleared the Map, still publish to `orch:backend`.

**Why:** Avoid silent success that never updates the API layer after a false timeout.

### Decision: Skip `bun install` on run if `node_modules` exists

**Choice:** Serving run path skips install when dependencies were already installed during build/agent.

**Why:** Duplicate installs caused run timeouts even when Vite would have started quickly.

---

## Preview / Vite

### Decision: Force Vite on port 3000 with `--strictPort`

**Choice:** `bun x vite --host 0.0.0.0 --port 3000 --strictPort` (not default 5173).

**Why:** K8s Service targets containerPort 3000; default Vite 5173 breaks Service/Ingress routing.

### Decision: HTTP/`127.0.0.1` readiness instead of `nc`

**Choice:** Probe with `fetch(http://127.0.0.1:3000/)` and TCP connect.

**Why:** Vite was already listening on 3000 but `nc -z localhost` failed in the image → false negative → process killed (exit 143).

### Decision: Resolve serve script as `start` → `dev` → `preview`

**Choice:** Do not require `scripts.start`.

**Why:** Template only ships `dev` / `preview` → “No start script in package.json”.

### Decision: Template `build` = `vite build` (no `tsc -b &&`)

**Choice:** Drop hard TypeScript project build gate from the default script.

**Why:** LLM output often fails `tsc` (unused React imports, invented Lucide icons, missing shadcn pieces) while Vite can still serve a useful preview.

---

## Agent UX

### Decision: Auto-run initial create prompt

**Choice:** CREATE_PROJECT carries `prompt`; after PROJECT_CREATED, orchestrator schedules `handlePrompt` (~2.5s delay).

**Why:** Ideal UX is “describe app → watch it appear”, not manual Build/Run/Prompt after create. Delay lets the workspace open SSE first.

### Decision: Browser SSE via backend, not control `:3001`

**Choice:** Backend `GET /api/v1/project/:id/events?token=...` subscribes to `agent:sse:{projectId}`. Control `sendSSEMessage` also Redis-publishes.

**Why:** Browser cannot reach in-pod `localhost:3001`. Returning that URL caused `sse_error`.

### Decision: Deterministic `stitchApp` after tool execution

**Choice:** After agent tools run, scan `src/components` (excl. `ui`) + `src/pages`; if `App.tsx` is still Hello World or missing imports, rewrite it to compose those components.

**Why:** Models frequently create section components but leave the template `App.tsx` untouched → preview shows only Hello World.

### Decision: Prompt rules for App.tsx stitching + real Lucide icons

**Choice:** Planner/analyzer system prompts require final App.tsx wiring; ban invented icons; prefer `.tsx` entry.

**Why:** Same Hello World failure mode + build/runtime breaks (`IconPottery`, wrong `App.jsx` paths).

---

## Create vs prompt vs build vs run

| Action | Who does the work | Success signal |
|--------|-------------------|----------------|
| Create | orch K8s + control template pull + serving confirm | PROJECT_CREATED → INITIALIZED |
| Initial prompt | control agent workflow (+ stitch + run) | SSE events + optional preview_ready |
| Build button | control `bun install` + `bun run build` | PROJECT_BUILD_SUCCESS |
| Run button | serving Vite + ingress register | PROJECT_RUN_SUCCESS + preview URL |

**Decision:** Agent path should end in run/preview; Build button remains for explicit production-ish compile checks.

---

## Images

### Decision: Rebuild local images after control/serve/shared-redis changes

**Choice:** `docker build -t manav2854/control-pod:v0` / `serving-pod:v0` with `imagePullPolicy: Never`.

**Why:** Pods do not mount host source; code fixes only apply after rebuild (or image retag).

---

## Open follow-ups (not decided / not fully solved)

- Upload updated template (with `start`/`dev` host flags + `vite build`) to R2 so new projects don’t rely only on serve fallbacks.
- Groq TPM limits → retries/backoff or alternate model for planner.
- Optional: run ingress inside the cluster to use ClusterIP upstreams and drop NodePort.
- Stronger generated-code lint (auto-add missing shadcn components, sanitize Lucide imports) before validate.
- Windows `kubectl cp` path quirks — prefer exec/base64 for pod file patches.
