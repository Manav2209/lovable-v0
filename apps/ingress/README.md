# ingress

Host-based preview reverse proxy for Lovable project apps.

## URL shape

```
http://{slug}.preview.localhost:8080
```

`slug` is `proj-` + sanitized project id (same as K8s service name).

## Run

```bash
# Local smoke (no Redis required)
INGRESS_SKIP_REDIS=true bun run apps/ingress/src/index.ts

# With Redis registration stream
bun run --filter ingress dev
```

## Register a route

```bash
curl -X POST http://127.0.0.1:8080/_ingress/register \
  -H "Content-Type: application/json" \
  -d '{"projectId":"demo-uuid","upstream":"http://127.0.0.1:3000"}'
```

Then open (or curl with Host):

```bash
curl -H "Host: proj-demo-uuid.preview.localhost" http://127.0.0.1:8080/
```

## Admin

| Path | Method | Purpose |
|------|--------|---------|
| `/_ingress/health` | GET | Liveness |
| `/_ingress/routes` | GET | List routes |
| `/_ingress/register` | POST | `{ projectId, upstream, slug? }` |
| `/_ingress/unregister` | POST | `{ projectId }` or `{ slug }` |

## Env

| Var | Default | Meaning |
|-----|---------|---------|
| `INGRESS_PORT` / `PORT` | `8080` | Listen port |
| `PREVIEW_DOMAIN` | `preview.localhost` | Host suffix |
| `REDIS_URL` | `redis://localhost:6379` | Register stream |
| `INGRESS_SKIP_REDIS` | — | `true` to skip Redis listener |
