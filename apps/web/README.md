# web

Product frontend for Lovable — auth, create project, workspace chat + preview.

## Run

```bash
# from repo root
bun install
bun run --filter web dev
```

Opens at http://127.0.0.1:5173 and proxies `/api` → `http://127.0.0.1:4000`.

## Routes wired

| UI | Backend |
|----|---------|
| Signup | `POST /api/v1/auth/signup` |
| Login | `POST /api/v1/auth/login` |
| Create project | `POST /api/v1/project` |
| Project list | `GET /api/v1/projects` |
| Workspace | `GET /api/v1/project/:id` |
| Follow-up | `POST /api/v1/project/conversation/:id` |
| Build | `POST /api/v1/project/:id/build` |
| Run preview | `POST /api/v1/project/:id/run` |
