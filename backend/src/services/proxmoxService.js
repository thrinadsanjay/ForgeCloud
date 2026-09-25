import axios from "axios";
import https from "https";

// Connection config is read from process.env at call time (not captured at
// module load) so changes saved in the admin Settings tab take effect without
// a restart. The settingsStore layers persisted overrides onto process.env.
function pveConfig() {
  const useApiToken = process.env.PROXMOX_USE_API_TOKEN === "true";
  return {
    host: process.env.PROXMOX_HOST,
    port: process.env.PROXMOX_PORT || "8006",
    node: process.env.PROXMOX_NODE,
    username: process.env.PROXMOX_USERNAME,
    password: process.env.PROXMOX_PASSWORD,
    useApiToken,
    tokenId: process.env.PROXMOX_TOKEN_ID,
    tokenSecret: process.env.PROXMOX_TOKEN_SECRET,
    verifySsl: process.env.PROXMOX_VERIFY_SSL === "true",
  };
}

function usesTokenAuth(cfg = pveConfig()) {
  return cfg.useApiToken && !!(cfg.tokenId?.trim() && cfg.tokenSecret);
}

function authSignature(cfg) {
  if (usesTokenAuth(cfg)) return `token:${cfg.tokenId}`;
  return `password:${cfg.username}`;
}

/** Proxmox API token auth — no ticket/CSRF required. */
function buildAuthHeaders(method, cfg = pveConfig()) {
  if (usesTokenAuth(cfg)) {
    return { Authorization: `PVEAPIToken=${cfg.tokenId}=${cfg.tokenSecret}` };
  }
  const headers = { Cookie: `PVEAuthCookie=${ticket}` };
  if (["post", "put", "delete"].includes(method)) {
    headers.CSRFPreventionToken = csrfToken;
  }
  return headers;
}

let client = null;
let clientSig = null;
let ticket = null;
let csrfToken = null;
let ticketExpiry = 0;

// Build (or rebuild) the axios client whenever the connection target changes.
// A changed host/port/TLS setting also invalidates the cached auth ticket.
function ensureClient() {
  const cfg = pveConfig();
  const sig = `${cfg.host}:${cfg.port}:${cfg.verifySsl}:${authSignature(cfg)}`;
  if (!client || sig !== clientSig) {
    client = axios.create({
      baseURL: `https://${cfg.host}:${cfg.port}/api2/json`,
      httpsAgent: new https.Agent({ rejectUnauthorized: cfg.verifySsl }),
      // Fail fast when the host is down — default axios has no timeout and
      // can stall the whole portal for minutes on TCP hang.
      timeout: Number(process.env.PROXMOX_HTTP_TIMEOUT_MS) || 5000,
    });
    clientSig = sig;
    ticket = null;
    csrfToken = null;
    ticketExpiry = 0;
  }
  return client;
}

async function authenticate() {
  const cfg = pveConfig();
  if (usesTokenAuth(cfg)) return;
  if (!cfg.username || !cfg.password) {
    throw new Error("Proxmox username and password are required (or enable API token auth)");
  }
  const res = await ensureClient().post("/access/ticket", {
    username: cfg.username,
    password: cfg.password,
  });
  ticket = res.data.data.ticket;
  csrfToken = res.data.data.CSRFPreventionToken;
  // Proxmox tickets last 2 hours; refresh after 100 minutes to be safe
  ticketExpiry = Date.now() + 100 * 60 * 1000;
}

async function ensureAuth() {
  ensureClient();
  if (usesTokenAuth()) return;
  if (!ticket || Date.now() > ticketExpiry) {
    await authenticate();
  }
}

async function pveRequest(method, path, data = null, params = null) {
  await ensureAuth();
  const client = ensureClient();
  const headers = buildAuthHeaders(method);
  try {
    const res = await client.request({
      method,
      url: path,
      data,
      params,
      headers,
    });
    return res.data.data;
  } catch (err) {
    const detail = err.response?.data || err.message;
    throw new Error(
      `Proxmox API error [${method.toUpperCase()} ${path}]: ${JSON.stringify(detail)}`
    );
  }
}

/** True when Proxmox returned an async task id (UPID:…). */
export function isPveUpid(value) {
  return typeof value === "string" && /^UPID:[^:]+:/i.test(value);
}

function extractPveErrorText(detail) {
  if (detail == null) return "";
  if (typeof detail === "string") {
    // Often "Proxmox API error [PUT /path]: {…}"
    const jsonStart = detail.indexOf("{");
    if (jsonStart >= 0) {
      try {
        return extractPveErrorText(JSON.parse(detail.slice(jsonStart)));
      } catch {
        return detail;
      }
    }
    return detail;
  }
  const parts = [];
  if (detail.message) parts.push(String(detail.message));
  if (detail.errors && typeof detail.errors === "object") {
    for (const [k, v] of Object.entries(detail.errors)) {
      parts.push(`${k}: ${Array.isArray(v) ? v.join(", ") : v}`);
    }
  }
  if (typeof detail.data === "string" && detail.data) parts.push(detail.data);
  if (!parts.length) {
    try { return JSON.stringify(detail); } catch { return String(detail); }
  }
  return parts.join("\n");
}

/**
 * Run a mutating Proxmox call and, when the API returns a UPID, wait until
 * that task finishes successfully. API/task failures become ProxmoxTaskError
 * with a user-facing message so provision steps fail immediately.
 */
async function pveMutate(method, path, data = null, {
  node = process.env.PROXMOX_NODE,
  attempts = 60,
  delayMs = 2000,
  wait = true,
} = {}) {
  let result;
  try {
    result = await pveRequest(method, path, data);
  } catch (err) {
    if (err instanceof ProxmoxTaskError) throw err;
    const text = extractPveErrorText(err.message);
    throw new ProxmoxTaskError(mapExitstatusToUserMessage(text, text), {
      detail: err.message,
    });
  }
  if (wait && isPveUpid(result)) {
    await waitForTask({ node, upid: result, attempts, delayMs });
  }
  return result;
}

export async function getNextVmid() {
  return pveRequest("get", "/cluster/nextid");
}

// Proxmox reports template flag as 1, true, or "1" depending on API version.
export function isProxmoxTemplate(item) {
  const t = item?.template;
  return t === 1 || t === true || t === "1";
}

// Real guests always have a numeric VMID. Reject Proxmox API directory-index
// rows (aplinfo/apt/ceph/…) that share the same {name} shape but have no vmid.
function isGuestRecord(item) {
  const id = Number(item?.vmid);
  return Number.isFinite(id) && id > 0;
}

function requirePveNode(node) {
  const n = String(node || process.env.PROXMOX_NODE || autoDetectedNode || "").trim();
  if (!n) throw new Error("PROXMOX_NODE is not configured");
  return n;
}

// Cached auto-detect when Settings / env left the node blank (common cause of
// `/nodes//qemu` and `/nodes//storage/...` failures).
let autoDetectedNode = null;

/**
 * Resolve the Proxmox node name: explicit arg → env → auto-detect via GET /nodes.
 * Persists the detection into process.env so later call sites with default
 * `node = process.env.PROXMOX_NODE` keep working for this process.
 */
export async function resolvePveNode(explicit) {
  const fromArg = String(explicit || "").trim();
  if (fromArg) return fromArg;

  const fromEnv = String(process.env.PROXMOX_NODE || "").trim();
  if (fromEnv) {
    autoDetectedNode = fromEnv;
    return fromEnv;
  }

  if (autoDetectedNode) return autoDetectedNode;

  const nodes = (await pveRequest("get", "/nodes")) || [];
  const ranked = [...nodes].sort((a, b) => {
    const ao = a.status === "online" ? 0 : 1;
    const bo = b.status === "online" ? 0 : 1;
    return ao - bo;
  });
  const pick = ranked.find((n) => n?.node)?.node;
  if (!pick) {
    throw new Error("PROXMOX_NODE is not configured and no Proxmox nodes were found. Set Node name to pve (or your node) in Admin → Settings.");
  }
  autoDetectedNode = pick;
  process.env.PROXMOX_NODE = pick;
  console.log(`[proxmox] PROXMOX_NODE was empty — auto-detected "${pick}"`);
  return pick;
}

export function clearPveNodeCache() {
  autoDetectedNode = null;
}

// Accepts either listTemplates(), listTemplates("node") or the object style
// listTemplates({ node }) used elsewhere in this module — callers pass {} so a
// positional node arg would otherwise become "[object Object]".
export async function listTemplates(arg) {
  const node = await resolvePveNode(arg && typeof arg === "object" ? arg.node : arg);
  const vms = (await pveRequest("get", `/nodes/${node}/qemu`)) || [];
  return vms.filter((vm) => isGuestRecord(vm) && isProxmoxTemplate(vm));
}

export async function cloneVm({
  node = process.env.PROXMOX_NODE,
  templateVmid,
  newVmid,
  hostname,
  storage = "local-lvm",
  fullClone = true,
}) {
  // Proxmox clone is async — wait for the task so disk/permission failures
  // surface here instead of later as a mysterious hang.
  const upid = await pveMutate("post", `/nodes/${node}/qemu/${templateVmid}/clone`, {
    newid: newVmid,
    name: hostname,
    storage,
    full: fullClone ? 1 : 0,
  }, { node, attempts: 180, delayMs: 2000 });
  return upid;
}

export async function waitForTask({ node = process.env.PROXMOX_NODE, upid, attempts = 60, delayMs = 2000 }) {
  const resolvedNode = await resolvePveNode(node);
  for (let i = 0; i < attempts; i++) {
    const status = await getTaskStatus(resolvedNode, upid);
    if (status.status === "stopped") {
      if (status.exitstatus !== "OK") {
        throw await buildTaskFailure(resolvedNode, upid, status.exitstatus);
      }
      return status;
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  throw new ProxmoxTaskError(
    "Proxmox is taking too long to finish this operation. Try again or ask an admin to check the node.",
    {
      detail: `Timed out waiting for task ${upid} after ${attempts} polls (${Math.round((attempts * delayMs) / 1000)}s).`,
      upid,
      exitstatus: "timeout",
    }
  );
}

export async function getTaskStatus(node, upid) {
  return pveRequest("get", `/nodes/${node}/tasks/${encodeURIComponent(upid)}/status`);
}

/** Recent lines from a Proxmox task log (newest useful messages for operators). */
export async function getTaskLog(node, upid, { start = 0, limit = 80 } = {}) {
  try {
    const rows = await pveRequest(
      "get",
      `/nodes/${node}/tasks/${encodeURIComponent(upid)}/log`,
      null,
      { start, limit }
    );
    if (!Array.isArray(rows)) return [];
    return rows.map((r) => String(r?.t ?? r ?? "").trim()).filter(Boolean);
  } catch {
    return [];
  }
}

export class ProxmoxTaskError extends Error {
  constructor(userMessage, { detail = "", exitstatus = "", upid = "" } = {}) {
    super(userMessage);
    this.name = "ProxmoxTaskError";
    this.userMessage = userMessage;
    this.detail = detail;
    this.exitstatus = exitstatus;
    this.upid = upid;
  }
}

function mapExitstatusToUserMessage(exitstatus, logText) {
  const raw = `${exitstatus || ""} ${logText || ""}`.toLowerCase();
  if (/max\s+\d+\s+vcpu|vcpu.*allowed|too many.*(cpu|vcpu)|cpus?\s*>\s*\d+|cpu.*limit|license.*cpu/.test(raw)) {
    return "Proxmox refused to power on the VM — the CPU count exceeds the allowed limit (e.g. license max vCPUs). Lower the vCPU size and try again.";
  }
  if (/timeout|timed out/.test(raw)) {
    return "Proxmox timed out while copying or configuring the VM. The node may be busy — try again shortly.";
  }
  if (/no space|disk.*full|storage.*full|out of space/.test(raw)) {
    return "Proxmox storage is full. Free space on the storage pool or ask an admin to expand it.";
  }
  if (/permission|not allowed|permission denied|401|403/.test(raw)) {
    return "Proxmox rejected the operation due to permissions. Ask an admin to check the API token or user ACLs.";
  }
  if (/lock|locked|can't lock|cannot lock/.test(raw)) {
    return "The VM is locked by another Proxmox task. Wait a minute and retry, or ask an admin to clear the lock.";
  }
  if (/does not exist|not found|no such/.test(raw)) {
    return "Proxmox could not find the template or storage. Check Mappings and that the template still exists.";
  }
  if (/i\/o error|io error|read error|write error/.test(raw)) {
    return "Proxmox hit a disk I/O error while cloning. Check storage health on the node.";
  }
  if (/start|power|boot/.test(raw) && exitstatus && exitstatus !== "OK" && String(exitstatus).length < 80) {
    return `Proxmox could not power on the guest (${exitstatus}). See technical details below.`;
  }
  // Short task exitstatus (e.g. "ERROR: …") vs long JSON API blobs
  if (exitstatus && exitstatus !== "OK" && String(exitstatus).length < 80 && !/proxmox api error/i.test(String(exitstatus))) {
    return `Proxmox could not complete this step (${exitstatus}). See technical details below.`;
  }
  return "Proxmox could not complete this step. See technical details below, or ask an admin to check the task log.";
}

async function buildTaskFailure(node, upid, exitstatus) {
  const lines = await getTaskLog(node, upid);
  const useful = lines.filter((l) => !/^TASK (OK|ERROR)/i.test(l));
  const tail = useful.slice(-12).join("\n") || lines.slice(-8).join("\n");
  const userMessage = mapExitstatusToUserMessage(exitstatus, tail);
  const detail = [
    exitstatus ? `exitstatus: ${exitstatus}` : null,
    upid ? `upid: ${upid}` : null,
    tail ? `log:\n${tail}` : null,
  ].filter(Boolean).join("\n");
  return new ProxmoxTaskError(userMessage, { detail, exitstatus, upid });
}

export async function configureVm({ node = process.env.PROXMOX_NODE, vmid, cores, memory, diskResizeGB, storage = "local-lvm" }) {
  const payload = { agent: "1" }; // enable guest agent so we can read the DHCP IP
  if (cores) payload.cores = cores;
  if (memory) payload.memory = memory; // MB

  await pveMutate("put", `/nodes/${node}/qemu/${vmid}/config`, payload, { node });

  // Attach a cloud-init drive if missing. Don't trust a config pre-check here —
  // Proxmox's config API can lag slightly behind the clone task's own disk
  // creation, so a "does ide2 exist yet" read can race and false-negative.
  // Instead just attempt it and treat "already exists" as success.
  try {
    await pveMutate("put", `/nodes/${node}/qemu/${vmid}/config`, {
      ide2: `${storage}:cloudinit`,
    }, { node });
  } catch (err) {
    const alreadyExists = /already exists/i.test(err.message + (err.detail || ""));
    if (!alreadyExists) throw err;
    // else: cloud-init drive is already attached (created by the clone itself), fine.
  }

  if (diskResizeGB) {
    await pveMutate("put", `/nodes/${node}/qemu/${vmid}/resize`, {
      disk: "scsi0",
      size: `${diskResizeGB}G`,
    }, { node, attempts: 120 });
  }
}

export async function setCloudInit({ node = process.env.PROXMOX_NODE, vmid, hostname, staticIp, sshKeys }) {
  const payload = {
    ciuser: "ubuntu",
    searchdomain: "local",
  };

  // Set a default SSH password from env so the web terminal can connect.
  // Users should change this after first login.
  if (process.env.VM_SSH_PASSWORD) {
    payload.cipassword = process.env.VM_SSH_PASSWORD;
  }

  if (staticIp) {
    payload.ipconfig0 = `ip=${staticIp.full},gw=${staticIp.gateway}`;
    payload.nameserver = staticIp.dns;
  } else {
    // DHCP — let the guest lease address + DNS from the network; do not pin 8.8.8.8.
    payload.ipconfig0 = "ip=dhcp";
  }

  if (sshKeys) payload.sshkeys = encodeURIComponent(sshKeys);
  await pveMutate("put", `/nodes/${node}/qemu/${vmid}/config`, payload, { node });
}

/**
 * Ansible bootstrap without snippet storage: Proxmox native cloud-init fields
 * (ciuser / cipassword / sshkeys). Creates the service account on first boot so
 * Forge can SSH in with the deploy key even when PasswordAuthentication is off.
 * Note: QEMU config has no `hostname` property — guest hostname comes from the
 * VM name (set at clone) and/or richer cloud-init user-data.
 *
 * Clears inherited `cicustom` from the template first — RHEL golden images often
 * ship vendor user-data that ignores ciuser and never creates the forge account.
 */
export async function setAnsibleBootstrapCi({
  node = process.env.PROXMOX_NODE,
  vmid,
  hostname,
  serviceUser = "forge",
  servicePassword = "",
  sshPublicKeys = [],
  clearCicustom = true,
}) {
  const keys = (sshPublicKeys || [])
    .map((k) => String(k || "").trim())
    .filter(Boolean)
    .join("\n");

  // Drop template cicustom so Proxmox-generated NoCloud data (ciuser/sshkeys) applies.
  // Skip when caller already attached a Forge bootstrap snippet via cicustom.
  if (clearCicustom) {
    await pveMutate("put", `/nodes/${node}/qemu/${vmid}/config`, { delete: "cicustom" }, { node }).catch((err) => {
      console.warn(`[proxmox] could not clear cicustom on ${vmid}: ${err.userMessage || err.message}`);
    });
  }

  const payload = {
    ciuser: String(serviceUser || "forge").trim() || "forge",
    searchdomain: "local",
    ipconfig0: "ip=dhcp",
  };
  if (servicePassword) payload.cipassword = String(servicePassword);
  if (keys) payload.sshkeys = encodeURIComponent(keys);

  await pveMutate("put", `/nodes/${node}/qemu/${vmid}/config`, payload, { node });

  // Align Proxmox VM name with requested hostname when provided (cloud-init
  // often derives the guest hostname from the VM name).
  const name = String(hostname || "").trim();
  if (name) {
    await pveMutate("put", `/nodes/${node}/qemu/${vmid}/config`, { name }, { node }).catch((err) => {
      console.warn(`[proxmox] could not set VM name to "${name}": ${err.userMessage || err.message}`);
    });
  }
}

// Edit an existing VM's specs. cores/memory are applied live where the guest
// supports hotplug; otherwise Proxmox stores them as pending and they take
// effect on the next reboot. Disk can only grow (Proxmox can't shrink).
export async function editVm({ node = process.env.PROXMOX_NODE, vmid, cores, memory, diskGB }) {
  const payload = {};
  if (cores) payload.cores = Number(cores);
  if (memory) payload.memory = Number(memory); // MB
  if (Object.keys(payload).length) {
    await pveMutate("put", `/nodes/${node}/qemu/${vmid}/config`, payload, { node });
  }
  if (diskGB) {
    await pveMutate("put", `/nodes/${node}/qemu/${vmid}/resize`, {
      disk: "scsi0",
      size: `${Number(diskGB)}G`,
    }, { node, attempts: 120 });
  }
}

// Attach a brand-new data disk to a VM (in addition to the template's OS disk).
// Finds the next free scsi slot (scsi1, scsi2, …) and allocates a fresh volume
// of the requested size on the given storage.
export async function attachDisk({ node = process.env.PROXMOX_NODE, vmid, sizeGB, storage = "local-lvm" }) {
  const size = Number(sizeGB);
  if (!Number.isFinite(size) || size <= 0) return null;

  const config = await getVmConfig({ node, vmid }).catch(() => ({}));
  let slot = 1;
  while (config[`scsi${slot}`] != null && slot < 30) slot += 1;
  const disk = `scsi${slot}`;

  await pveMutate("put", `/nodes/${node}/qemu/${vmid}/config`, {
    [disk]: `${storage}:${Math.round(size)}`,
  }, { node });
  return disk;
}

export async function editContainer({ node = process.env.PROXMOX_NODE, vmid, cores, memory, diskGB }) {
  const payload = {};
  if (cores) payload.cores = Number(cores);
  if (memory) payload.memory = Number(memory); // MB — LXC applies live via cgroups
  if (Object.keys(payload).length) {
    await pveMutate("put", `/nodes/${node}/lxc/${vmid}/config`, payload, { node });
  }
  if (diskGB) {
    await pveMutate("put", `/nodes/${node}/lxc/${vmid}/resize`, {
      disk: "rootfs",
      size: `${Number(diskGB)}G`,
    }, { node, attempts: 120 });
  }
}

export async function startVm({ node = process.env.PROXMOX_NODE, vmid }) {
  // Await the start task — Proxmox can reject boot (license/vcpu/storage)
  // after accepting the request; without this we mark "Powering on" done
  // and hang forever waiting for DHCP/SSH.
  return pveMutate("post", `/nodes/${node}/qemu/${vmid}/status/start`, null, {
    node,
    attempts: 60,
    delayMs: 1500,
  });
}

// --- Snapshots (VM + container) ---------------------------------------------
// The qemu/lxc guest base path — snapshot endpoints are identical under each.
function guestBase(type, node, vmid) {
  return `/nodes/${node}/${type === "container" ? "lxc" : "qemu"}/${vmid}`;
}

// List a guest's snapshots. Proxmox includes a synthetic "current" entry for
// the live state — drop it so callers only see real, restorable snapshots.
export async function listSnapshots({ node = process.env.PROXMOX_NODE, vmid, type = "vm" }) {
  const list = await pveRequest("get", `${guestBase(type, node, vmid)}/snapshot`);
  return (list || []).filter((s) => s.name !== "current");
}

// Create a snapshot. vmstate (include RAM) is qemu-only and only meaningful
// while the VM is running. Awaits the Proxmox task so success/failure is real.
export async function createSnapshot({ node = process.env.PROXMOX_NODE, vmid, type = "vm", snapname, description, vmstate }) {
  const body = { snapname };
  if (description) body.description = description;
  if (vmstate && type !== "container") body.vmstate = 1;
  return pveMutate("post", `${guestBase(type, node, vmid)}/snapshot`, body, { node, attempts: 150 });
}

export async function deleteSnapshot({ node = process.env.PROXMOX_NODE, vmid, type = "vm", snapname }) {
  return pveMutate(
    "delete",
    `${guestBase(type, node, vmid)}/snapshot/${encodeURIComponent(snapname)}`,
    null,
    { node, attempts: 150 }
  );
}

// Roll the guest back to a snapshot. Can take a while (esp. with RAM state), so
// allow a generous task timeout.
export async function rollbackSnapshot({ node = process.env.PROXMOX_NODE, vmid, type = "vm", snapname }) {
  return pveMutate(
    "post",
    `${guestBase(type, node, vmid)}/snapshot/${encodeURIComponent(snapname)}/rollback`,
    null,
    { node, attempts: 300 }
  );
}

// --- Backups (vzdump one-off + scheduled cluster jobs) ----------------------
// Storages on the node that can hold backups (for the storage picker).
export async function listBackupStorages({ node = process.env.PROXMOX_NODE } = {}) {
  const list = await pveRequest("get", `/nodes/${node}/storage`, null, { content: "backup" });
  return (list || []).map((s) => ({ storage: s.storage, type: s.type }));
}

export async function listBackupJobs() {
  return (await pveRequest("get", "/cluster/backup")) || [];
}

export async function createBackupJob(cfg) {
  return pveRequest("post", "/cluster/backup", cfg);
}

export async function updateBackupJob(id, cfg) {
  return pveRequest("put", `/cluster/backup/${encodeURIComponent(id)}`, cfg);
}

export async function deleteBackupJob(id) {
  return pveRequest("delete", `/cluster/backup/${encodeURIComponent(id)}`);
}

// Kick off an immediate backup of a single guest. Long-running — returns the
// task UPID without awaiting it.
export async function runBackup({ node = process.env.PROXMOX_NODE, vmid, storage, mode = "snapshot" }) {
  return pveMutate("post", `/nodes/${node}/vzdump`, { vmid, storage, mode, compress: "zstd" }, {
    node,
    attempts: 600,
    delayMs: 3000,
  });
}

export async function getVmStatus({ node = process.env.PROXMOX_NODE, vmid }) {
  return pveRequest("get", `/nodes/${node}/qemu/${vmid}/status/current`);
}

export async function getVmConfig({ node = process.env.PROXMOX_NODE, vmid }) {
  return pveRequest("get", `/nodes/${node}/qemu/${vmid}/config`);
}

// Poll the VM until Proxmox releases its config lock (e.g. the "clone" lock held
// while the disk copy runs). Resolves once no lock is present.
export async function waitForUnlock({ node = process.env.PROXMOX_NODE, vmid, attempts = 300, delayMs = 2000, onTick } = {}) {
  for (let i = 0; i < attempts; i++) {
    const status = await getVmStatus({ node, vmid }).catch(() => null);
    const lock = status?.lock;
    if (status && !lock) return true;
    if (onTick && lock) onTick(lock);
    await new Promise((r) => setTimeout(r, delayMs));
  }
  throw new ProxmoxTaskError(
    "Proxmox is still locking the VM after cloning (disk copy may be stuck). Try again or ask an admin to check the node.",
    { detail: `Timed out waiting for VMID ${vmid} to unlock after ${attempts} polls.` }
  );
}

// Read a disk's current size in GB from the VM config (e.g. "scsi0").
export async function getDiskSizeGB({ node = process.env.PROXMOX_NODE, vmid, disk = "scsi0" }) {
  const cfg = await getVmConfig({ node, vmid });
  const m = /size=(\d+(?:\.\d+)?)([KMGT])/i.exec(cfg?.[disk] || "");
  if (!m) return null;
  let size = Number(m[1]);
  const unit = m[2].toUpperCase();
  if (unit === "K") size = size / (1024 * 1024);
  if (unit === "M") size = size / 1024;
  if (unit === "T") size = size * 1024;
  return Math.ceil(size);
}

// Attach the VM's primary NIC to a bridge/VLAN. By default we tell cloud-init
// to use DHCP (ipconfig0=ip=dhcp) — Forge does NOT assign a static IP unless
// IPAM is integrated and a reservation is passed in. A dotted iface
// (vmbr0.100) is split into bridge + VLAN tag. Guest agent is enabled so we
// can discover the DHCP-leased address after boot.
export async function setVmNetwork({
  node = process.env.PROXMOX_NODE,
  vmid,
  iface,
  model = "virtio",
  useDhcp = true,
  staticIp = null,
}) {
  let bridge = iface, tag = null;
  const dotted = /^(.+)\.(\d+)$/.exec(iface || "");
  if (dotted) { bridge = dotted[1]; tag = dotted[2]; }

  // 1) Always attach the NIC + enable guest agent (independent of IP mode).
  await pveMutate("put", `/nodes/${node}/qemu/${vmid}/config`, {
    net0: `${model},bridge=${bridge}${tag ? `,tag=${tag}` : ""}`,
    agent: "1",
  }, { node });

  // 2) IP addressing — static only when an IPAM reservation is supplied.
  if (staticIp?.full) {
    const payload = {
      ipconfig0: `ip=${staticIp.full}${staticIp.gateway ? `,gw=${staticIp.gateway}` : ""}`,
    };
    if (staticIp.dns) payload.nameserver = staticIp.dns;
    await pveMutate("put", `/nodes/${node}/qemu/${vmid}/config`, payload, { node });
    return;
  }

  if (!useDhcp) return;

  // DHCP via cloud-init. Soft-fail: some templates lack a cloud-init drive; the
  // guest OS can still lease an address via its own DHCP client on the NIC.
  try {
    await pveMutate("put", `/nodes/${node}/qemu/${vmid}/config`, {
      ipconfig0: "ip=dhcp",
    }, { node });
  } catch (err) {
    console.warn(
      `[proxmox] could not set ipconfig0=dhcp on VM ${vmid} (guest may still use DHCP): ${err.userMessage || err.message}`
    );
  }
}

// Read the VM's IPv4 address from the qemu-guest-agent (requires the agent to
// be installed and running in the guest). Returns the first non-loopback,
// non-link-local IPv4, or null if the agent hasn't reported one yet.
export async function getGuestAgentIp({ node = process.env.PROXMOX_NODE, vmid }) {
  const data = await pveRequest("get", `/nodes/${node}/qemu/${vmid}/agent/network-get-interfaces`)
    .catch(() => null);
  const ifaces = data?.result || data || [];
  for (const nic of ifaces) {
    if ((nic.name || "").toLowerCase() === "lo") continue;
    for (const addr of nic["ip-addresses"] || []) {
      const ip = addr["ip-address"];
      if (addr["ip-address-type"] === "ipv4" && ip && !ip.startsWith("127.") && !ip.startsWith("169.254.")) {
        return ip;
      }
    }
  }
  return null;
}

// Set the VM's Proxmox tags (array joined with ';'). Used to record owner,
// groups and environment so the Resources view can filter by them.
export async function setVmTags({ node = process.env.PROXMOX_NODE, vmid, tags = [] }) {
  await pveMutate("put", `/nodes/${node}/qemu/${vmid}/config`, { tags: tags.join(";") }, { node });
}

// Set tags on a VM or container (array joined with ';').
export async function setTags({ node = process.env.PROXMOX_NODE, vmid, type = "vm", tags = [] }) {
  const base = type === "container" ? "lxc" : "qemu";
  await pveMutate("put", `/nodes/${node}/${base}/${vmid}/config`, { tags: tags.join(";") }, { node });
}

// Read a resource's raw tag string (works for VM or container).
export async function getResourceTags({ node = process.env.PROXMOX_NODE, vmid, type = "vm" }) {
  const base = type === "container" ? "lxc" : "qemu";
  const cfg = await pveRequest("get", `/nodes/${node}/${base}/${vmid}/config`).catch(() => null);
  return cfg?.tags || "";
}

// Read a resource's OS type from its config (works for VM or container).
// VMs return Proxmox ostype codes (e.g. "l26", "win11"); containers return
// the template family (e.g. "ubuntu", "debian"). Returns null if unavailable.
export async function getResourceOsType({ node = process.env.PROXMOX_NODE, vmid, type = "vm" }) {
  const base = type === "container" ? "lxc" : "qemu";
  const cfg = await pveRequest("get", `/nodes/${node}/${base}/${vmid}/config`).catch(() => null);
  return cfg?.ostype || null;
}

// Link a Proxmox snippet as the cloud-init user-data file (cicustom).
export async function setCicustom({ node = process.env.PROXMOX_NODE, vmid, file, storage = process.env.SNIPPET_STORAGE || "local" }) {
  await pveMutate("put", `/nodes/${node}/qemu/${vmid}/config`, {
    cicustom: `user=${storage}:snippets/${file}`,
  }, { node });
}

/** Whether the given storage advertises the `snippets` content type. */
export async function storageSupportsSnippets(storage = process.env.SNIPPET_STORAGE || "local") {
  const name = String(storage || "local").trim() || "local";
  const rows = await listStorage().catch(() => []);
  const row = (rows || []).find((r) => r.storage === name);
  if (!row) return false;
  const content = String(row.content || "");
  return /(^|,)snippets(,|$)/.test(content);
}

// Upload a cloud-init user-data file to the snippets storage on the Proxmox node.
export async function uploadSnippet({
  node = process.env.PROXMOX_NODE,
  storage = process.env.SNIPPET_STORAGE || "local",
  filename,
  content,
}) {
  const storageName = String(storage || "local").trim() || "local";
  if (!(await storageSupportsSnippets(storageName))) {
    throw new ProxmoxTaskError(
      `Proxmox storage "${storageName}" does not allow snippets. In Proxmox: Datacenter → Storage → ${storageName} → Edit → enable "Snippets", then retry.`,
      { detail: `storage=${storageName} content types do not include snippets` },
    );
  }

  await ensureAuth();
  const boundary = `----Forge${Date.now()}`;
  const body = [
    `--${boundary}`,
    'Content-Disposition: form-data; name="content"',
    "",
    "snippets",
    `--${boundary}`,
    'Content-Disposition: form-data; name="filename"',
    "",
    filename,
    `--${boundary}`,
    `Content-Disposition: form-data; name="data"; filename="${filename}"`,
    "Content-Type: application/x-yaml",
    "",
    content,
    `--${boundary}--`,
    "",
  ].join("\r\n");

  const client = ensureClient();
  try {
    await client.post(`/nodes/${node}/storage/${storageName}/upload`, body, {
      headers: {
        ...buildAuthHeaders("post"),
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
      },
      maxBodyLength: Infinity,
    });
  } catch (err) {
    const detail = err.response?.data || err.message;
    const text = extractPveErrorText(detail);
    const hint = /snippet|content type|400/i.test(`${text} ${err.message}`)
      ? ` Check that storage "${storageName}" has Snippets enabled.`
      : "";
    throw new ProxmoxTaskError(
      (mapExitstatusToUserMessage(text, text) || "Proxmox could not upload the cloud-init snippet.") + hint,
      { detail: typeof detail === "string" ? detail : JSON.stringify(detail) }
    );
  }
}

// Read an existing snippet (optional base template from Admin → Mappings).
export async function readSnippetContent({
  node = process.env.PROXMOX_NODE,
  storage = process.env.SNIPPET_STORAGE || "local",
  filename,
}) {
  await ensureAuth();
  const volid = `${storage}:snippets/${filename}`;
  const client = ensureClient();
  const res = await client.get(
    `/nodes/${node}/storage/${storage}/content/${encodeURIComponent(volid)}/download`,
    {
      headers: buildAuthHeaders("get"),
      responseType: "text",
      maxRedirects: 5,
      validateStatus: (s) => s < 400,
    },
  );
  return typeof res.data === "string" ? res.data : String(res.data || "");
}

export async function deleteSnippet({
  node = process.env.PROXMOX_NODE,
  storage = process.env.SNIPPET_STORAGE || "local",
  filename,
}) {
  const volid = `${storage}:snippets/${filename}`;
  await pveRequest(
    "delete",
    `/nodes/${node}/storage/${storage}/content/${encodeURIComponent(volid)}`,
  ).catch(() => {});
}

// --- LXC Container support ---
export async function cloneContainer({
  node = process.env.PROXMOX_NODE,
  templateVmid,
  newVmid,
  hostname,
  storage = "local-lvm",
}) {
  return pveMutate("post", `/nodes/${node}/lxc/${templateVmid}/clone`, {
    newid: newVmid,
    hostname,
    storage,
    full: 1,
  }, { node, attempts: 180, delayMs: 2000 });
}

export async function configureContainer({ node = process.env.PROXMOX_NODE, vmid, cores, memory, swap, staticIp }) {
  const payload = {};
  if (cores) payload.cores = cores;
  if (memory) payload.memory = memory;
  if (swap !== undefined) payload.swap = swap;
  if (staticIp) {
    payload.net0 = `name=eth0,bridge=vmbr0,ip=${staticIp.full},gw=${staticIp.gateway}`;
    payload.nameserver = staticIp.dns;
  }
  await pveMutate("put", `/nodes/${node}/lxc/${vmid}/config`, payload, { node });
}

export async function startContainer({ node = process.env.PROXMOX_NODE, vmid }) {
  return pveMutate("post", `/nodes/${node}/lxc/${vmid}/status/start`, null, {
    node,
    attempts: 60,
    delayMs: 1500,
  });
}

// Read a running container's IPv4 from its interfaces (LXC has no guest agent;
// Proxmox exposes leased addresses directly). Returns null if none yet.
export async function getContainerIp({ node = process.env.PROXMOX_NODE, vmid }) {
  const ifaces = await pveRequest("get", `/nodes/${node}/lxc/${vmid}/interfaces`).catch(() => null);
  for (const nic of ifaces || []) {
    if ((nic.name || "").toLowerCase() === "lo") continue;
    const ip = (nic.inet || "").split("/")[0];
    if (ip && !ip.startsWith("127.") && !ip.startsWith("169.254.")) return ip;
  }
  return null;
}

// --- Lifecycle controls (VM) ---
export async function stopVm({ node = process.env.PROXMOX_NODE, vmid }) {
  return pveMutate("post", `/nodes/${node}/qemu/${vmid}/status/stop`, null, { node, attempts: 60, delayMs: 1000 });
}

export async function shutdownVm({ node = process.env.PROXMOX_NODE, vmid }) {
  return pveMutate("post", `/nodes/${node}/qemu/${vmid}/status/shutdown`, null, { node, attempts: 90, delayMs: 2000 });
}

export async function rebootVm({ node = process.env.PROXMOX_NODE, vmid }) {
  return pveMutate("post", `/nodes/${node}/qemu/${vmid}/status/reboot`, null, { node, attempts: 90, delayMs: 2000 });
}

// Hard reset — the equivalent of pressing the physical reset button. Unlike
// reboot (which asks the guest OS to restart cleanly), this resets the machine
// immediately without notifying the guest, so it can cause data loss.
export async function resetVm({ node = process.env.PROXMOX_NODE, vmid }) {
  return pveMutate("post", `/nodes/${node}/qemu/${vmid}/status/reset`, null, { node, attempts: 60, delayMs: 1000 });
}

// Poll a VM/container until Proxmox reports it stopped (or we give up). Used to
// gate a destroy behind a clean stop, since Proxmox refuses to destroy a
// running guest.
async function waitForStopped({ node = process.env.PROXMOX_NODE, vmid, type = "vm", attempts = 30, delayMs = 1000 } = {}) {
  const getStatus = type === "container" ? getContainerStatus : getVmStatus;
  for (let i = 0; i < attempts; i++) {
    const s = await getStatus({ node, vmid }).catch(() => null);
    if (!s || s.status === "stopped") return true;
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return false;
}

export async function deleteVm({ node = process.env.PROXMOX_NODE, vmid }) {
  // A running VM can't be destroyed — force-stop it first and wait until the
  // hypervisor reports it stopped before removing it.
  const status = await getVmStatus({ node, vmid }).catch(() => null);
  if (status && status.status !== "stopped") {
    await pveMutate("post", `/nodes/${node}/qemu/${vmid}/status/stop`, null, { node, attempts: 60, delayMs: 1000 })
      .catch(() => {});
    await waitForStopped({ node, vmid, type: "vm" });
  }
  // purge=1 removes the VM from all configs; destroy-unreferenced-disks cleans LVs
  return pveMutate(
    "delete",
    `/nodes/${node}/qemu/${vmid}?purge=1&destroy-unreferenced-disks=1`,
    null,
    { node, attempts: 120 }
  );
}

// --- Lifecycle controls (Container) ---
export async function stopContainer({ node = process.env.PROXMOX_NODE, vmid }) {
  return pveMutate("post", `/nodes/${node}/lxc/${vmid}/status/stop`, null, { node, attempts: 60, delayMs: 1000 });
}

export async function shutdownContainer({ node = process.env.PROXMOX_NODE, vmid }) {
  return pveMutate("post", `/nodes/${node}/lxc/${vmid}/status/shutdown`, null, { node, attempts: 90, delayMs: 2000 });
}

export async function rebootContainer({ node = process.env.PROXMOX_NODE, vmid }) {
  return pveMutate("post", `/nodes/${node}/lxc/${vmid}/status/reboot`, null, { node, attempts: 90, delayMs: 2000 });
}

export async function deleteContainer({ node = process.env.PROXMOX_NODE, vmid }) {
  // Same as VMs: stop a running container before destroying it.
  const status = await getContainerStatus({ node, vmid }).catch(() => null);
  if (status && status.status !== "stopped") {
    await pveMutate("post", `/nodes/${node}/lxc/${vmid}/status/stop`, null, { node, attempts: 60, delayMs: 1000 })
      .catch(() => {});
    await waitForStopped({ node, vmid, type: "container" });
  }
  return pveMutate(
    "delete",
    `/nodes/${node}/lxc/${vmid}?purge=1&destroy-unreferenced-disks=1`,
    null,
    { node, attempts: 120 }
  );
}

// --- Inventory & metrics ---
/**
 * Prefer /cluster/resources (authoritative inventory). Fall back to the
 * per-node qemu/lxc lists, always filtering out non-guest index rows.
 */
async function listGuestsFromCluster({ node } = {}) {
  const target = await resolvePveNode(node);
  const rows = (await pveRequest("get", "/cluster/resources", null, { type: "vm" })) || [];
  return rows.filter((r) => isGuestRecord(r) && (!r.node || r.node === target));
}

async function listGuestsFromNode(kind, { node } = {}) {
  const target = await resolvePveNode(node);
  const path = kind === "lxc" ? `/nodes/${target}/lxc` : `/nodes/${target}/qemu`;
  const rows = (await pveRequest("get", path)) || [];
  // If Proxmox (or a misconfigured proxy) returns the node directory index
  // instead of guests, every row lacks a vmid — drop them all.
  return rows.filter(isGuestRecord);
}

export async function listAllVms(opts = {}) {
  let rows = [];
  try {
    rows = (await listGuestsFromCluster(opts)).filter((r) => r.type === "qemu");
  } catch {
    rows = [];
  }
  if (!rows.length) {
    try {
      rows = await listGuestsFromNode("qemu", opts);
    } catch {
      rows = [];
    }
  }
  return rows.filter((vm) => !isProxmoxTemplate(vm));
}

export async function listAllContainers(opts = {}) {
  let rows = [];
  try {
    rows = (await listGuestsFromCluster(opts)).filter((r) => r.type === "lxc");
  } catch {
    rows = [];
  }
  if (!rows.length) {
    try {
      rows = await listGuestsFromNode("lxc", opts);
    } catch {
      rows = [];
    }
  }
  return rows.filter((ct) => !isProxmoxTemplate(ct));
}

export async function getNodeStatus(opts = {}) {
  const node = await resolvePveNode(opts.node);
  return pveRequest("get", `/nodes/${node}/status`);
}

export async function getClusterResources() {
  return pveRequest("get", "/cluster/resources");
}

// List storages on the node with their capacity/usage (total, used, avail in
// bytes) and the content types they hold. Used to size the storage pool when
// estimating the capacity impact of a provisioning request.
export async function listStorage(opts = {}) {
  const node = await resolvePveNode(opts.node);
  return pveRequest("get", `/nodes/${node}/storage`);
}

// List network interfaces on the node (bridges, VLANs, bonds, etc.). Used by
// the admin Mappings page to auto-detect available VM networks.
export async function listNetworks(opts = {}) {
  const node = await resolvePveNode(opts.node);
  return pveRequest("get", `/nodes/${node}/network`);
}

// List cloud-init snippet files available in a storage (defaults to `local`,
// which is backed by /var/lib/vz/snippets). Returns bare filenames.
export async function listSnippets(opts = {}) {
  const node = await resolvePveNode(opts.node);
  const storage = opts.storage || process.env.SNIPPET_STORAGE || "local";
  const items = await pveRequest(
    "get",
    `/nodes/${node}/storage/${storage}/content`,
    null,
    { content: "snippets" }
  );
  return (items || [])
    .map((i) => (i.volid || "").split("/").pop())
    .filter(Boolean);
}

export async function getContainerStatus({ node = process.env.PROXMOX_NODE, vmid }) {
  return pveRequest("get", `/nodes/${node}/lxc/${vmid}/status/current`);
}

// Read every VM and container config and extract any IPv4 addresses that fall
// in a static ipconfig/net definition. Used to reconcile the IP pool against
// resources that Forge didn't create (e.g. manually-built VMs on Proxmox).
export async function getUsedIpsFromConfigs({ node = process.env.PROXMOX_NODE }) {
  const ips = new Set();
  const ipRegex = /ip=(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/g;

  const extract = (configObj) => {
    for (const [key, val] of Object.entries(configObj || {})) {
      if (typeof val !== "string") continue;
      // VM cloud-init uses ipconfig0..N; LXC uses net0..N
      if (key.startsWith("ipconfig") || key.startsWith("net")) {
        let m;
        while ((m = ipRegex.exec(val)) !== null) {
          ips.add(m[1]);
        }
      }
    }
  };

  const [vms, cts] = await Promise.all([
    pveRequest("get", `/nodes/${requirePveNode(node)}/qemu`).catch(() => []),
    pveRequest("get", `/nodes/${requirePveNode(node)}/lxc`).catch(() => []),
  ]);

  const liveVms = (vms || []).filter((vm) => isGuestRecord(vm) && !isProxmoxTemplate(vm));
  const liveCts = (cts || []).filter((ct) => isGuestRecord(ct) && !isProxmoxTemplate(ct));

  await Promise.all([
    ...liveVms.map((vm) =>
      pveRequest("get", `/nodes/${requirePveNode(node)}/qemu/${vm.vmid}/config`).then(extract).catch(() => {})
    ),
    ...liveCts.map((ct) =>
      pveRequest("get", `/nodes/${requirePveNode(node)}/lxc/${ct.vmid}/config`).then(extract).catch(() => {})
    ),
  ]);

  return ips;
}

// Live getter — reflects the current (possibly runtime-updated) node name.
export const getPveNode = () => process.env.PROXMOX_NODE || autoDetectedNode || "";

// Lightweight connectivity check for the admin Settings tab. Forces a fresh
// auth against the current config and reads node status; returns node info or
// throws with the Proxmox error message.
export async function testConnection({ light = false } = {}) {
  const cfg = pveConfig();
  if (usesTokenAuth(cfg)) {
    if (!cfg.tokenId?.trim() || !cfg.tokenSecret) {
      throw new Error("API token ID and secret are required when token auth is enabled");
    }
  } else if (!cfg.username || !cfg.password) {
    throw new Error("Proxmox username and password are required");
  }
  if (!cfg.host?.trim()) {
    throw new Error("Proxmox host is not configured");
  }
  ticket = null;
  ticketExpiry = 0;
  clearPveNodeCache();
  const node = await resolvePveNode();
  const status = await getNodeStatus({ node });
  if (light) {
    return {
      node,
      host: process.env.PROXMOX_HOST,
      auth: usesTokenAuth(cfg) ? "api-token" : "password",
      uptime: status?.uptime ?? null,
      pveversion: status?.pveversion ?? null,
    };
  }
  const [vms, containers, templates] = await Promise.all([
    listAllVms({ node }).catch(() => []),
    listAllContainers({ node }).catch(() => []),
    listTemplates({ node }).catch(() => []),
  ]);
  return {
    node,
    host: process.env.PROXMOX_HOST,
    auth: usesTokenAuth(cfg) ? "api-token" : "password",
    uptime: status?.uptime ?? null,
    pveversion: status?.pveversion ?? null,
    guestCounts: { vms: vms.length, containers: containers.length, templates: templates.length },
  };
}
