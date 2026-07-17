import * as pve from "./proxmoxService.js";
import { allExpiries } from "./expiryStore.js";
import { getOwner } from "./ownershipStore.js";
import { logAudit } from "./auditService.js";

const CHECK_INTERVAL_MS = Number(process.env.EXPIRY_CHECK_INTERVAL_MS || 5 * 60 * 1000);

// Hard power-off an expired guest. Prefer stop (immediate); fall back to ACPI
// shutdown if stop fails (e.g. guest already transitioning).
async function powerOffExpired(vmid, kind) {
  if (kind === "vm") {
    try {
      await pve.stopVm({ vmid });
      return "stop";
    } catch {
      await pve.shutdownVm({ vmid });
      return "shutdown";
    }
  }
  try {
    await pve.stopContainer({ vmid });
    return "stop";
  } catch {
    await pve.shutdownContainer({ vmid });
    return "shutdown";
  }
}

// One sweep: find resources whose expiry has passed and that are still running,
// then power them off. Start is blocked while expired — owners must request a
// renew (approved by admin/approver) before power-on is allowed again.
async function sweep() {
  const expiries = allExpiries();
  const now = Date.now();
  const expiredVmids = Object.entries(expiries)
    .filter(([, rec]) => new Date(rec.expiresAt).getTime() <= now)
    .map(([vmid]) => Number(vmid));

  if (expiredVmids.length === 0) return;

  let vms = [];
  let cts = [];
  try {
    [vms, cts] = await Promise.all([pve.listAllVms({}), pve.listAllContainers({})]);
  } catch (err) {
    console.error("[expiryEnforcer] could not list resources:", err.message);
    return;
  }

  const byVmid = new Map();
  for (const v of vms) byVmid.set(v.vmid, { ...v, kind: "vm" });
  for (const c of cts) byVmid.set(c.vmid, { ...c, kind: "container" });

  for (const vmid of expiredVmids) {
    const resource = byVmid.get(vmid);
    if (!resource || resource.status !== "running") continue;

    try {
      const method = await powerOffExpired(vmid, resource.kind);
      console.log(`[expiryEnforcer] powered off expired ${resource.kind} ${vmid} via ${method}`);
      logAudit({
        actor: { username: "system", role: "system" },
        action: "resource.expire",
        target: `VMID ${vmid}`,
        status: "success",
        detail: { owner: getOwner(vmid)?.username || null, reason: "expired", method },
      });
    } catch (err) {
      console.error(`[expiryEnforcer] failed to power off ${vmid}:`, err.message);
      logAudit({
        actor: { username: "system", role: "system" },
        action: "resource.expire",
        target: `VMID ${vmid}`,
        status: "failure",
        detail: { error: err.message },
      });
    }
  }
}

export function startExpiryEnforcer() {
  setTimeout(() => sweep().catch(() => {}), 15_000);
  const timer = setInterval(() => sweep().catch(() => {}), CHECK_INTERVAL_MS);
  timer.unref?.();
  console.log(`Expiry enforcer running (every ${Math.round(CHECK_INTERVAL_MS / 1000)}s)`);
  return timer;
}
