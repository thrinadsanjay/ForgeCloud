# Forge custom Ansible content pack

Use this layout for **additional** blueprints (git repo or host mount).
Bundled Forge stacks stay in the app image; your pack is an overlay.

## Layout

```text
catalog.yaml                 # required — blueprints to auto-onboard
playbooks/
  example-stack.yml
roles/
  example_stack/
    tasks/main.yml
    defaults/main.yml
apps/                        # optional compose stacks
  example-app/
    compose.yml
```

## catalog.yaml

```yaml
blueprints:
  - id: example-stack
    name: Example Stack
    description: Sample Forge blueprint
    enabled: true
    strategy: ansible          # ansible | compose | ansible+compose
    ansiblePlaybook: playbooks/example-stack.yml
    dependsOn: []
    ports: [8080]
    healthcheck:
      type: tcp
      port: 8080
      timeoutSec: 90
    urlTemplate: "http://{ip}:8080"
    defaultVars:
      category: Custom
      components: [Example]
      eta: 5–8 min
    sortOrder: 500
```

## Playbook rules

- Target inventory group: `guests`
- Use `become: true` when installing system packages
- Roles resolve from this pack first, then Forge bundled roles

## Wire into Forge

1. Put this tree in a git repo **or** a directory mounted into the Forge container
2. Admin → Automation → Ansible → set git URL (Sync) **or** mount path
3. Forge onboards blueprints from `catalog.yaml` as **Custom**
4. Clear git URL / mount path to offboard custom blueprints only
