# Ansible-on-Forge Bootstrap Implementation Plan

> **For agentic workers:** Implement task-by-task. Steps use checkbox syntax.

**Goal:** Ship Forge-as-Ansible-controller with a multi-distro `initial_setup` role and wire it into VM provisioning when enabled.

**Architecture:** Ansible + roles live in-repo under `ansible/`. Forge backend spawns `ansible-playbook` after SSH is reachable. Settings store controller secrets and service-account bootstrap options.

**Tech Stack:** Ansible (Alpine package), Node.js child_process, existing provisioner + settingsStore.

---

### Task 1: Ansible project + initial_setup role

**Files:**
- Create: `ansible/ansible.cfg`, `ansible/playbooks/initial_setup.yml`, `ansible/roles/initial_setup/**`

- [x] Cross-distro tasks for packages, repos, users, mounts, hostname, optional Forge key removal
- [x] Windows excluded

### Task 2: Docker + ansibleService

**Files:**
- Modify: `Dockerfile`
- Create: `backend/src/services/ansibleService.js`

- [x] Install ansible/openssh-client in runtime image
- [x] Copy `ansible/` into image
- [x] Runner writes inventory + extras + optional key file, captures stdout/stderr

### Task 3: Settings + provisioner hook

**Files:**
- Modify: `backend/src/services/settingsStore.js`, `backend/src/services/provisioner.js`, `backend/src/services/cloudInitService.js`

- [x] ANSIBLE_* settings group
- [x] When enabled: after SSH, run initial_setup; skip SSH package installs on success
- [x] Minimal cloud-init bootstrap mode for service account + keys
