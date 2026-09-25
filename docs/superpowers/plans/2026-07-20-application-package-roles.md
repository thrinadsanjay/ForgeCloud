# Application package roles — Implementation Plan

> **For agentic workers:** Implement task-by-task. Checkboxes track progress.

**Goal:** Role-aware package picking (single/multi/bundle), hostname engine codes, Catalog category + role admin.

**Architecture:** Persist `ApplicationRole` + `Package.hostnameCode`; seed roles; Provision UI uses API roles; Catalog groups packages and CRUDs roles; hostname `{app}` resolves from sole selected engine code or role id.

**Tech Stack:** Prisma, Express catalogService, React ProvisionForm + CatalogAdmin

---

### Task 1: Schema + seed
### Task 2: catalogService + API
### Task 3: Hostname resolution
### Task 4: ProvisionForm UI
### Task 5: CatalogAdmin packages + roles
### Task 6: Rebuild/verify
