# Forge Ansible blueprints (bundled content)

Built-in stacks always remain available. Optional **custom** content (git URL or
container mount) is an overlay: playbooks/roles resolve from custom first, then
bundled. Custom blueprints are auto-onboarded from `catalog.yaml` and tagged
**Custom** in the catalog. Clearing git URL and mount path offboards Custom only.

Download a starter pack from Admin → Automation → Ansible → **Download content template**.

## Bundled layout

```text
playbooks/                 # entrypoints referenced by Catalog blueprints
  docker.yml
  k3s.yml
  …
roles/
  docker/
  k3s/
  …
apps/                      # Compose-on-guest stacks
  portainer/
  …
```

## Custom overlay layout

```text
catalog.yaml               # required for auto-onboard
playbooks/
roles/
apps/                      # optional
```

See `ansible/content-template/` for a complete example.

## Inventory

Forge injects a temporary inventory with group `guests` and passes
`forge_service_user` plus blueprint `defaultVars`. Roles path is
`custom/roles:bundled/roles` when an overlay is active.
