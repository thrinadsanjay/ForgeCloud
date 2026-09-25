import { groupsForUser, listGroups, getGroup } from "./groupStore.js";
import { allOwners, listOwned } from "./ownershipStore.js";
import { listUsers } from "./userStore.js";
import { getCostRates } from "./settingsStore.js";
import * as pve from "./proxmoxService.js";

async function guestIndex() {
  try {
    const [vms, cts] = await Promise.all([
      pve.listAllVms({}).catch(() => []),
      pve.listAllContainers({}).catch(() => []),
    ]);
    const map = new Map();
    for (const g of [...vms, ...cts]) {
      map.set(Number(g.vmid), {
        vmid: Number(g.vmid),
        name: g.name || `vm-${g.vmid}`,
        type: g.type || (g.maxdisk != null && g.cpus != null ? "qemu" : "lxc"),
        status: g.status || "unknown",
        cpu: Number(g.cpus || g.maxcpu || 0) || 0,
        memoryGB: g.maxmem ? Math.round(g.maxmem / 1024 ** 3) : 0,
        diskGB: g.maxdisk ? Math.round(g.maxdisk / 1024 ** 3) : 0,
      });
    }
    return map;
  } catch {
    return new Map();
  }
}

function estimateMonthly(cpu, memoryGB, diskGB, rates) {
  const r = rates || getCostRates();
  return Math.round(
    (Number(cpu) || 0) * (r.perCpu || 0)
    + (Number(memoryGB) || 0) * (r.perGbRam || 0)
    + (Number(diskGB) || 0) * (r.perGbStorage || 0),
  );
}

function emptyTotals() {
  return { vms: 0, cpu: 0, memoryGB: 0, diskGB: 0, estimatedMonthly: 0 };
}

function addResource(totals, guest, rates) {
  const cpu = guest?.cpu || 0;
  const memoryGB = guest?.memoryGB || 0;
  const diskGB = guest?.diskGB || 0;
  totals.vms += 1;
  totals.cpu += cpu;
  totals.memoryGB += memoryGB;
  totals.diskGB += diskGB;
  totals.estimatedMonthly += estimateMonthly(cpu, memoryGB, diskGB, rates);
}

function resourceRow(vmid, owner, guest, rates) {
  const cpu = guest?.cpu || 0;
  const memoryGB = guest?.memoryGB || 0;
  const diskGB = guest?.diskGB || 0;
  return {
    vmid: Number(vmid),
    hostname: owner?.hostname || guest?.name || `vm-${vmid}`,
    ip: owner?.ip || null,
    status: guest?.status || "unknown",
    type: guest?.type || "qemu",
    cpu,
    memoryGB,
    diskGB,
    estimatedMonthly: estimateMonthly(cpu, memoryGB, diskGB, rates),
    owner: owner?.username || null,
  };
}

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

/** Build per-user aggregates + resource lists from ownership + Proxmox guest index. */
export async function buildUsageReport() {
  const rates = getCostRates();
  const guests = await guestIndex();
  const owners = allOwners();
  const usersByName = new Map(listUsers().map((u) => [String(u.username).toLowerCase(), u]));

  const byUser = new Map();

  for (const [vmid, owner] of Object.entries(owners)) {
    const uname = String(owner.username || "").toLowerCase();
    if (!uname) continue;
    if (!byUser.has(uname)) {
      const u = usersByName.get(uname);
      byUser.set(uname, {
        username: owner.username,
        displayName: u?.displayName || owner.username,
        role: u?.role || "user",
        totals: emptyTotals(),
        resources: [],
      });
    }
    const row = byUser.get(uname);
    const guest = guests.get(Number(vmid));
    addResource(row.totals, guest || { cpu: 0, memoryGB: 0, diskGB: 0 }, rates);
    row.resources.push(resourceRow(vmid, owner, guest, rates));
  }

  // Include users with zero resources so admins still see them.
  for (const u of listUsers()) {
    const key = String(u.username).toLowerCase();
    if (!byUser.has(key)) {
      byUser.set(key, {
        username: u.username,
        displayName: u.displayName || u.username,
        role: u.role || "user",
        totals: emptyTotals(),
        resources: [],
      });
    }
  }

  const users = Array.from(byUser.values())
    .map((u) => ({
      ...u,
      resources: u.resources.sort((a, b) => (a.hostname || "").localeCompare(b.hostname || "")),
    }))
    .sort((a, b) => b.totals.estimatedMonthly - a.totals.estimatedMonthly
      || b.totals.vms - a.totals.vms
      || a.username.localeCompare(b.username));

  const teams = [];
  for (const g of listGroups()) {
    const quotas = normalizeQuotas(g.quotas);
    const members = (g.members || []).map((m) => String(m).toLowerCase());
    const memberSet = new Set(members);
    const totals = emptyTotals();
    const memberUsage = [];
    const resources = [];

    for (const u of users) {
      if (!memberSet.has(String(u.username).toLowerCase())) continue;
      memberUsage.push({
        username: u.username,
        displayName: u.displayName,
        totals: { ...u.totals },
        resourceCount: u.resources.length,
      });
      totals.vms += u.totals.vms;
      totals.cpu += u.totals.cpu;
      totals.memoryGB += u.totals.memoryGB;
      totals.diskGB += u.totals.diskGB;
      totals.estimatedMonthly += u.totals.estimatedMonthly;
      resources.push(...u.resources.map((r) => ({ ...r, owner: u.username })));
    }

    teams.push({
      name: g.name,
      memberCount: members.length,
      quotas,
      used: {
        vms: totals.vms,
        cpu: totals.cpu,
        memoryGB: totals.memoryGB,
      },
      remaining: {
        vms: quotas.maxVms ? Math.max(0, quotas.maxVms - totals.vms) : null,
        cpu: quotas.maxCpu ? Math.max(0, quotas.maxCpu - totals.cpu) : null,
        memoryGB: quotas.maxMemoryGB ? Math.max(0, quotas.maxMemoryGB - totals.memoryGB) : null,
      },
      limited: !!(quotas.maxVms || quotas.maxCpu || quotas.maxMemoryGB),
      totals,
      members: memberUsage.sort((a, b) => b.totals.estimatedMonthly - a.totals.estimatedMonthly),
      resources: resources.sort((a, b) => (a.hostname || "").localeCompare(b.hostname || "")),
    });
  }

  teams.sort((a, b) => b.totals.estimatedMonthly - a.totals.estimatedMonthly
    || a.name.localeCompare(b.name));

  const overview = users.reduce((acc, u) => {
    acc.vms += u.totals.vms;
    acc.cpu += u.totals.cpu;
    acc.memoryGB += u.totals.memoryGB;
    acc.diskGB += u.totals.diskGB;
    acc.estimatedMonthly += u.totals.estimatedMonthly;
    return acc;
  }, emptyTotals());

  return {
    currency: rates.currency || "INR",
    rates: {
      perCpu: rates.perCpu,
      perGbRam: rates.perGbRam,
      perGbStorage: rates.perGbStorage,
    },
    disclaimer: "Estimated showback from catalog rates × current CPU / RAM / disk — not an invoice.",
    overview: {
      ...overview,
      users: users.length,
      teams: teams.length,
      usersWithResources: users.filter((u) => u.totals.vms > 0).length,
    },
    teams,
    users,
  };
}

export async function getMyUsage(username) {
  const report = await buildUsageReport();
  const key = String(username || "").toLowerCase();
  const me = report.users.find((u) => String(u.username).toLowerCase() === key) || {
    username,
    displayName: username,
    role: "user",
    totals: emptyTotals(),
    resources: [],
  };

  const myTeamNames = new Set(groupsForUser(username).map((n) => String(n).toLowerCase()));
  const teams = report.teams.filter((t) => myTeamNames.has(String(t.name).toLowerCase()));

  return {
    currency: report.currency,
    rates: report.rates,
    disclaimer: report.disclaimer,
    me,
    teams,
  };
}

export async function getTeamUsageDetail(teamName, { viewer, isAdmin } = {}) {
  const name = String(teamName || "").trim();
  const g = getGroup(name);
  if (!g) {
    const err = new Error("Team not found");
    err.status = 404;
    throw err;
  }
  const member = (g.members || []).some((m) => String(m).toLowerCase() === String(viewer || "").toLowerCase());
  if (!isAdmin && !member) {
    const err = new Error("Not authorized to view this team");
    err.status = 403;
    throw err;
  }
  const report = await buildUsageReport();
  const team = report.teams.find((t) => t.name === g.name);
  if (!team) {
    return {
      currency: report.currency,
      rates: report.rates,
      disclaimer: report.disclaimer,
      team: {
        name: g.name,
        memberCount: (g.members || []).length,
        quotas: normalizeQuotas(g.quotas),
        used: { vms: 0, cpu: 0, memoryGB: 0 },
        remaining: { vms: null, cpu: null, memoryGB: null },
        limited: false,
        totals: emptyTotals(),
        members: [],
        resources: [],
      },
    };
  }
  return {
    currency: report.currency,
    rates: report.rates,
    disclaimer: report.disclaimer,
    team,
  };
}

/** @deprecated helper kept for call sites that only need owned list shape */
export async function listOwnedWithSpecs(username) {
  const guests = await guestIndex();
  const rates = getCostRates();
  return listOwned(username).map((o) => {
    const guest = guests.get(Number(o.vmid));
    return resourceRow(o.vmid, o, guest, rates);
  });
}
