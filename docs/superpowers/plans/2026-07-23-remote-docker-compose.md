# Remote Docker Compose Implementation Plan

> **For agentic workers:** Implement task-by-task. Steps use checkbox syntax.

**Goal:** Deploy Compose stacks to admin-registered remote Docker Engines (TLS) from Provisioning; inventory + start/stop/down under Resources.

**Architecture:** Prisma `DockerHost` store; Compose CLI with `DOCKER_HOST`+TLS for up/down; Engine HTTP API for ping/inventory/container lifecycle; jobs via existing `jobStore` + deployment monitor.

**Tech Stack:** Express, Prisma, Node https, docker CLI + compose plugin, React.

**Spec:** `docs/superpowers/specs/2026-07-23-remote-docker-compose-design.md`

---

## File map

| Path | Role |
|---|---|
| `backend/prisma/schema.prisma` | `DockerHost` model |
| `backend/src/services/dockerHostStore.js` | CRUD + hydrate + visibility |
| `backend/src/services/dockerService.js` | TLS ping, list projects, start/stop, compose CLI |
| `backend/src/services/provisioner.js` | `runComposeJob` |
| `backend/src/routes/docker.js` | User + admin API |
| `backend/src/server.js` | Mount routes |
| `backend/src/bootstrap.js` | Hydrate hosts |
| `Dockerfile` | `docker-cli` + compose plugin |
| `frontend/src/api/client.js` | API helpers |
| `frontend/src/pages/DockerHostsAdmin.jsx` | Admin CRUD |
| `frontend/src/pages/ComposeProvision.jsx` | Deploy UI |
| `frontend/src/pages/DockerInventory.jsx` | Resources inventory |
| `frontend/src/pages/ProvisionHub.jsx` / `Resources.jsx` / `Admin.jsx` | Tabs |

### Task 1: Schema + host store
### Task 2: dockerService + compose job
### Task 3: API routes
### Task 4: Dockerfile CLI
### Task 5: Frontend admin + provision + inventory + wiring
### Task 6: Rebuild + smoke check

Open points resolved for v1:
- Empty `teamTags` → visible to all authenticated users
- Git token: optional per-deploy field
- `compose down` without `-v` by default
