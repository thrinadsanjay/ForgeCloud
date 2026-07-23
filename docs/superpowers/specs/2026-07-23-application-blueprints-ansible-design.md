# Application blueprints via Ansible git + dual install (Phase 1)

**Date:** 2026-07-23  
**Status:** Approved for planning  
**Product:** Forge Private Cloud Portal

## Summary

Extend post-VM provisioning beyond OS packages so users can select **Apps** (Grafana, InfluxDB, Docker, …). Forge installs them using **Ansible roles/playbooks and/or Compose on the guest**, sourced from a **separate Ansible git repository** pinned to a commit/tag. When deploy finishes, the deployment summary shows **ready URLs** (e.g. Open Grafana → `http://{ip}:3000`).

**Packages** remain for OS tools. **Apps** are a separate provision section. Selecting an app **auto-includes** its dependencies (e.g. Grafana → Docker).

## Goals

- Dual install strategies: `ansible`, `compose`, `ansible+compose`.
- Ansible **content** lives in an external git repo; Forge stores **app metadata** in Catalog.
- Admin configures repo URL/branch/token and a **pinned revision**; **Sync** updates the pin.
- Deploys always use the pinned checkout (no floating latest).
- Auto-resolve app dependencies and show them in the provision plan.
- Health-check apps and publish `endpoints[]` on the job for Deployment Summary.
- Seed v1 apps: Docker (Ansible), Grafana + InfluxDB (Compose on Docker).

## Non-goals (Phase 1)

- Admin UI to author/edit playbook YAML inside Forge (metadata/URL/ports only).
- Deploying these apps to **remote** Docker Engines (existing Compose product stays separate).
- Always-latest branch without pin.
- Full K3s-on-VM installer (optional later blueprint).
- One-off paste/Git Compose as a custom app in the provision form (Phase 2).

## Decisions (locked)

| Topic | Choice |
|---|---|
| Architecture | Application blueprints (Approach A) |
| Install backends | Both Compose-on-VM **and** OS/Ansible roles |
| Provision UX | Keep **Packages** + add **Apps** section |
| Dependencies | Auto-include (visible in plan) |
| Playbook storage | Separate Ansible git repository |
| Repo refresh | Pinned commit/tag; admin Sync updates pin |

## Information architecture

| Surface | Behavior |
|---|---|
| Provision form | Existing packages picker + new **Apps** multi-select + plan preview (deps + URLs) |
| Deployment summary | SSH/IP as today + **Open {app}** links from `job.result.endpoints` |
| Admin → Settings / Ansible content | Git URL, branch, token, pin, Sync, last sync status |
| Admin → Catalog → Apps | Enable/disable, edit display name, ports, URL template, strategy, dep list, path into repo |
| Remote Docker / K8s tabs | Unchanged (different products) |

## Ansible content repository

### Layout (suggested)

```text
playbooks/
  initial_setup.yml          # optional: can remain in Forge image or migrate later
roles/
  initial_setup/             # optional migration
  docker/
apps/
  grafana/
    compose.yml
    defaults.yml             # ports, health path, ansible extras
  influxdb/
    compose.yml
    defaults.yml
```

Exact tree is owned by the content repo; Forge blueprints store **relative paths**.

### Forge settings

| Field | Notes |
|---|---|
| `ANSIBLE_CONTENT_GIT_URL` | HTTPS or SSH URL |
| `ANSIBLE_CONTENT_GIT_BRANCH` | Branch to Sync from |
| `ANSIBLE_CONTENT_GIT_TOKEN` | Optional; secret |
| `ANSIBLE_CONTENT_PIN` | Commit SHA or tag actually used at deploy |
| `ANSIBLE_CONTENT_LAST_SYNC_AT` | Timestamp |
| `ANSIBLE_CONTENT_LAST_SYNC_ERROR` | Last failure message |

**Sync:** fetch branch tip → update pin → shallow clone/cache under e.g. `/app/ansible-content/@{pin}`.  
**Deploy:** refuse apps that need content if pin/cache missing; run playbooks with `ANSIBLE_ROLES_PATH` / playbook paths pointing at the pin checkout.

Forge image may keep shipping a minimal built-in `initial_setup` until content repo takes over; Phase 1 can keep bootstrap playbook in-image and load **app** roles from the content repo only.

## App blueprint (Catalog)

Suggested fields:

| Field | Purpose |
|---|---|
| `id`, `name`, `description` | Display |
| `enabled` | Catalog visibility |
| `strategy` | `ansible` \| `compose` \| `ansible+compose` |
| `dependsOn` | App ids (e.g. `["docker"]`) |
| `ansiblePlaybook` / `ansibleRole` | Path under content repo |
| `composePath` | Path to compose file under content repo |
| `ports` | Published ports for docs/firewall hints |
| `healthcheck` | `{ type: "http"|"tcp", port, path?, timeoutSec }` |
| `urlTemplate` | e.g. `http://{ip}:3000` |
| `defaultVars` | Extra Ansible/Compose env (non-secret) |

**Dependency resolution:** topological order; auto-union into selected set; UI shows “Included because Grafana needs it.”

## Provision → job payload

Extend VM provision payload:

```json
{
  "packages": ["git", "curl"],
  "apps": ["grafana", "influxdb"],
  "resolvedApps": ["docker", "grafana", "influxdb"]
}
```

`resolvedApps` computed server-side (don’t trust client-only resolution).

## Deploy pipeline (VM)

1. Clone/boot + bootstrap user-data (existing Ansible-enabled path).
2. Wait for IP / SSH.
3. Run in-image (or content) `initial_setup` with **packages**.
4. Ensure content cache for **pin** exists.
5. For each app in `resolvedApps` (deps first):
   - `ansible`: `ansible-playbook` with host inventory = guest IP, extra vars (hostname, user, app defaults).
   - `compose`: ensure Docker running; copy compose from content repo to guest (or run via Ansible `community.docker`); `docker compose up -d`.
   - `ansible+compose`: role then compose.
6. Health checks; collect endpoints from URL templates + discovered IP.
7. Mark job ready with `result.endpoints` and existing creds/IP.

Failures: fail the job with step-level message; partial installs should be visible in logs (no silent success).

## Deployment summary UI

- List endpoints as primary CTAs: **Open Grafana**, **Open InfluxDB**.
- Keep SSH/IP/password section.
- Show which apps were installed (chips).

## Seed apps (Phase 1)

| App | Strategy | Depends on | URL (typical) |
|---|---|---|---|
| Docker | `ansible` | — | — (infra) |
| Grafana | `compose` or `ansible+compose` | docker | `http://{ip}:3000` |
| InfluxDB | `compose` or `ansible+compose` | docker | `http://{ip}:8086` |

## Security

- Git token stored as secret setting; never returned to UI plaintext.
- Pin recorded in audit on Sync and on deploy (`ansible_content.sync`, `app.install`).
- Guest deploy key handling remains as today for Ansible SSH.

## Open points (resolve in implementation plan)

- Whether `initial_setup` migrates into the content repo in the same phase or stays in-image.
- Compose execution: Ansible modules vs SSH `docker compose` on guest.
- Default Grafana admin password: generate + show in summary vs fixed from blueprint vars.

## Out of scope reminders

No remote-Engine app install via this path; no always-latest; no in-UI playbook editor.
