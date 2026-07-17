import { groupsForUser, getGroup } from "./groupStore.js";
import { allOwners } from "./ownershipStore.js";
import * as pve from "./proxmoxService.js";

function normalizeQuotas(raw) {
  const q = raw && typeof raw === "object" ? raw : {};
  const num = (v) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  };
  return {
    maxVms: num(q.maxVms),
    maxCpu: num(q.maxCpu),
    maxMemoryGB: num(q.maxMemoryGB),
  };
}

async function guestIndex() {
  try {
    const [vms, cts] = await Promise.all([
      pve.listAllVms({}).catch(() => []),
      pve.listAllContainers({}).catch(() => []),
    ]);
    const map = new Map();
    for (const g of [...vms, ...cts]) {
      map.set(Number(g.vmid), g);
    }
    return map;
  } catch {
    return new Map();
  }
}

export async function getGroupUsage(groupName) {
  const g = getGroup(groupName);
  if (!g) return { vms: 0, cpu: 0, memoryGB: 0 };
  const members = new Set((g.members || []).map((m) => String(m).toLowerCase()));
  const guests = await guestIndex();
  let vms = 0;
  let cpu = 0;
  let memoryGB = 0;
  for (const [vmid, owner] of Object.entries(allOwners())) {
    if (!members.has(String(owner.username || "").toLowerCase())) continue;
    vms += 1;
    const guest = guests.get(Number(vmid));
    if (guest) {
      cpu += Number(guest.cpus || guest.maxcpu || 0);
      memoryGB += guest.maxmem ? Math.round(guest.maxmem / 1024 ** 3) : 0;
    }
  }
  return { vms, cpu, memoryGB };
}

// Enforce team quotas for any group the requestor belongs to.
// Limits of 0 mean unlimited. Resize requests skip quota (net footprint can shrink).
export async function checkTeamQuotas(username, { kind, cpu = 0, memoryGB = 0, units = 1 } = {}) {
  if (!username || kind === "resize") return { ok: true };
  const names = groupsForUser(username);
  if (!names.length) return { ok: true };

  const addVms = Math.max(1, Number(units) || 1);
  const addCpu = Math.max(0, Number(cpu) || 0) * addVms;
  const addMem = Math.max(0, Number(memoryGB) || 0) * addVms;

  for (const name of names) {
    const g = getGroup(name);
    if (!g) continue;
    const q = normalizeQuotas(g.quotas);
    if (!q.maxVms && !q.maxCpu && !q.maxMemoryGB) continue;

    const used = await getGroupUsage(name);

    if (q.maxVms && used.vms + addVms > q.maxVms) {
      return {
        ok: false,
        group: name,
        reason: `Team "${name}" VM quota exceeded (${used.vms + addVms} / ${q.maxVms})`,
      };
    }
    if (q.maxCpu && used.cpu + addCpu > q.maxCpu) {
      return {
        ok: false,
        group: name,
        reason: `Team "${name}" CPU quota exceeded (${used.cpu + addCpu} / ${q.maxCpu} cores)`,
      };
    }
    if (q.maxMemoryGB && used.memoryGB + addMem > q.maxMemoryGB) {
      return {
        ok: false,
        group: name,
        reason: `Team "${name}" memory quota exceeded (${used.memoryGB + addMem} / ${q.maxMemoryGB} GB)`,
      };
    }
  }
  return { ok: true };
}
