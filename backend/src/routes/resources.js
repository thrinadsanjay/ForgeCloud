import { Router } from "express";
import * as pve from "../services/proxmoxService.js";
import { logAudit } from "../services/auditService.js";
import { requireAuth } from "../middleware/auth.js";
import { getOwner, removeOwner, allOwners, setOwnerIp } from "../services/ownershipStore.js";
import { getExpiry, extendExpiry, removeExpiry, allExpiries, isExpired } from "../services/expiryStore.js";
import { canSeeTags } from "../services/visibility.js";
import { parseTags, sanitizeTag, envTag } from "../services/tags.js";
import { listJobs } from "../services/jobStore.js";
import { submitProvisionRequest, resizeNeedsApproval, listProvisionRequests } from "../services/requestStore.js";
import { canReviewDeployments } from "../constants/roles.js";

const router = Router();
router.use(requireAuth);

// Visibility is tag-driven: admins see everything; everyone else sees a
// resource only if its Proxmox tags include their user tag or a group tag.
// Works on raw Proxmox items (tags = string) or normalized items (tags = array).
function filterByVisibility(items, user) {
  if (user.role === "admin") return items;
  return items.filter((i) => canSeeTags(i.tags, user));
}

// OS lookups hit the Proxmox config API (one request per resource), so we
// cache the resolved, human-friendly label by VMID. A VM's OS effectively
// never changes, so the cache lives for the process lifetime and is only
// cleared when a resource is deleted.
const osCache = new Map();

// Turn a raw Proxmox ostype into something readable. Containers report the
// template family already (ubuntu/debian/...); VMs report short codes.
function prettyOs(ostype, type) {
  if (!ostype) return null;
  if (type === "container") {
    return ostype.charAt(0).toUpperCase() + ostype.slice(1);
  }
  const vmMap = {
    l24: "Linux 2.4",
    l26: "Linux",
    other: "Other",
    solaris: "Solaris",
    wxp: "Windows XP",
    w2k: "Windows 2000",
    w2k3: "Windows 2003",
    w2k8: "Windows 2008",
    wvista: "Windows Vista",
    win7: "Windows 7",
    win8: "Windows 8",
    win10: "Windows 10",
    win11: "Windows 11",
  };
  return vmMap[ostype] || ostype;
}

// Attach an `os` label to each resource, fetching (and caching) the config
// ostype only for resources we haven't seen before.
async function enrichOs(items) {
  await Promise.all(
    items.map(async (r) => {
      if (osCache.has(r.vmid)) {
        r.os = osCache.get(r.vmid);
        return;
      }
      const ostype = await pve
        .getResourceOsType({ vmid: r.vmid, type: r.type })
        .catch(() => null);
      const os = prettyOs(ostype, r.type);
      osCache.set(r.vmid, os);
      r.os = os;
    })
  );
}

// The Connect button and terminal need a VM's IP. It's recorded at provision
// time, but VMs created outside the provisioner (or ones whose guest agent
// hadn't reported an address yet) have no stored IP. For running VMs missing an
// IP, do a live guest-agent lookup and persist it so the Resources list shows
// the Connect action and the terminal route resolves the host without a second
// lookup. Only VMs are probed — the guest-agent endpoint is qemu-specific.
async function enrichIps(items) {
  await Promise.all(
    items.map(async (r) => {
      if (r.ip || r.type !== "vm" || r.status !== "running") return;
      const ip = await pve.getGuestAgentIp({ vmid: r.vmid }).catch(() => null);
      if (ip) {
        r.ip = ip;
        setOwnerIp(r.vmid, ip);
      }
    })
  );
}

// Expiry metadata surfaced to the UI: when it expires, whether it's already
// expired, and how many whole days remain (negative once past due).
function expiryFields(vmid) {
  const rec = getExpiry(vmid);
  if (!rec) return { expiresAt: null, expired: false, daysLeft: null };
  const ms = new Date(rec.expiresAt).getTime() - Date.now();
  return {
    expiresAt: rec.expiresAt,
    expired: ms <= 0,
    daysLeft: Math.ceil(ms / 86400_000),
  };
}

// --- Dashboard metrics ---
router.get("/dashboard", async (req, res) => {
  try {
    const [allVms, allContainers] = await Promise.all([
      pve.listAllVms({}),
      pve.listAllContainers({}),
    ]);

    const vms = filterByVisibility(allVms, req.user);
    const containers = filterByVisibility(allContainers, req.user);

    const runningVms = vms.filter((v) => v.status === "running").length;
    const runningCts = containers.filter((c) => c.status === "running").length;

    // Node-level metrics require Sys.Audit on Proxmox and are only meaningful
    // for admins. If the API user lacks the permission, this resolves to null
    // and the dashboard simply omits the node health section.
    let node = null;
    if (req.user.role === "admin") {
      const nodeStatus = await pve.getNodeStatus({}).catch(() => null);
      if (nodeStatus) {
        node = {
          cpu: nodeStatus.cpu,
          memoryUsed: nodeStatus.memory?.used,
          memoryTotal: nodeStatus.memory?.total,
          uptime: nodeStatus.uptime,
          loadavg: nodeStatus.loadavg,
        };
      }
    }

    res.json({
      scope: req.user.role === "admin" ? "all" : "owned",
      counts: {
        vms: vms.length,
        containers: containers.length,
        running: runningVms + runningCts,
        stopped: (vms.length - runningVms) + (containers.length - runningCts),
      },
      node,
    });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// --- Inventory ---
router.get("/resources", async (req, res) => {
  try {
    const [allVms, allContainers] = await Promise.all([
      pve.listAllVms({}),
      pve.listAllContainers({}),
    ]);
    const norm = (item, type) => ({
      vmid: item.vmid,
      name: item.name,
      type,
      status: item.status,
      cpu: item.cpus || item.maxcpu,
      maxmem: item.maxmem,
      maxdisk: item.maxdisk,
      uptime: item.uptime,
      owner: getOwner(item.vmid)?.username || null,
      ip: getOwner(item.vmid)?.ip || null,
      tags: parseTags(item.tags),
      maxdiskGB: item.maxdisk ? Math.round(item.maxdisk / 1024 ** 3) : null,
      memGB: item.maxmem ? Math.round(item.maxmem / 1024 ** 3) : null,
      os: null,
      ...expiryFields(item.vmid),
    });
    const combined = [
      ...allVms.map((v) => norm(v, "vm")),
      ...allContainers.map((c) => norm(c, "container")),
    ].filter((r) => Number.isFinite(Number(r.vmid)) && Number(r.vmid) > 0);
    // Only resolve OS for resources the caller can actually see, so non-admins
    // don't trigger config reads across the whole node.
    const visible = filterByVisibility(combined, req.user);
    await Promise.all([enrichOs(visible), enrichIps(visible)]);
    res.json(visible);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// --- Lifecycle actions ---
// type = 'vm' | 'container', action = start|stop|shutdown|reboot|reset|delete
// (reset = hard reset, VM-only — LXC has no equivalent Proxmox endpoint)
const ACTIONS = {
  vm: {
    start: pve.startVm,
    stop: pve.stopVm,
    shutdown: pve.shutdownVm,
    reboot: pve.rebootVm,
    reset: pve.resetVm,
    delete: pve.deleteVm,
  },
  container: {
    start: pve.startContainer,
    stop: pve.stopContainer,
    shutdown: pve.shutdownContainer,
    reboot: pve.rebootContainer,
    delete: pve.deleteContainer,
  },
};

router.post("/resources/:type/:vmid/:action(start|stop|shutdown|reboot|delete|reset)", async (req, res) => {
  const { type, vmid, action } = req.params;
  const fn = ACTIONS[type]?.[action];
  if (!fn) {
    return res.status(400).json({ error: `Invalid type/action: ${type}/${action}` });
  }

  const numericVmid = Number(vmid);
  const isAdmin = req.user.role === "admin";

  // Non-admins may only act on resources visible to them by tag (their own
  // user tag or a group tag). Consistent with what they see in the list.
  if (!isAdmin) {
    const tags = await pve.getResourceTags({ vmid: numericVmid, type }).catch(() => "");
    if (!canSeeTags(tags, req.user)) {
      return res.status(403).json({ error: "You can only manage resources assigned to you or your group" });
    }
  }

  // Starting a resource is blocked while expired for everyone (including admins).
  // Owners request a renew; admins/approvers approve it before power-on works again.
  if (action === "start" && isExpired(numericVmid)) {
    return res.status(403).json({
      error: "Resource is expired — request a renewal and wait for approval before powering on",
    });
  }

  // Starting a non-expired resource is admin-only (owners use Renew when expired).
  if (action === "start" && !isAdmin) {
    return res.status(403).json({ error: "Only admins can start a stopped resource" });
  }

  // Deleting is admin-only.
  if (action === "delete" && !isAdmin) {
    return res.status(403).json({ error: "Only admins can delete resources" });
  }

  try {
    await fn({ vmid: numericVmid });
    if (action === "delete") {
      removeOwner(numericVmid);
      removeExpiry(numericVmid);
      osCache.delete(numericVmid);
    }
    logAudit({
      actor: req.user,
      action: `${type}.${action}`,
      target: `VMID ${vmid}`,
      status: "success",
    });
    res.json({ ok: true });
  } catch (err) {
    logAudit({
      actor: req.user,
      action: `${type}.${action}`,
      target: `VMID ${vmid}`,
      status: "failure",
      detail: { error: err.message },
    });
    res.status(502).json({ error: err.message });
  }
});

// --- Edit resource specs ---
// Owners and admins may resize CPU/RAM (and grow disk) on their resources.
// cores/memory hot-apply where the guest supports it; disk can only grow.
router.put("/resources/:type/:vmid/config", async (req, res) => {
  const { type, vmid } = req.params;
  if (type !== "vm" && type !== "container") {
    return res.status(400).json({ error: `Invalid type: ${type}` });
  }

  const numericVmid = Number(vmid);
  const isAdmin = req.user.role === "admin";
  if (!isAdmin) {
    const tags = await pve.getResourceTags({ vmid: numericVmid, type }).catch(() => "");
    if (!canSeeTags(tags, req.user)) {
      return res.status(403).json({ error: "You can only edit resources assigned to you or your group" });
    }
  }

  const cores = req.body?.cpu != null ? Number(req.body.cpu) : undefined;
  const memoryGB = req.body?.memoryGB != null ? Number(req.body.memoryGB) : undefined;
  const diskGB = req.body?.diskGB != null ? Number(req.body.diskGB) : undefined;

  if (cores === undefined && memoryGB === undefined && diskGB === undefined) {
    return res.status(400).json({ error: "Provide at least one of cpu, memoryGB, diskGB" });
  }
  if ([cores, memoryGB, diskGB].some((v) => v !== undefined && (!Number.isFinite(v) || v <= 0))) {
    return res.status(400).json({ error: "cpu, memoryGB and diskGB must be positive numbers" });
  }

  const edit = type === "vm" ? pve.editVm : pve.editContainer;
  try {
    await edit({
      vmid: numericVmid,
      cores,
      memory: memoryGB !== undefined ? memoryGB * 1024 : undefined,
      diskGB,
    });
    logAudit({
      actor: req.user,
      action: `${type}.edit`,
      target: `VMID ${vmid}`,
      status: "success",
      detail: { cpu: cores, memoryGB, diskGB },
    });
    res.json({ ok: true });
  } catch (err) {
    logAudit({
      actor: req.user,
      action: `${type}.edit`,
      target: `VMID ${vmid}`,
      status: "failure",
      detail: { error: err.message },
    });
    res.status(502).json({ error: err.message });
  }
});

// --- Resize (with approval routing) ---
// Decides whether a requested resize is within the size policy or needs admin
// approval. It does NOT apply anything: for a small change the client confirms
// the reboot and then applies via the config route; for a large change we open
// an approval request (applied on approval, rebooted on the owner's consent).
router.post("/resources/:type/:vmid/resize", async (req, res) => {
  const { type, vmid } = req.params;
  if (type !== "vm" && type !== "container") {
    return res.status(400).json({ error: `Invalid type: ${type}` });
  }

  const numericVmid = Number(vmid);
  const isAdmin = req.user.role === "admin";
  if (!isAdmin) {
    const tags = await pve.getResourceTags({ vmid: numericVmid, type }).catch(() => "");
    if (!canSeeTags(tags, req.user)) {
      return res.status(403).json({ error: "You can only resize resources assigned to you or your group" });
    }
  }

  const cpu = req.body?.cpu != null ? Number(req.body.cpu) : undefined;
  const memoryGB = req.body?.memoryGB != null ? Number(req.body.memoryGB) : undefined;
  const diskGB = req.body?.diskGB != null ? Number(req.body.diskGB) : undefined;
  const current = req.body?.current && typeof req.body.current === "object" ? req.body.current : {};
  const hostname = typeof req.body?.hostname === "string" ? req.body.hostname : null;

  if (cpu === undefined && memoryGB === undefined && diskGB === undefined) {
    return res.status(400).json({ error: "Provide at least one of cpu, memoryGB, diskGB" });
  }
  if ([cpu, memoryGB, diskGB].some((v) => v !== undefined && (!Number.isFinite(v) || v <= 0))) {
    return res.status(400).json({ error: "cpu, memoryGB and diskGB must be positive numbers" });
  }

  // Evaluate against the size policy on the target totals.
  const needsApproval = resizeNeedsApproval({ cpu, memoryGB, diskGB });

  if (!needsApproval) {
    // Within policy — the client will confirm the reboot, apply via /config,
    // then reboot. Nothing to persist here.
    return res.json({ status: "reboot_required", approvalRequired: false });
  }

  const payload = { type, vmid: numericVmid, hostname, cpu, memoryGB, diskGB, current };
  const result = await submitProvisionRequest({ kind: "resize", payload, requestedBy: req.user.username, source: "portal" });
  logAudit({
    actor: req.user,
    action: "resize.request",
    target: `VMID ${vmid}`,
    detail: { requestId: result.request.id, cpu, memoryGB, diskGB, status: result.request.status },
  });
  res.json({ status: "pending_approval", approvalRequired: true, requestId: result.request.id });
});

// --- Snapshots & backups ---
// Both are management actions on a specific guest, so they share the same
// tag-based visibility gate: admins always, otherwise the caller must be able
// to see the resource (own user tag or a group tag).
async function assertCanManage(req, res, type, numericVmid) {
  if (req.user.role === "admin") return true;
  const tags = await pve.getResourceTags({ vmid: numericVmid, type }).catch(() => "");
  if (!canSeeTags(tags, req.user)) {
    res.status(403).json({ error: "You can only manage resources assigned to you or your group" });
    return false;
  }
  return true;
}

// Proxmox snapshot names: start with a letter, then letters/digits/_/-.
const SNAP_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{0,39}$/;
// Our marker so we can find (and only touch) the backup job we manage per guest.
const backupComment = (vmid) => `forge-backup-vmid-${vmid}`;

function parseKeepLast(job) {
  const prune = job?.["prune-backups"];
  if (prune) {
    const m = /keep-last=(\d+)/.exec(prune);
    if (m) return Number(m[1]);
  }
  if (job?.maxfiles != null) return Number(job.maxfiles);
  return null;
}

function normalizeBackupJob(job) {
  if (!job) return null;
  return {
    id: job.id,
    enabled: job.enabled === 1 || job.enabled === "1" || job.enabled === true,
    storage: job.storage || "",
    schedule: job.schedule || "",
    mode: job.mode || "snapshot",
    keepLast: parseKeepLast(job),
  };
}

// GET snapshots for a guest.
router.get("/resources/:type/:vmid/snapshots", async (req, res) => {
  const { type } = req.params;
  const numericVmid = Number(req.params.vmid);
  if (!(await assertCanManage(req, res, type, numericVmid))) return;
  try {
    const snapshots = await pve.listSnapshots({ vmid: numericVmid, type });
    res.json(snapshots.map((s) => ({
      name: s.name,
      description: s.description || "",
      snaptime: s.snaptime ? s.snaptime * 1000 : null,
      vmstate: !!s.vmstate,
      parent: s.parent || null,
    })));
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// POST create a snapshot.
router.post("/resources/:type/:vmid/snapshots", async (req, res) => {
  const { type } = req.params;
  const numericVmid = Number(req.params.vmid);
  if (!(await assertCanManage(req, res, type, numericVmid))) return;

  const name = String(req.body?.name || "").trim();
  if (!SNAP_NAME_RE.test(name)) {
    return res.status(400).json({ error: "Snapshot name must start with a letter and contain only letters, digits, '-' or '_' (max 40)." });
  }
  try {
    await pve.createSnapshot({
      vmid: numericVmid, type, snapname: name,
      description: req.body?.description ? String(req.body.description) : undefined,
      vmstate: !!req.body?.includeRam,
    });
    logAudit({ actor: req.user, action: `${type}.snapshot.create`, target: `VMID ${numericVmid}`, status: "success", detail: { snapshot: name } });
    res.json({ ok: true });
  } catch (err) {
    logAudit({ actor: req.user, action: `${type}.snapshot.create`, target: `VMID ${numericVmid}`, status: "failure", detail: { error: err.message } });
    res.status(502).json({ error: err.message });
  }
});

// POST rollback (restore) to a snapshot.
router.post("/resources/:type/:vmid/snapshots/:snap/rollback", async (req, res) => {
  const { type, snap } = req.params;
  const numericVmid = Number(req.params.vmid);
  if (!(await assertCanManage(req, res, type, numericVmid))) return;
  try {
    await pve.rollbackSnapshot({ vmid: numericVmid, type, snapname: snap });
    logAudit({ actor: req.user, action: `${type}.snapshot.rollback`, target: `VMID ${numericVmid}`, status: "success", detail: { snapshot: snap } });
    res.json({ ok: true });
  } catch (err) {
    logAudit({ actor: req.user, action: `${type}.snapshot.rollback`, target: `VMID ${numericVmid}`, status: "failure", detail: { error: err.message, snapshot: snap } });
    res.status(502).json({ error: err.message });
  }
});

// DELETE a snapshot.
router.delete("/resources/:type/:vmid/snapshots/:snap", async (req, res) => {
  const { type, snap } = req.params;
  const numericVmid = Number(req.params.vmid);
  if (!(await assertCanManage(req, res, type, numericVmid))) return;
  try {
    await pve.deleteSnapshot({ vmid: numericVmid, type, snapname: snap });
    logAudit({ actor: req.user, action: `${type}.snapshot.delete`, target: `VMID ${numericVmid}`, status: "success", detail: { snapshot: snap } });
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// GET the backup schedule for a guest + the backup-capable storages.
router.get("/resources/:type/:vmid/backup", async (req, res) => {
  const { type } = req.params;
  const numericVmid = Number(req.params.vmid);
  if (!(await assertCanManage(req, res, type, numericVmid))) return;
  try {
    const [jobs, storages] = await Promise.all([
      pve.listBackupJobs().catch(() => []),
      pve.listBackupStorages({}).catch(() => []),
    ]);
    const job = jobs.find((j) => j.comment === backupComment(numericVmid));
    res.json({ config: normalizeBackupJob(job), storages });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// POST create/update the backup schedule for a guest.
router.post("/resources/:type/:vmid/backup", async (req, res) => {
  const { type } = req.params;
  const numericVmid = Number(req.params.vmid);
  if (!(await assertCanManage(req, res, type, numericVmid))) return;

  const { enabled, storage, schedule, mode = "snapshot", keepLast = 3 } = req.body || {};
  if (!storage) return res.status(400).json({ error: "storage is required" });
  if (!schedule || !String(schedule).trim()) return res.status(400).json({ error: "schedule is required" });
  if (!["snapshot", "suspend", "stop"].includes(mode)) return res.status(400).json({ error: "mode must be snapshot, suspend or stop" });
  const keep = Number(keepLast);
  if (!Number.isInteger(keep) || keep < 1 || keep > 365) return res.status(400).json({ error: "keepLast must be between 1 and 365" });

  const cfg = {
    schedule: String(schedule).trim(),
    storage,
    vmid: numericVmid,
    mode,
    enabled: enabled ? 1 : 0,
    "prune-backups": `keep-last=${keep}`,
    comment: backupComment(numericVmid),
  };

  try {
    const jobs = await pve.listBackupJobs().catch(() => []);
    const existing = jobs.find((j) => j.comment === backupComment(numericVmid));
    if (existing) await pve.updateBackupJob(existing.id, cfg);
    else await pve.createBackupJob(cfg);
    logAudit({ actor: req.user, action: `${type}.backup.configure`, target: `VMID ${numericVmid}`, status: "success", detail: { schedule: cfg.schedule, storage, mode, keepLast: keep, enabled: !!enabled } });
    res.json({ ok: true });
  } catch (err) {
    logAudit({ actor: req.user, action: `${type}.backup.configure`, target: `VMID ${numericVmid}`, status: "failure", detail: { error: err.message } });
    res.status(502).json({ error: err.message });
  }
});

// DELETE the managed backup schedule for a guest.
router.delete("/resources/:type/:vmid/backup", async (req, res) => {
  const { type } = req.params;
  const numericVmid = Number(req.params.vmid);
  if (!(await assertCanManage(req, res, type, numericVmid))) return;
  try {
    const jobs = await pve.listBackupJobs().catch(() => []);
    const existing = jobs.find((j) => j.comment === backupComment(numericVmid));
    if (existing) await pve.deleteBackupJob(existing.id);
    logAudit({ actor: req.user, action: `${type}.backup.remove`, target: `VMID ${numericVmid}`, status: "success" });
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// POST run an immediate backup now.
router.post("/resources/:type/:vmid/backup/run", async (req, res) => {
  const { type } = req.params;
  const numericVmid = Number(req.params.vmid);
  if (!(await assertCanManage(req, res, type, numericVmid))) return;
  const { storage, mode = "snapshot" } = req.body || {};
  if (!storage) return res.status(400).json({ error: "storage is required" });
  try {
    await pve.runBackup({ vmid: numericVmid, storage, mode });
    logAudit({ actor: req.user, action: `${type}.backup.run`, target: `VMID ${numericVmid}`, status: "success", detail: { storage, mode } });
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// --- Tags ---
// Visibility/ownership tags (user-*, group-*) gate who can see a resource, so
// they're never stripped by a manual edit — only "descriptive" tags (env, name,
// app, and any custom ones) are managed here.
const PROTECTED_TAG = (t) => t.startsWith("user-") || t.startsWith("group-");

// Requested packages for a VMID, taken from its provisioning job (best-effort).
function appTagsForVmid(vmid) {
  try {
    const job = listJobs().find((j) => (j.resources || []).some((r) => Number(r.vmid) === Number(vmid)));
    const pkgs = job?.payload?.packages || job?.payload?.packageSelection?.effective || [];
    return pkgs.map((p) => `app-${sanitizeTag(p)}`).filter((t) => t !== "app-");
  } catch { return []; }
}

function jobFor(vmid) {
  return listJobs().find((j) => (j.resources || []).some((r) => Number(r.vmid) === Number(vmid)));
}

// PUT descriptive tags (protected user-/group- tags are preserved).
router.put("/resources/:type/:vmid/tags", async (req, res) => {
  const { type } = req.params;
  const numericVmid = Number(req.params.vmid);
  if (!(await assertCanManage(req, res, type, numericVmid))) return;

  const incoming = Array.isArray(req.body?.tags) ? req.body.tags.map((t) => sanitizeTag(t)).filter(Boolean) : null;
  if (!incoming) return res.status(400).json({ error: "tags array is required" });

  try {
    const existing = parseTags(await pve.getResourceTags({ vmid: numericVmid, type }));
    const preserved = existing.filter(PROTECTED_TAG);
    const merged = Array.from(new Set([...preserved, ...incoming]));
    await pve.setTags({ vmid: numericVmid, type, tags: merged });
    logAudit({ actor: req.user, action: `${type}.tag.set`, target: `VMID ${numericVmid}`, status: "success", detail: { tags: incoming } });
    res.json({ ok: true, tags: merged });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// POST auto-tag: derive tags from the VM name, its environment and the apps it
// was provisioned with, then merge them onto the existing tags.
router.post("/resources/:type/:vmid/autotag", async (req, res) => {
  const { type } = req.params;
  const numericVmid = Number(req.params.vmid);
  if (!(await assertCanManage(req, res, type, numericVmid))) return;

  try {
    const existing = parseTags(await pve.getResourceTags({ vmid: numericVmid, type }));
    const job = jobFor(numericVmid);
    const owner = getOwner(numericVmid);
    const name = req.body?.name || owner?.hostname || job?.resources?.find((r) => Number(r.vmid) === numericVmid)?.hostname;

    const generated = [];
    const nm = sanitizeTag(name || "");
    if (nm) generated.push(`name-${nm}`);
    // Only add an env tag if one isn't already present.
    if (!existing.some((t) => t.startsWith("env-")) && job?.payload?.environment) {
      generated.push(envTag(job.payload.environment));
    }
    generated.push(...appTagsForVmid(numericVmid));

    const merged = Array.from(new Set([...existing, ...generated]));
    await pve.setTags({ vmid: numericVmid, type, tags: merged });
    logAudit({ actor: req.user, action: `${type}.tag.auto`, target: `VMID ${numericVmid}`, status: "success", detail: { added: generated } });
    res.json({ ok: true, tags: merged, added: generated });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// --- Renew / extend expiry ---
// Non-admins (owners) always create a renew request that admins/approvers must
// approve. Admins may still extend immediately (ops shortcut) OR submit a renew
// request via { requireApproval: true }.
router.post("/resources/:type/:vmid/extend", async (req, res) => {
  const { type, vmid } = req.params;
  if (type !== "vm" && type !== "container") {
    return res.status(400).json({ error: `Invalid type: ${type}` });
  }
  const numericVmid = Number(vmid);
  const isAdmin = req.user.role === "admin";
  const isReviewer = canReviewDeployments(req.user.role);
  if (!isAdmin) {
    const owner = getOwner(numericVmid);
    if (!owner || owner.username !== req.user.username) {
      return res.status(403).json({ error: "You can only renew resources you own" });
    }
  }

  const days = req.body?.days != null ? Number(req.body.days) : undefined;
  if (days !== undefined && (!Number.isFinite(days) || days <= 0)) {
    return res.status(400).json({ error: "days must be a positive number" });
  }
  const ttlDays = days && Number.isFinite(days) ? Math.round(days) : 30;

  // Force approval path for owners; admins default to immediate unless asked.
  const requireApproval = !isAdmin || req.body?.requireApproval === true;
  if (requireApproval) {
    // Avoid duplicate pending renews for the same VM.
    const pending = listProvisionRequests(req.user).find((r) =>
      r.kind === "renew"
      && r.status === "pending_approval"
      && Number(r.payload?.vmid) === numericVmid
    );
    if (pending) {
      return res.status(409).json({
        error: `A renewal request is already pending (${pending.id})`,
        request: pending,
      });
    }

    const hostname = getOwner(numericVmid)?.hostname || `VMID ${numericVmid}`;
    const result = await submitProvisionRequest({
      kind: "renew",
      payload: {
        type,
        vmid: numericVmid,
        days: ttlDays,
        hostname,
      },
      requestedBy: req.user.username,
      source: "portal",
      forceApproval: true,
    });
    logAudit({
      actor: req.user,
      action: "resource.renew_request",
      target: `VMID ${vmid}`,
      status: "success",
      detail: { requestId: result.request.id, days: ttlDays },
    });
    return res.status(202).json({
      ok: true,
      pendingApproval: true,
      request: result.request,
      message: isReviewer
        ? "Renewal submitted for approval (including your own reviewer queue)."
        : "Renewal submitted — an admin or deployment approver must approve it.",
    });
  }

  const record = extendExpiry(numericVmid, { days: ttlDays, setBy: req.user.username });
  logAudit({
    actor: req.user,
    action: "resource.extend",
    target: `VMID ${vmid}`,
    status: "success",
    detail: { expiresAt: record.expiresAt, days: ttlDays },
  });
  res.json({ ok: true, expiresAt: record.expiresAt, pendingApproval: false });
});

// --- Expiry reminders ---
// Resources owned by the caller whose decommission date falls within the
// reminder window (default 7 days) — including any already past due. Drives the
// daily "will be decommissioned in N days" toast with its Renew button. Admins
// see every expiring resource so they can act on anyone's behalf.
router.get("/notifications/expiring", (req, res) => {
  const withinDays = Math.min(Math.max(1, Number(req.query.withinDays) || 7), 60);
  const cutoff = Date.now() + withinDays * 86400_000;
  const isAdmin = req.user.role === "admin";
  const expiries = allExpiries();

  const items = [];
  for (const [vmid, rec] of Object.entries(expiries)) {
    const at = new Date(rec.expiresAt).getTime();
    if (!Number.isFinite(at) || at > cutoff) continue; // outside the reminder window
    const owner = getOwner(vmid);
    if (!isAdmin && owner?.username !== req.user.username) continue;
    const ms = at - Date.now();
    items.push({
      vmid: Number(vmid),
      type: rec.type || "vm",
      name: owner?.hostname || `VMID ${vmid}`,
      owner: owner?.username || null,
      expiresAt: rec.expiresAt,
      expired: ms <= 0,
      daysLeft: Math.ceil(ms / 86400_000),
    });
  }

  items.sort((a, b) => a.daysLeft - b.daysLeft);
  res.json(items);
});

export default router;
