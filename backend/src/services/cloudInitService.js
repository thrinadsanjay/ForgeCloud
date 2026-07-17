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
