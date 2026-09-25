# Catalog & SSO admin guide

Short reference for Forge admins configuring **Packages**, **App roles**, **Hostname** patterns, and **OIDC SSO**.

## Packages

**Where:** Admin → Catalog → Packages

Software users can install at provision time.

| Concept | Meaning |
|--------|---------|
| **ID** | Stable catalog key (e.g. `postgres`). Used in APIs and App role options. |
| **Display name** | Label in pickers (e.g. PostgreSQL). |
| **OS package** | apt/yum name when it differs from the ID. Blank = install using the ID. |
| **Hostname code** | Short `{app}` token when this package is the sole role pick (e.g. `psql`). Must be **unique**. |
| **Default** | Always installed; users cannot uncheck it. |
| **Description** | Optional blurb on cards and provision tooltips. |

**Tips**

- Group by category; collapse unused sections.
- Do not remove a package that is still listed on an App role — remove it from the role first.

## App roles

**Where:** Admin → Catalog → App roles

Controls the Provision **Application** dropdown and which packages appear under “For this role”.

| Mode | Behavior |
|------|----------|
| **Single** | Pick one option (e.g. DB engine). Optional “allow multi override”. |
| **Multi** | Checkboxes for several options. |
| **Bundle** | All options install together (e.g. docker + compose); not individually toggled. |
| **Suggest** | Options pre-checked; user can change them. |

**Rules enforced on save**

- Enabled roles need **at least one** package option.
- Every option must be an **existing, enabled** package ID.
- Default option (if set) must be one of the role options.
- Role IDs: start with a letter; `a-z`, `0-9`, `_`, `-` (max 32).

Saving or deleting a role **syncs** hostname `{app}` options to match enabled role IDs.

## Hostname format

**Where:** Admin → Catalog → Hostname

Pattern used when Forge Assist or Provision invents a hostname.

Typical pattern: `{os}-{app}-{rand4}`

| Token | Meaning |
|-------|---------|
| `{os}` | OS / template slug |
| `{app}` | Application role id, or a package hostname code when exactly one coded engine is selected |
| `{kind}` | `vm`, `ct`, or `stack` |
| `{user}` | Requester username |
| `{env}` / `{envFull}` | Environment short / full |
| `{rand4}` / `{n}` | Random or sequential |

**Application options** are the values allowed for `{app}` chips / suggestions.

- Prefer **Sync from App roles** so the list matches Catalog → App roles.
- Manual edits are allowed; the UI warns when out of sync.

## OIDC SSO

**Where:** Admin → Integrations → OIDC SSO

Wizard: **Provider → Credentials → Redirect URI → Test login**.

**Provider presets** fill a typical issuer URL (edit placeholders like `{tenant}` before saving):

- Cloud: Microsoft Entra ID, Google Workspace, Okta, Auth0, Amazon Cognito  
- Enterprise: Keycloak, AD FS, LDAP/AD via Keycloak/Dex, PingOne, OneLogin, JumpCloud  
- Other: GitLab, Custom

Classic LDAP/AD is **not** OIDC by itself — use AD FS, Entra, or an OIDC bridge (Keycloak / Dex).

After saving, **restart the backend** so SSO takes effect. Keep a local admin account in case SSO is misconfigured.

## Catalog validation banner

On Packages and App roles, Forge shows a banner when it detects:

- Duplicate hostname codes  
- Roles with empty options (while enabled)  
- Unknown or disabled packages referenced by roles  
- Invalid default option IDs  

Fix the listed items, then click **Refresh** on the banner (or reload the page).
