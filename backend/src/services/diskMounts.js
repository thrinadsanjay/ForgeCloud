/**
 * Additional data-disk mount helpers shared by API + provisioner.
 */

export function pathToLvName(mountPath) {
  const cleaned = String(mountPath || "")
    .trim()
    .replace(/^\/+/, "")
    .replace(/\/+/g, "_")
    .replace(/[^a-zA-Z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
  return cleaned ? `lv_${cleaned}` : "lv_data";
}

/**
 * @param {unknown} diskMounts
 * @param {number} diskGB
 * @returns {{ path: string, sizeGB: number, lv: string }[]}
 */
export function normalizeDiskMounts(diskMounts, diskGB = 0) {
  const disk = Math.round(Number(diskGB) || 0);
  const rows = Array.isArray(diskMounts) ? diskMounts : [];
  if (!rows.length) return [];

  if (disk < 2) {
    const err = new Error("Additional disk must be at least 2 GB when mount points are defined (1 GB must stay free).");
    err.status = 400;
    throw err;
  }

  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const path = String(row?.path || "").trim();
    const sizeGB = Math.round(Number(row?.sizeGB ?? row?.size_gb));
    if (!path) continue;
    if (!path.startsWith("/") || path === "/") {
      const err = new Error(`Mount point "${path}" must be an absolute path (e.g. /data), not root.`);
      err.status = 400;
      throw err;
    }
    if (seen.has(path)) {
      const err = new Error(`Duplicate mount point: ${path}`);
      err.status = 400;
      throw err;
    }
    if (!Number.isFinite(sizeGB) || sizeGB < 1) {
      const err = new Error(`Mount ${path}: size must be an integer ≥ 1 GB`);
      err.status = 400;
      throw err;
    }
    seen.add(path);
    out.push({ path, sizeGB, lv: pathToLvName(path) });
  }

  const used = out.reduce((n, m) => n + m.sizeGB, 0);
  const free = disk - used;
  if (free < 1) {
    const err = new Error(
      `Mount sizes total ${used} GB but the disk is ${disk} GB — keep at least 1 GB free (max allocatable ${disk - 1} GB).`,
    );
    err.status = 400;
    throw err;
  }
  return out;
}

/** Shape passed to Ansible initial_setup. */
export function toAnsibleDataMounts(diskMounts) {
  return (diskMounts || []).map((m) => ({
    path: m.path,
    size_gb: m.sizeGB,
    lv: m.lv || pathToLvName(m.path),
  }));
}
