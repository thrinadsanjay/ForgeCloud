import * as pve from "./proxmoxService.js";
import { allExpiries } from "./expiryStore.js";
import { getOwner } from "./ownershipStore.js";
import { logAudit } from "./auditService.js";
import { upsertDigest } from "./notificationStore.js";

const CHECK_INTERVAL_MS = Number(process.env.EXPIRY_CHECK_INTERVAL_MS || 5 * 60 * 1000);
const WARN_WITHIN_DAYS = Number(process.env.EXPIRY_WARN_WITHIN_DAYS || 7);

/** In-memory throttle: `${vmid}:${yyyy-mm-dd}` → already notified today. */
const warnedKeys = new Set();
const expiredNotified = new Set();

function dayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

function daysLeft(expiresAt, now = Date.now()) {
  return Math.ceil((new Date(expiresAt).getTime() - now) / 86400000);
}

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

async function listByVmid() {
  let vms = [];
  let cts = [];
  try {
    [vms, cts] = await Promise.all([pve.listAllVms({}), pve.listAllContainers({})]);
  } catch (err) {
    console.error("[expiryEnforcer] could not list resources:", err.message);
    return null;
  }
  const byVmid = new Map();
  for (const v of vms) byVmid.set(v.vmid, { ...v, kind: "vm" });
  for (const c of cts) byVmid.set(c.vmid, { ...c, kind: "container" });
  return byVmid;
}

/** Warn owners of resources expiring within WARN_WITHIN_DAYS (once per calendar day). */
function notifyUpcoming(byVmid) {
  const now = Date.now();
  const today = dayKey();
  const warnMs = WARN_WITHIN_DAYS * 86400000;

  for (const [vmidStr, rec] of Object.entries(allExpiries())) {
    const vmid = Number(vmidStr);
    const expiresAt = new Date(rec.expiresAt).getTime();
    if (!Number.isFinite(expiresAt)) continue;
    const remaining = expiresAt - now;
    if (remaining <= 0 || remaining > warnMs) continue;

    const key = `${vmid}:${today}`;
    if (warnedKeys.has(key)) continue;
    warnedKeys.add(key);

    const owner = getOwner(vmid)?.username;
    if (!owner) continue;

    const resource = byVmid?.get(vmid);
    const name = resource?.name || `VMID ${vmid}`;
    const kind = resource?.kind === "container" ? "Container" : "VM";
    const left = daysLeft(rec.expiresAt, now);
    const when = left <= 0 ? "today" : left === 1 ? "tomorrow" : `in ${left} days`;

    upsertDigest({
      recipient: owner,
      digestKey: `expiry-warn:${owner}:${today}`,
      type: "resource_expiring",
      level: "warn",
      title: "Resources expiring soon",
      itemTitle: `${kind} ${name} expires ${when}`,
      itemMessage: `${kind} "${name}" (VMID ${vmid}) will be powered off ${when} unless renewed.`,
      link: "/resources?tab=compute",
    });
  }

  // Bound memory: drop keys from previous days
  for (const k of [...warnedKeys]) {
    if (!k.endsWith(`:${today}`)) warnedKeys.delete(k);
  }
}

async function sweepExpired(byVmid) {
  const now = Date.now();
  const expiredVmids = Object.entries(allExpiries())
    .filter(([, rec]) => new Date(rec.expiresAt).getTime() <= now)
    .map(([vmid]) => Number(vmid));

  if (expiredVmids.length === 0) return;

  for (const vmid of expiredVmids) {
    const resource = byVmid.get(vmid);
    const owner = getOwner(vmid)?.username;
    const name = resource?.name || `VMID ${vmid}`;
    const kindLabel = resource?.kind === "container" ? "Container" : "VM";

    // Inbox once when we first observe expiry (even if already stopped).
    if (owner && !expiredNotified.has(vmid)) {
      expiredNotified.add(vmid);
      const today = dayKey();
      upsertDigest({
        recipient: owner,
        digestKey: `expiry-done:${owner}:${today}`,
        type: "resource_expired",
        level: "error",
        title: "Resources expired",
        itemTitle: `${kindLabel} ${name} expired`,
        itemMessage: resource?.status === "running"
          ? `${kindLabel} "${name}" (VMID ${vmid}) has expired and is being powered off.`
          : `${kindLabel} "${name}" (VMID ${vmid}) has expired. Renew before power-on.`,
        link: "/resources?tab=compute",
      });
    }

    if (!resource || resource.status !== "running") continue;

    try {
      const method = await powerOffExpired(vmid, resource.kind);
      console.log(`[expiryEnforcer] powered off expired ${resource.kind} ${vmid} via ${method}`);
      logAudit({
        actor: { username: "system", role: "system" },
        action: "resource.expire",
        target: `VMID ${vmid}`,
        status: "success",
        detail: { owner: owner || null, reason: "expired", method },
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

  // Clear notified set for VMIDs that are no longer expired (renewed).
  const stillExpired = new Set(expiredVmids);
  for (const vmid of [...expiredNotified]) {
    if (!stillExpired.has(vmid)) expiredNotified.delete(vmid);
  }
}

async function sweep() {
  const byVmid = await listByVmid();
  if (!byVmid) return;
  notifyUpcoming(byVmid);
  await sweepExpired(byVmid);
}

export function startExpiryEnforcer() {
  setTimeout(() => sweep().catch(() => {}), 15_000);
  const timer = setInterval(() => sweep().catch(() => {}), CHECK_INTERVAL_MS);
  timer.unref?.();
  console.log(`Expiry enforcer running (every ${Math.round(CHECK_INTERVAL_MS / 1000)}s)`);
  return timer;
}
