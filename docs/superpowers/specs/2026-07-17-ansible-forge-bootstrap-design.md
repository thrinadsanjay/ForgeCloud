# Ansible-on-Forge guest bootstrap — Design

**Date:** 2026-07-17  
**Status:** Approved for implementation  
**Scope:** Linux guests (Debian, Ubuntu, RHEL/Rocky/Alma, SUSE). Windows deferred.

## Goals

- Run Ansible **only on the Forge server/container** (controller).
- Replace cloud-init + SSH shell installs for packages/users/post-install.
- Reliable SSH bootstrap via service account + keys; mapping creds as fallback.
- Cross-distro `initial_setup` role driven by request vars.

## Non-goals (MVP)

- Windows guests
- External AAP/Tower (existing INTERNAL_LINUX_ANSIBLE settings unchanged)
- Replacing Proxmox network assignment

## Architecture

```
Clone → network → start → IP (qemu-agent) → SSH up
  → try mapping user/password
  → else service account + Forge private key
  → ansible-playbook initial_setup.yml (vars from request)
  → validations
  → optional: remove Forge pubkey from authorized_keys
```

### Bootstrap (dual)

1. **Cloud-init supported:** Forge uploads minimal user-data (service user, optional password, Forge pubkey + admin pubkey, sudo NOPASSWD). No packages.
2. **Else:** Assume service account + Forge pubkey already baked into the template.

### Admin settings (`ANSIBLE_*`)

| Key | Purpose |
|-----|---------|
| `ANSIBLE_ENABLED` | Use Ansible path instead of SSH package install |
| `ANSIBLE_SERVICE_USER` | Service account name (default `forge`) |
| `ANSIBLE_SERVICE_PASSWORD` | Optional break-glass password |
| `ANSIBLE_ADMIN_PUBKEY` | Org public key kept on guest |
| `ANSIBLE_FORGE_PRIVATE_KEY` | Deploy private key (Forge secret) |
| `ANSIBLE_FORGE_PUBLIC_KEY` | Deploy public key injected at bootstrap |
| `ANSIBLE_REMOVE_FORGE_KEY` | Remove Forge pubkey after successful setup (default true) |
| `ANSIBLE_BOOTSTRAP_CLOUDINIT` | Emit minimal cloud-init for service account (default true) |

### Role: `initial_setup`

Vars (JSON/YAML from Forge):

- `hostname`, `create_users[]`, `packages[]`, `repositories[]`, `mounts[]`
- `remove_forge_key`, `forge_pubkey`, `ssh_pwauth` (optional)

OS families via Ansible facts: `Debian`, `RedHat`, `Suse`.

## Security

- Private key never written into guest images; only temp file on Forge for the run.
- Prefer key auth; password optional.
- After success, drop Forge deploy key when configured.

## Fallback

If `ANSIBLE_ENABLED` is false or Ansible binary missing → keep legacy cloud-init/SSH path.
