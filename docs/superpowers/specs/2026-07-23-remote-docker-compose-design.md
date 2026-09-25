# Remote Docker Compose deploy (Phase 1)

**Date:** 2026-07-23  
**Status:** Approved for planning  
**Product:** Forge Private Cloud Portal

## Summary

Let users **deploy Docker Compose stacks to remote Docker Engines** from Forge, the same way they provision VMs and Kubernetes namespaces. Admins register one or more TLS-secured Engine endpoints (scoped by team/app). Users deploy via **paste/upload** of Compose YAML or a **Git URL**. After deploy, **Resources** shows stack inventory with basic lifecycle (start / stop / down).

Implementation approach: **Compose CLI against remote Engine** (`DOCKER_HOST` + TLS) for `up`/`down`; **Engine API** for inventory and container start/stop.

## Goals

- Provisioning has a clear **Docker Compose** create path (not mixed into K8s or LXC).
- Admins register multiple Docker hosts; users pick an allowed host when deploying.
- Deploy sources: paste/upload `docker-compose.yml` (+ optional `.env`) **or** Git URL (+ branch/path).
- Jobs stream into the existing deployment monitor.
- Resources lists Compose projects and containers; supports start, stop, and project `down`.
- Audit host CRUD and compose deploy/down actions.

## Non-goals (Phase 1)

- Curated Compose catalog templates (paste + Git only)
- Image **build** from Dockerfile on the remote host
- Docker Swarm, Portainer, or per-host agents
- Per-user self-registered Engines
- Full log streaming / exec into containers (optional follow-up)
- Private Git with full SCM app integration (v1: optional token/deploy-key field on the deploy form or host; public repos work without it)

## Decisions (locked)

| Topic | Choice |
|---|---|
| Reach Engine | Docker Engine API over TCP + TLS |
| Apply Compose | CLI: `docker compose -p <project> …` with `DOCKER_HOST` + cert env |
| Compose sources | Paste/upload **and** Git URL |
| Hosts | Multiple; admin-registered; scoped by team/app (admin choice) |
| Post-deploy | Resources inventory + start / stop / `compose down` |
| Approach | A — Compose CLI + Engine API inventory |

## Information architecture

| Surface | Behavior |
|---|---|
| `/provision?tab=compose` | **Create:** pick host → source (paste/Git) → project name → deploy |
| `/resources?tab=docker` | **Inventory:** projects/containers; start / stop / down |
| Admin → Docker hosts | CRUD Engines: endpoint, TLS material, team/app tags, test connection |
| `/containers` | Unchanged (still Kubernetes provision redirect) |

Same product rule as VMs/K8s: **create under Provisioning, manage under Resources**.

Suggested Provision hub tabs after this work:

`Virtual machines` | `Kubernetes` | `Docker Compose`

Suggested Resources tabs:

`Compute` | `Kubernetes` | `Docker`

## Admin host registry

Each **Docker host** record:

| Field | Notes |
|---|---|
| `id`, `name` | Stable id + display name |
| `endpoint` | e.g. `tcp://docker01.lab:2376` |
| `tlsCa`, `tlsCert`, `tlsKey` | Stored encrypted like other secrets; required in Phase 1 |
| `teamTags` / `appTags` | Optional; used to filter which users may target the host |
| `enabled` | Soft disable without deleting |
| `createdAt` / `updatedAt` | Audit |

**Test connection:** backend probes Engine (`/_ping` or equivalent) with the host’s TLS material; UI shows Healthy / Unreachable / Unconfigured.

**Visibility:** admins see all hosts; end users only hosts matching their team/app (or all enabled hosts if tags empty — exact matching rules follow existing Forge team/group patterns where possible).

## Deploy flow

1. User opens **Provisioning → Docker Compose**.
2. Selects an allowed **host**, enters **project name** (Compose project `-p`; validated: lowercase, `[a-z0-9_-]`).
3. Chooses source:
   - **Paste / upload:** `docker-compose.yml` (required) + optional `.env` text.
   - **Git:** URL, optional branch/ref, optional path to compose file (default `docker-compose.yml` / `compose.yaml`).
4. Submit creates a **job**; workdir is prepared (write files or shallow clone).
5. Job runs approximately:

   ```bash
   docker compose -p <project> -f <file> [--env-file .env] up -d
   ```

   with `DOCKER_HOST` and TLS files/env derived from the host record.
6. Job logs stream to the deployment monitor; success records project name + host id for inventory linkage.

**Idempotency:** redeploying the same project name on the same host is `compose up -d` (reconcile). Destructive reset is **Down**, not silent recreate-all unless we add an explicit “recreate” later.

## Resources inventory & lifecycle

- List **Compose projects** discovered via Engine labels (`com.docker.compose.project`), grouped by host the viewer can access.
- Expand project → containers (name, image, state, published ports).
- Actions:
  - **Start / stop** individual containers (Engine API).
  - **Down** entire project (`docker compose -p <project> down` with same host TLS context; confirm dialog).
- Empty / unconfigured: CTA to Admin Docker hosts (admins) or “no hosts available” (users).

## Platform / runtime

- Forge container image installs **Docker CLI + Compose plugin** (client only; no local dockerd required).
- Per-job TLS material written to a private temp dir (or env file) and cleaned up after the job.
- Workdirs for paste/Git live under a controlled jobs directory; Git clones are shallow and cleaned on success/failure policy (retain on failure for debug optional).
- Failures: non-zero compose exit + stderr in job log; API returns clear errors for bad TLS / unreachable host.

## APIs (sketch)

| Method | Path | Purpose |
|---|---|---|
| `GET/POST/PATCH/DELETE` | `/api/admin/docker-hosts` | Host CRUD (admin) |
| `POST` | `/api/admin/docker-hosts/:id/test` | Connectivity probe |
| `GET` | `/api/docker/hosts` | Hosts visible to current user |
| `POST` | `/api/docker/compose/deploy` | Start deploy job (hostId, project, source) |
| `GET` | `/api/docker/projects` | Inventory across visible hosts |
| `POST` | `/api/docker/projects/:hostId/:project/down` | Compose down |
| `POST` | `/api/docker/containers/:hostId/:id/{start,stop}` | Container lifecycle |

Exact shapes follow existing Forge job + settings patterns.

## Audit

- `docker_host.create` / `update` / `delete`
- `compose.deploy` / `compose.down`
- `container.start` / `container.stop` (Docker remote; distinct from Proxmox LXC where needed)

## Out of scope reminders

No Swarm, no Portainer bridge, no agent install, no catalog templates, no remote image build in Phase 1.

## Open points (resolve in implementation plan if needed)

- Exact team/app tag matching vs existing group store
- Whether optional Git token is per-deploy, per-host, or Settings-global
- Whether `compose down` removes volumes by default (`-v` off unless checkbox)
