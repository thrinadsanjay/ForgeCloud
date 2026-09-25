# Application Blueprints Implementation Plan

> **For agentic workers:** Implement task-by-task. Checkboxes for tracking.

**Goal:** Apps section on VM provision; install via Ansible/Compose from pinned content (bundled + optional git Sync); show ready URLs on deployment summary.

**Architecture:** Catalog `AppBlueprint` metadata; content checkout service (bundled `ansible/content` + git pin); provisioner runs apps after `initial_setup`; endpoints on `job.result`.

**Tech Stack:** Prisma, Express, Ansible CLI, Docker Compose on guest via SSH, React.

**Spec:** `docs/superpowers/specs/2026-07-23-application-blueprints-ansible-design.md`

---

## File map

| Path | Role |
|---|---|
| `ansible/content/` | Bundled roles + compose (docker, grafana, influxdb) |
| `backend/prisma/schema.prisma` | `AppBlueprint` model |
| `backend/src/services/appCatalogService.js` | CRUD, deps resolve, seed |
| `backend/src/services/ansibleContentService.js` | Pin cache, Sync from git |
| `backend/src/services/appInstallService.js` | Run ansible/compose apps on guest |
| `backend/src/services/provisioner.js` | Call app installs; set endpoints |
| `backend/src/services/settingsStore.js` | Content repo settings |
| `backend/src/routes/settings.js` + `api.js` | Sync + list apps |
| `frontend` ProvisionForm, DeploymentSummary, Settings | UX |

### Task 1: Bundled content + sync service
### Task 2: AppBlueprint schema + seed + API
### Task 3: appInstallService + provisioner hook
### Task 4: Provision UI Apps + summary URLs
### Task 5: Settings Sync UI + rebuild

Open points resolved for v1:
- `initial_setup` stays in-image; apps load from content pin
- Compose on guest via SSH `docker compose`
- Grafana admin password: generate + include in endpoint notes / job.result
