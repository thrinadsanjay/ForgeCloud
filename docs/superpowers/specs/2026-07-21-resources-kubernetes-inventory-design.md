# Resources Kubernetes inventory (Phase 1)

**Date:** 2026-07-21  
**Status:** Approved for planning (Phase 1 only)  
**Product:** Forge Private Cloud Portal

## Summary

Make **Resources** the single inventory home for both Proxmox compute and Kubernetes workloads. Use **Compute | Kubernetes** tabs. On Kubernetes, show an **expandable tree**: namespace → deployments → pods. Move create-namespace and deploy flows out of Provision “Container hosting” and **replace** that page. Non-admins can create namespaces and deployments in namespaces they can see.

**Phase 1 does not include** OpenShift-style scale/restart/logs/exec, Services/Ingress, ConfigMaps/Secrets, or YAML edit (Phases 2–3).

## Goals

- Users see VMs/LXC and K8s namespaces in one place (Resources).
- When K3s is **not configured**, Kubernetes tab shows a clear configure CTA; Compute keeps working.
- When K3s **is** configured, users expand namespaces to see deployments and nested pods.
- Non-admins: create namespace + deploy into owned/team-visible namespaces (no admin-only UI gates).
- Remove Provision hub “Container hosting”; redirect old entry points to Resources Kubernetes.

## Non-goals (Phase 1)

- Scale, rollout restart, pod logs, exec/terminal
- Services, Routes/Ingress, ConfigMaps, Secrets, YAML editor
- Showing non–Forge-managed cluster namespaces
- Changing Proxmox VM/LXC resource APIs

## Information architecture

| Surface | Behavior |
|---|---|
| `/resources` | Tabs: `compute` (default) \| `kubernetes` via `?tab=` |
| Compute tab | Existing Proxmox VM + LXC inventory (behavior unchanged) |
| Kubernetes tab | Namespace inventory + expandable deployment → pod tree; create/deploy actions |
| Provision hub | VMs/stacks only — remove Container hosting tab |
| `/containers` | Redirect → `/resources?tab=kubernetes` |
| Deep links | Optional `?ns=<name>` opens Kubernetes tab with that namespace expanded |

## Components

### `Resources.jsx` (shell)

- Page header (“Resources” / role-appropriate copy).
- Tab control: Compute | Kubernetes.
- Renders `ComputeInventory` or `KubernetesInventory`.

### `ComputeInventory`

- Extract current Resources table/filters/actions (power, console, expiry, etc.) with minimal behavior change.

### `KubernetesInventory`

- Refactor from `ContainerHosting.jsx`.
- **Unconfigured K3s:** detect existing error pattern (`K3s API URL/token is not configured`); show `EmptyState` → Settings (`/admin?tab=k3s` or `/settings` redirect). Secondary CTA optional (stay on Compute).
- **Configured, empty:** EmptyState + “New namespace”.
- **Configured, data:** Namespace rows (team, env, project, owner, status, actions).
- **Expand namespace:** fetch deployments + pods; render:
  - Deployment rows (name, ready/replicas, image, delete).
  - Under each deployment: its pods (ready, phase, restarts, node, image).
  - Unmatched pods: “Other pods” group under the namespace.
- Actions: New namespace, Deploy (into selected/expanded NS), Delete namespace (± force), Delete deployment, Refresh.
- Reuse create-namespace and deploy modals from Container Hosting.

### Provision hub

- Remove `{ id: "containers", label: "Container hosting" }` tab and `ContainerHosting` embed.
- Update any nav/copy that pointed users at Container hosting → Resources Kubernetes.

## Data flow

### Existing APIs (reuse)

- `GET /resources` — Compute
- `GET /k3s/context`
- `GET /k3s/namespaces`
- `POST /k3s/namespaces` — any authenticated user (team membership enforced when assigning a team)
- `DELETE /k3s/namespaces/:name` — owner or admin
- `GET|POST /k3s/namespaces/:name/deployments` — caller must `canSee` namespace
- `DELETE /k3s/namespaces/:name/deployments/:dep`
- `GET /k3s/namespaces/:name/pods`

### Visibility (unchanged)

Only Forge-managed namespaces (`forge` / legacy `ssp` labels). Visible if admin, owner, or member of labeled team.

### API tweak (Phase 1)

Enrich **pod list** payloads so the UI can nest pods under deployments:

- Add `deployment` (string | null): prefer Deployment ownerReference name; else common labels (`app`, `app.kubernetes.io/name`, etc.) when they match a deployment name in that namespace.
- Optionally add `containers` summary if already cheap (not required for Phase 1 tree).

No new permissions: non-admin create/deploy already allowed by current routes; UI must not hide those actions for role `user` / `approver`.

## UX details

- Expand/collapse chevrons on namespace and deployment rows; loading skeleton/spinner while children fetch.
- Destructive actions keep confirm dialogs (existing copy).
- Kubernetes empty/unconfigured states use brand-consistent EmptyState (warn tone when unconfigured).
- Compute filters/summary chips stay on Compute tab only.

## Error handling

| Condition | UI |
|---|---|
| K3s not configured | Dedicated empty state (not a red error banner) |
| Other K8s/API errors | Inline error + retry |
| Create/deploy validation | Modal field errors / toast via existing dialogs |

## Testing (manual)

1. K3s unset → Kubernetes tab configure CTA; Compute lists VMs/LXC.
2. K3s set → non-admin creates namespace, deploys workload, expands NS → deployment → pods.
3. Team member sees team namespace; outsider does not.
4. `/containers` and old Provision container tab links land on `/resources?tab=kubernetes`.
5. Admin still sees all Forge-managed namespaces.

## Future phases (out of scope now)

- **Phase 2:** Scale, rollout restart, delete polish; pod logs; exec/terminal.
- **Phase 3:** Services + Ingress/Routes; ConfigMaps/Secrets browse; YAML view/edit.

## Implementation sketch

1. Extract `ComputeInventory` from `Resources.jsx`; add tab shell + query param.
2. Refactor `ContainerHosting` → `KubernetesInventory` with expandable tree; wire pod↔deployment nesting (backend field + frontend).
3. Enrich `podView` in `backend/src/routes/k3s.js`.
4. Update `ProvisionHub`, redirects, and any deep links/copy.
5. Remove or thin unused Container Hosting page export once Resources owns it.
6. Rebuild/verify Docker image; manual test matrix above.

## Decisions log

| Topic | Decision |
|---|---|
| Layout | A (tabs) + C (expandable tree) |
| Under namespace | Both deployments and pods (nested) |
| Container hosting page | Replace — move into Resources Kubernetes |
| Approach | Resources shell + ComputeInventory + KubernetesInventory |
| Non-admin | Can create NS and deployments (visible namespaces) |
| OpenShift-like depth | Target C overall; **ship Phase 1 first** |
| K3s today | Unconfigured empty state required |
