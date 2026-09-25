import { getDefaultPackages, packageById, resolveInstallPkg } from "./catalogService.js";

/**
 * Split selected package IDs into cloud-init (standard apt/yum names) vs SSH-only
 * (custom installCmd scripts — e.g. agents that need a vendor repo).
 */
export function partitionPackages(packageIds = []) {
  const cloudInit = [];
  const sshOnly = [];
  const seen = new Set();

  for (const id of packageIds) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const row = packageById(id);
    if (row?.installCmd) {
      sshOnly.push({ id, name: row.name || id, installCmd: row.installCmd });
    } else {
      cloudInit.push({ id, installName: resolveInstallPkg(id) });
    }
  }

  return { cloudInit, sshOnly };
}

function yamlString(value) {
  if (value == null || value === "") return '""';
  const s = String(value);
  if (/[:#{}[\],&*?|>!%@`'"\\]/.test(s) || s.includes("\n")) {
    return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  return s;
}

/**
 * Build a #cloud-config user-data document for Proxmox cicustom.
 * @param {object} opts
 * @param {string} opts.hostname
 * @param {string} [opts.username]
 * @param {string} [opts.password]
 * @param {boolean} [opts.sudoAccess]
 * @param {string[]} opts.packageInstallNames - apt/yum package names
 * @param {string} [opts.baseYaml] - optional existing snippet to merge (multi-doc)
 */
export function buildUserData({
  hostname,
  username,
  password,
  sudoAccess = false,
  packageInstallNames = [],
  baseYaml = "",
}) {
  const lines = ["#cloud-config"];

  if (hostname) {
    lines.push(`hostname: ${yamlString(hostname)}`);
    lines.push("manage_etc_hosts: true");
    lines.push("preserve_hostname: false");
  }

  if (packageInstallNames.length) {
    lines.push("package_update: true");
    lines.push("package_upgrade: false");
    lines.push("packages:");
    for (const pkg of packageInstallNames) {
      lines.push(`  - ${yamlString(pkg)}`);
    }
  }

  if (username) {
    lines.push("users:");
    lines.push("  - default");
    lines.push(`  - name: ${yamlString(username)}`);
    lines.push("    shell: /bin/bash");
    lines.push("    lock_passwd: false");
    if (password) {
      lines.push(`    plain_text_passwd: ${yamlString(password)}`);
    }
    if (sudoAccess) {
      lines.push("    groups: [sudo, wheel]");
      lines.push("    sudo: ALL=(ALL) NOPASSWD:ALL");
    }
  }

  lines.push("ssh_pwauth: true");
  lines.push("chpasswd:");
  lines.push("  expire: false");
  lines.push("runcmd:");
  lines.push("  - |");
  lines.push("    mkdir -p /etc/ssh/sshd_config.d");
  lines.push("    printf '%s\\n' '# Forge' 'PasswordAuthentication yes' 'KbdInteractiveAuthentication yes' 'UsePAM yes' > /etc/ssh/sshd_config.d/00-forge-pwauth.conf");
  lines.push("    sed -i -E 's/^[[:space:]]*PasswordAuthentication[[:space:]]+no/PasswordAuthentication yes/I' /etc/ssh/sshd_config /etc/ssh/sshd_config.d/*.conf 2>/dev/null || true");
  lines.push("    systemctl reload sshd 2>/dev/null || systemctl reload ssh 2>/dev/null || true");

  const generated = `${lines.join("\n")}\n`;
  const base = (baseYaml || "").trim();
  if (!base) return generated;
  return `${base}\n---\n${generated}`;
}

/**
 * Minimal cloud-init for Ansible bootstrap only: service account + keys + sudo.
 * No packages — Ansible owns post-install.
 */
export function buildBootstrapUserData({
  hostname,
  serviceUser = "forge",
  servicePassword = "",
  forgePublicKey = "",
  adminPublicKey = "",
  baseYaml = "",
}) {
  const lines = ["#cloud-config"];
  if (hostname) {
    lines.push(`hostname: ${yamlString(hostname)}`);
    lines.push("manage_etc_hosts: true");
    lines.push("preserve_hostname: false");
  }

  const keys = [forgePublicKey, adminPublicKey].map((k) => String(k || "").trim()).filter(Boolean);

  lines.push("users:");
  lines.push("  - default");
  lines.push(`  - name: ${yamlString(serviceUser)}`);
  lines.push("    shell: /bin/bash");
  lines.push("    lock_passwd: false");
  lines.push("    sudo: ALL=(ALL) NOPASSWD:ALL");
  // wheel works on RHEL/SUSE; Debian/Ubuntu cloud-init maps or ignores missing groups.
  lines.push("    groups: [wheel]");
  if (servicePassword) {
    lines.push(`    plain_text_passwd: ${yamlString(servicePassword)}`);
  }
  if (keys.length) {
    lines.push("    ssh_authorized_keys:");
    for (const k of keys) lines.push(`      - ${yamlString(k)}`);
  }

  lines.push("ssh_pwauth: true");
  lines.push("chpasswd:");
  lines.push("  expire: false");
  // Cloud images may ship PasswordAuthentication no in sshd_config.d; reinforce at first boot.
  lines.push("runcmd:");
  lines.push("  - |");
  lines.push("    mkdir -p /etc/ssh/sshd_config.d");
  lines.push("    printf '%s\\n' '# Forge bootstrap' 'PasswordAuthentication yes' 'KbdInteractiveAuthentication yes' 'UsePAM yes' > /etc/ssh/sshd_config.d/00-forge-pwauth.conf");
  lines.push("    sed -i -E 's/^[[:space:]]*PasswordAuthentication[[:space:]]+no/PasswordAuthentication yes/I' /etc/ssh/sshd_config /etc/ssh/sshd_config.d/*.conf 2>/dev/null || true");
  lines.push("    systemctl reload sshd 2>/dev/null || systemctl reload ssh 2>/dev/null || true");
  lines.push("package_update: false");
  lines.push("package_upgrade: false");

  const generated = `${lines.join("\n")}\n`;
  const base = (baseYaml || "").trim();
  if (!base) return generated;
  return `${base}\n---\n${generated}`;
}

export function snippetFilename(vmid) {
  return `forge-${vmid}.yaml`;
}

export function summarizeCloudInitPackages(cloudInitEntries = []) {
  if (!cloudInitEntries.length) return "";
  return cloudInitEntries.map((p) => p.id).join(", ");
}
