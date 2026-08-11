# Lovable system flow

End-to-end flow for local hybrid development: host processes (web, backend, orchestrator, ingress, Redis port-forward) + Kubernetes project pods (control + serving).

## High-level architecture

```text
Browser (web :5173)
    │  /api → backend :4000
    │  preview Host → ingress :8080
    │
    ├─► backend ──Redis streams──► orchestrator (host)
    │                                   │
    │                                   ├─ create K8s Deployment/Service(NodePort)/Ingress
    │                                   └─ publish orch:control / orch:serve
    │
    └─► apps/ingress :8080
            └─ proxy → http://127.0.0.1:<NodePort>  (Docker Desktop)

K8s pod (per project)
  ├─ control :3001  (agent + SSE health, Redis pub/sub for live events)
  └─ serving :3000  (Vite preview)
         │
         Redis ◄── port-forward svc/redis 6379:6379 (host apps use localhost)
```

## Redis streams (message bus)

| Stream | Direction | Purpose |
|--------|-----------|---------|
| `backend:orch` | backend → orchestrator | CREATE_PROJECT, PROJECT_BUILD, PROJECT_RUN, PROMPT |
| `orch:backend` | orchestrator → backend | INITIALIZED / BUILD_* / RUN_* / PROMPT_RESPONSE / FAILED |
| `orch:control` | orchestrator → control | PROJECT_INITIALIZED, PROJECT_BUILD, PROMPT |
| `control:orch` | control → orchestrator | BUILD_*, PROMPT_RESPONSE, FAILED |
| `control:serving` | control → serving | PROJECT_INITIALIZED, PROJECT_RUN |
| `serving:control` | serving → control | init confirmation |
| `orch:serve` | orchestrator → serving | PROJECT_RUN |
| `serve:orch` | serving → orchestrator | PROJECT_CREATED, RUN_*, FAILED |
| `preview:register` | serving/orch → ingress | register preview upstream |
| Pub/sub `agent:sse:{projectId}` | control/serving → backend | live agent + preview_ready events |

### Consumer group rule

Control and serving pods use **per-project** consumer groups:

- `control-{projectId}`
- `serve-{projectId}`

Groups start at `$` (new messages only). Shared groups load-balance across pods and steal work.

## Create project flow

```text
1. Web POST /api/v1/project { prompt }
2. Backend inserts DB row + conversationHistory
3. Backend → Redis CREATE_PROJECT (includes prompt)
4. Backend waits (responseManager) for PROJECT_INITIALIZED (~120s)

5. Orchestrator:
   a. Create NodePort Service (host can reach preview via localhost:nodePort)
   b. Create Deployment (control + serving), wait Ready (control /health:3001)
   c. Create optional K8s Ingress object (may be unused locally — no nginx controller)
   d. Store pendingInitialPrompts[projectId] = prompt
   e. Publish PROJECT_INITIALIZED → orch:control

6. Control:
   a. Pull template from R2 into /app/shared/{projectId}
   b. Notify serving (control:serving PROJECT_INITIALIZED)
   c. Wait for serving confirmation

7. Serving:
   a. Verify workspace files exist
   b. Ack serving:control + publish PROJECT_CREATED → serve:orch

8. Orchestrator:
   a. Forward PROJECT_INITIALIZED → orch:backend (unblocks create HTTP)
   b. After ~2.5s, auto handlePrompt(initialPrompt)

9. Web navigates to /project/:id and opens SSE:
   GET /api/v1/project/:id/events?token=...
```

## Initial prompt / agent flow

```text
1. Orchestrator → orch:control PROMPT
2. Control processPrompt:
   a. Publish PROMPT_RESPONSE early (SSE URL marker)
   b. Backend rewrites SSE to /api/v1/project/:id/events?token=...
   c. Run LangGraph workflow:
        prompt check → context → analyze → enhance → plan
        → execute tools → stitchApp → validate/build → fix loop
        → save → run (notify serving) → summarize
   d. Agent events published on agent:sse:{projectId}
3. stitchApp (deterministic):
   - If components exist under src/components (excl. ui) / src/pages
     and App.tsx still Hello World / missing imports → rewrite App.tsx
4. runNode → control:serving PROJECT_RUN
5. Serving serveTheProject:
   - Skip bun install if node_modules present
   - Start Vite: bun x vite --host 0.0.0.0 --port 3000 --strictPort
   - Wait for HTTP readiness on 127.0.0.1:3000
   - Register preview (Redis + HTTP to host.docker.internal:8080)
   - Publish PROJECT_RUN_SUCCESS + preview_ready SSE
6. Orchestrator on RUN_SUCCESS:
   - registerHostIngressRoute(projectId) → localhost:NodePort
```

## Manual build / run (workspace buttons)

```text
Build: Web → backend PROJECT_BUILD → orch → control bun install + bun run build
       (template build script is `vite build`; waits up to ~10 min)

Run:   Web → backend PROJECT_RUN → orch → serving Vite on :3000
       → ingress register localhost:NodePort
```

## Preview URL shape

```text
http://proj-{sanitized-uuid}.preview.localhost:8080
```

- Browser → host `apps/ingress` on `:8080`
- Ingress looks up slug → upstream `http://127.0.0.1:<NodePort>`
- NodePort maps to serving container port `3000`

## Live status (SSE)

```text
Browser EventSource
  → Vite proxy /api → backend :4000
  → GET /api/v1/project/:id/events?token=JWT
  → Redis SUBSCRIBE agent:sse:{projectId}
  ← control sendSSEMessage / serving preview_ready
```

Control’s in-pod SSE on `:3001` is for health/readiness; the browser never dials pod localhost.

## Local prerequisites

1. Redis in cluster: `kubectl create deployment redis ...` + `kubectl expose ...`
2. Host Redis access: `kubectl port-forward svc/redis 6379:6379`
3. Running on host: backend, orchestrator (`SKIP_K8S=false`), ingress, web
4. Images present locally: `manav2854/control-pod:v0`, `manav2854/serving-pod:v0` (`imagePullPolicy: Never`)
5. `POD_REDIS_URL=redis://redis.default.svc.cluster.local:6379` for pods (orchestrator `.env`)

## Failure points (quick map)

| Symptom | Likely cause |
|---------|----------------|
| Create TIMEOUT | Pod not Ready / Redis URL wrong in pod / init slow |
| Control ECONNREFUSED Redis | Pod got `localhost` Redis instead of in-cluster service |
| Build TIMEOUT then SUCCESS | Install+build > waiter; history was also replayed before `$` groups |
| Run “No start script” | Template has `dev`/`preview` only — serve must fall back |
| Run timeout | Long `bun install` — skip if `node_modules` exists |
| BAD_GATEWAY preview | Upstream was `*.svc.cluster.local` from host ingress |
| Hello World only | Components created but App.tsx not stitched |
| sse_error | Browser hit `localhost:3001` in pod — use backend events proxy |
| Plan / agent 429 | Groq rate limit |
| Build FAILED (tsc) | Generated unused imports / fake Lucide icons / missing ui pieces |
