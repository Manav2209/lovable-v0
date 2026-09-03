# Spec 5 — Security Hardening

**Status:** Proposed
**Scope:** `apps/ingress`, `apps/control` (security checker, tool surface), `apps/backend` (auth, SSE, rate limiting), `apps/orchestator` (K8s secrets)
**Repository:** `Manav2209/lovable-v0`
**Related specs:** [`spec-01-agent-react-migration.md`](./spec-01-agent-react-migration.md) §9 (tool surface — §3 below is a dependency of that stage's acceptance criteria)
**Priority:** §1–§3 are Critical; §4–§7 are High/Medium and can be scheduled more loosely.

Each section below is independently shippable — this isn't a sequential migration like Specs 1–3, it's a punch list. Order by priority, not by dependency, except where noted.

---

## 1. Ingress Admin API Authentication

**Problem:** `apps/ingress/src/index.ts` exposes `/_ingress/register`, `/_ingress/unregister`, and `/_ingress/routes` with no authentication. `register` accepts an arbitrary `upstream` string with no validation that it's a local NodePort — `proxy.ts` will proxy to whatever URL it's given, with `X-Frame-Options` forced to `ALLOWALL` and CSP stripped.

**Impact:** anyone who can reach the ingress port can enumerate every live project's internal upstream, hijack any preview slug to an attacker-controlled server (with clickjacking protection actively removed), use the ingress as an open unauthenticated SSRF-capable proxy, or DoS any preview via `/unregister`.

**Fix:**
- Require a shared-secret header (or mTLS, if the orchestrator↔ingress link already has cert infrastructure available) on all `/_ingress/*` admin routes. The orchestrator is the only legitimate caller — this doesn't need to be a general-purpose auth system, just a check that the caller is the orchestrator.
- Validate `upstream` against an allow-list at registration time: must resolve to `127.0.0.1` (or the expected internal host) plus a NodePort the orchestrator itself issued — reject anything else outright rather than trusting the caller.
- Keep this fix scoped to the admin API. Do not expand scope into a full ingress redesign (see Non-Goals) — this is a targeted auth gap, not an architecture problem.

---

## 2. Fail-Closed Prompt Safety Check

**Problem:** `apps/control/src/agent/tool/code/userGivenPromptChecker.ts` catches JSON-parse failures from the safety-check LLM call and returns `{ isSafe: true, reason: "Could not parse security check, allowing by default" }`. A security gate whose failure mode is "let it through" is a bypass waiting to be triggered — deliberately or not.

**Fix:** invert the default. On parse failure (or any error from the check itself), fail closed — reject the prompt, or route it to a stricter fallback check, not an automatic pass. Log the parse failure distinctly from an actual "unsafe" verdict so operators can tell "the checker broke" from "the checker caught something," and fix the underlying parse fragility (see spec-01 §4's note on shared JSON-extraction tooling) so this path is hit rarely regardless.

**Also verify while touching this file:** the checker's Zod schema (`z.string().min(1).max(256)`) is invoked with the raw, un-truncated user prompt. If the `tool()` wrapper validates input against the schema before calling the handler (typical LangChain behavior), any prompt over 256 characters — easy to hit with a real "build me an app that does X, Y, Z" request — would throw an uncaught validation error instead of a graceful rejection. Confirm this against the actual `tool()` behavior in use, and either raise the limit to something realistic or truncate/summarize before the check runs.

---

## 3. Remove Unrestricted Shell Execution

**Problem:** `apps/control/src/agent/tool/simple/executeCommand.ts` runs arbitrary LLM-generated shell command strings (`shell: true`) with only the working directory sandboxed — the command content itself is never validated against an allow-list or denylist. `sanitizeSubprocessEnv()` correctly strips secret-shaped env vars from the child process, but that doesn't limit what the command can otherwise do (network calls, arbitrary package installs, reading anything the pod's filesystem permissions allow).

**Fix:** this is a dependency of [`spec-01-agent-react-migration.md`](./spec-01-agent-react-migration.md) §9's tool-surface rebuild, not a separate schedule — do it there, as part of finalizing the new tool list. Concretely:
- Remove the generic `executeCommand` tool from the tool surface the ReAct agent can call.
- Replace the specific legitimate use cases it currently covers (adding a shadcn component, installing a known dependency) with narrow, parameterized tools — `addShadcnComponent({ name })`, `addDependency({ package, version })` — that validate their inputs against a known-safe set rather than accepting a free-form command string.
- If a genuine need for broader shell access surfaces later, it should be an explicit, reviewed allow-list of specific command templates, not a reintroduction of free-form `shell: true` execution.

---

## 4. Kubernetes Secrets for Pod Environment

**Problem:** `apps/orchestator/src/handler/project.ts` injects `GROQ_API_KEY`, `ACCESS_KEY_ID`, and `SECRET_ACCESS_KEY` as literal `env` values on the Deployment spec, not via `valueFrom: secretKeyRef`. They're visible in plaintext to anyone with pod-read RBAC (`kubectl get pod -o yaml`), and persisted in etcd unencrypted unless the cluster has encryption-at-rest configured.

**Scope note:** this does not affect the generated app's runtime — `sanitizeServingEnv()` already correctly strips these before spawning the Vite dev server that runs untrusted generated code. This is purely about Kubernetes API-level exposure to anyone with cluster access.

**Fix:** create real K8s `Secret` objects for these values and reference them via `secretKeyRef` in the Deployment spec instead of inlining the values. Low-risk, mechanical change — worth doing before this runs on any shared or multi-tenant cluster, but not urgent for a single-operator local setup.

---

## 5. SSE Token Handling

**Problem:** `apps/backend/src/controller/events.ts` passes the JWT as a URL query parameter for the SSE connection, and sets `Access-Control-Allow-Origin: "*"` on the response. Query-string tokens tend to end up in proxy/access logs and browser history.

**Fix:** issue a short-lived, single-use SSE ticket at connection time (a small opaque token, minted by an authenticated endpoint, valid for one SSE connection and a short TTL) instead of putting the long-lived JWT in the URL. Tighten `Access-Control-Allow-Origin` to the actual frontend origin rather than a wildcard.

---

## 6. Rate Limiting

**Problem:** no rate limiting exists on login/signup (brute-force exposure) or project creation (each call provisions a real Kubernetes Deployment — a resource-exhaustion vector even from a single legitimate-looking authenticated account).

**Fix:** add per-IP and/or per-account rate limits on `POST /auth/login`, `POST /auth/signup`, and `POST /projects` (or wherever project creation lives). Project creation in particular should have a per-user concurrent-project or creation-rate cap, since it's the one endpoint that turns directly into real infrastructure cost.

---

## 7. Auth Response Normalization

**Problem:** `apps/backend/src/controller/auth.ts` returns a distinct `EMAIL_DOESNOT_EXISTS` vs `INVALID_CREDENTIALS` on login failure, letting an attacker enumerate registered emails.

**Fix:** collapse both cases to one generic "invalid email or password" response. Low severity, cheap fix.

---

## 8. Acceptance Criteria

- `/_ingress/*` admin routes reject unauthenticated requests and validate `upstream` against an allow-list.
- The prompt safety checker fails closed on any internal error, with parse failures logged distinctly from unsafe verdicts.
- The checker's length limit is confirmed compatible with real-world prompt lengths.
- `executeCommand` (unrestricted form) is no longer reachable by the agent; its legitimate use cases are covered by narrow, validated tools.
- Pod secrets (`GROQ_API_KEY`, R2 credentials) are sourced from K8s `Secret` objects, not inline Deployment env values.
- SSE connections use a short-lived ticket, not the long-lived JWT, in the URL; CORS is scoped to the real frontend origin.
- Login/signup and project creation are rate-limited.
- Login failure responses don't distinguish "no such email" from "wrong password."

---

## 9. Non-Goals

```text
Full third-party penetration test / audit
Web application firewall
OAuth/SSO redesign of the auth system
General ingress architecture redesign
                (this spec fixes the admin-API auth gap specifically,
                 not the broader proxy/routing design)
```
