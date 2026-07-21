# Application roles & package selection — design

**Date:** 2026-07-20  
**Status:** Approved — implementing  
**Product:** Forge (PrivateCloud)

## Problem

Selecting an **Application** role (e.g. Database) today auto-checks every package listed for that role in `frontend/src/data/applicationProfiles.json`. For `db` that means PostgreSQL + MySQL + MongoDB together — rarely desirable on one VM.

## Goals

1. Application role **filters and guides** package choice; does not blindly install all peer engines.
2. Same model for **all** application roles (web, db, docker, api, …), now and when new roles/packages are added.
3. **Bundles** (e.g. docker + docker-compose) auto-select related packages.
4. **Peer choices** (e.g. DB engines) use single-select by default; optional multi with an explicit override.
5. Hostname `{app}` reflects a chosen engine short code when exactly one engine is selected; stays the role id (e.g. `db`) when multiple or none.
6. Catalog admin can **categorize packages**, group the package list, and configure role selection modes / bundles.

## Non-goals (MVP)

- ML / auto-categorization beyond simple id-based suggestions.
- Hard API rejection of multi-DB installs.
- Per-template role overrides.
- Remembering last engine per user (nice-to-have later).

---

## Decisions (locked)

| Topic | Decision |
|-------|----------|
| Approach | Role filters options; Additional software lists the rest (Approach A) |
| Multi-DB | **Single engine by default**; “Allow multiple engines” toggle for that request |
| Multi-DB hostname | `{app}` stays **`db`** when 2+ engines selected |
| Single-engine hostname | `{app}` = package `hostnameCode` (e.g. `psql`, `mdb`, `msql`, `odb`) |
| Scope | All application roles, not only Database |
| Catalog | Category required (or Uncategorized); group UI; configure single/multi/bundle/suggest per role |

---

## Data model

### Package (extend existing `Package`)

| Field | Type | Purpose |
|-------|------|---------|
| `category` | string (existing) | Grouping in Catalog + Additional software |
| `hostnameCode` | string? **new** | Short code for `{app}` when this package is the sole role pick (e.g. `psql`) |
| `dependsOn` | string[]? **new** (JSON or join) | Hard dependencies — checking this checks deps |
| `suggestWith` | string[]? **new** | Soft companions — e.g. compose with docker; often-used-with chips |

MVP may store `dependsOn` / `suggestWith` as JSON on the package row or only on the **role** definition; prefer role-level for bundles and package-level for hostnameCode + category.

### Application role (new store; replace static frontend-only JSON)

```json
{
  "id": "db",
  "label": "Database",
  "selection": "single",
  "allowMultiOverride": true,
  "defaultOptionId": "postgres",
  "options": ["postgres", "mysql", "mongodb", "oracledb"]
}
```

| `selection` | Behavior |
|-------------|----------|
| `single` | One option among `options` (radio); optional `allowMultiOverride` → checkboxes |
| `multi` | Checkboxes among `options`; none pre-checked unless `defaultOptionId` / defaults list |
| `bundle` | Auto-check all `options` (or `packages`) when role selected |
| `suggest` | Soft defaults (pre-check light set or none); user freely changes |

Seed roles:

| id | selection | allowMulti | default | options |
|----|-----------|------------|---------|---------|
| db | single | true | postgres | postgres, mysql, mongodb (+ oracledb if in catalog) |
| docker | bundle | — | — | docker, docker-compose |
| cache | bundle/single | — | redis | redis |
| queue | bundle/single | — | rabbitmq | rabbitmq |
| web | multi | — | — | nginx, nodejs |
| api | multi | — | — | nodejs, nginx, git |
| worker | multi | — | — | nodejs, git |
| app | suggest | — | — | git, curl |

Hostname application list stays aligned with role ids (`web`, `db`, …).

### Hostname short codes (seed)

| package id | hostnameCode |
|------------|--------------|
| postgres | psql |
| mysql | msql |
| mongodb | mdb |
| oracledb | odb |

---

## Hostname `{app}` resolution

Input: selected application role id + selected role package ids.

```
if role has exactly one selected option with hostnameCode:
  app = hostnameCode
else:
  app = role.id   // e.g. "db" when 0 or 2+ engines
```

Regenerate suggested hostname when role or sole engine changes (existing “user didn’t edit hostname” behavior).

---

## Provision UI

1. **Application** dropdown — role list from Catalog/API (fallback to seed).
2. **For this role** (when role selected):
   - `single`: radios (+ “Allow multiple …” toggle when `allowMultiOverride`).
   - `multi`: checkboxes for role options only.
   - `bundle`: show checked chips; note “Selected together as a set”.
   - `suggest`: light pre-check or empty with hint.
3. Soft warning if multi-DB (2+ engines).
4. Optional size nudge if 2+ DB engines and Micro/Mini.
5. **Additional software** — catalog packages **not** in the current role’s option set, grouped by category (reuse/extend PackagePicker).
6. Locked 🔒 org defaults remain above; cannot be removed.

### Selection lifecycle

- Change Application → remove packages that belonged only to the previous role’s option set; keep Additional + locked.
- Final `packages[]` = unique(locked ∪ rolePicks ∪ additionalPicks).
- Payload still sends `application` = role id (`db`), not the engine code (engine affects hostname via `{app}` only).

---

## Catalog admin UI

### Software packages

- List **grouped by category** (Uncategorized last).
- Columns/fields: name, id, category, hostnameCode, isDefault, enabled, install pkg/cmd, dependsOn/suggestWith (as available).
- **New package:** require category (dropdown of known categories + “Uncategorized”); optional hostnameCode.
- Suggest category from known id maps on create; admin confirms.

### Application roles (new section or tab under Catalog)

- CRUD roles (id, label, selection mode, options, default, allowMultiOverride).
- Assign packages from categorized catalog.
- New roles appear in Provision Application dropdown and hostname `{app}` role list when enabled.

### Future packages / roles

- Adding a package does **not** auto-attach to a role; admin assigns to role options (or leaves Additional-only).
- Adding a role requires selection mode + at least one option for non-empty “For this role” panel.

---

## API / backend

- Persist roles (Prisma model e.g. `ApplicationRole` or JSON in settings/catalog table).
- Extend Package with `hostnameCode` (and optional dependency JSON).
- Endpoints: list roles for Provision; admin CRUD packages/roles (extend existing admin catalog routes).
- `suggestHostname` / `buildHostname` accept `application` + optional `applicationPackages` or resolve code server-side from selected packages.
- Seed: migrate away from frontend-only `applicationProfiles.json` as source of truth (keep file only as fallback or remove after API wired).

---

## Seed hostname codes & categories

Align package `category` with existing Provision picker buckets where possible:

- Databases & cache, Containers & orchestration, Languages & runtimes, etc.

Clear any leftover “install all DBs” behavior from static profiles.

---

## UX copy (examples)

- Role panel: “Choose software for this role. You can add more under Additional software.”
- DB multi toggle: “Allow multiple database engines on this server”
- Multi warning: “Unusual on one VM — fine for labs or migration; prefer one engine in production.”
- Bundle: “These packages are installed together.”

---

## Success criteria

- Selecting Database does **not** check all engines; default single (Postgres) or none until pick — per seed `defaultOptionId`.
- User can enable multi and install 2+ DBs; `{app}` remains `db`.
- One engine → hostname uses `psql` / `mdb` / `msql` / `odb`.
- Docker role auto-selects docker + docker-compose.
- Additional software shows non-role packages by category.
- Catalog shows categories, grouping, and role configuration.
- New catalog packages can be categorized; roles remain admin-configured.

## Open follow-ups (post-MVP)

- localStorage last engine
- `dbx` style hostname for multi (rejected for MVP — stay `db`)
- Auto-attach new packages to roles by category heuristic
