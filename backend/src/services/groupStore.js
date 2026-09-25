import { prisma, fireAndForget } from "../db/client.js";

let groups = {};

export async function hydrateGroups() {
  const rows = await prisma.group.findMany();
  groups = {};
  for (const row of rows) {
    groups[row.name] = {
      name: row.name,
      members: Array.isArray(row.members) ? row.members : [],
      quotas: row.quotas && typeof row.quotas === "object" ? row.quotas : {},
      createdAt: row.createdAt.toISOString(),
    };
  }
}

function persistGroup(g) {
  fireAndForget(
    prisma.group.upsert({
      where: { name: g.name },
      create: {
        name: g.name,
        members: g.members,
        quotas: g.quotas || {},
        createdAt: new Date(g.createdAt),
      },
      update: { members: g.members, quotas: g.quotas || {} },
    }),
    "group"
  );
}

function deleteGroupRow(name) {
  fireAndForget(prisma.group.delete({ where: { name } }), "group-delete");
}

export function listGroups() {
  return Object.values(groups).sort((a, b) => a.name.localeCompare(b.name));
}

export function getGroup(name) {
  return groups[name] || null;
}

function normalizeQuotas(input = {}) {
  const num = (v) => {
    if (v === "" || v == null) return 0;
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  };
  return {
    maxVms: num(input.maxVms),
    maxCpu: num(input.maxCpu),
    maxMemoryGB: num(input.maxMemoryGB),
  };
}

export function createGroup(name) {
  const clean = String(name || "").trim();
  if (!clean) throw new Error("Group name is required");
  if (groups[clean]) throw new Error(`Group "${clean}" already exists`);
  groups[clean] = {
    name: clean,
    members: [],
    quotas: { maxVms: 0, maxCpu: 0, maxMemoryGB: 0 },
    createdAt: new Date().toISOString(),
  };
  persistGroup(groups[clean]);
  return groups[clean];
}

export function setGroupQuotas(name, quotas) {
  const g = groups[name];
  if (!g) throw new Error("Group not found");
  g.quotas = normalizeQuotas(quotas);
  persistGroup(g);
  return g;
}

export function deleteGroup(name) {
  if (!groups[name]) throw new Error("Group not found");
  delete groups[name];
  deleteGroupRow(name);
}

export function addMember(name, username) {
  const g = groups[name];
  if (!g) throw new Error("Group not found");
  if (!g.members.includes(username)) g.members.push(username);
  persistGroup(g);
  return g;
}

export function removeMember(name, username) {
  const g = groups[name];
  if (!g) throw new Error("Group not found");
  g.members = g.members.filter((m) => m !== username);
  persistGroup(g);
  return g;
}

export function groupsForUser(username) {
  if (!username) return [];
  const uname = String(username).toLowerCase();
  return Object.values(groups)
    .filter((g) => g.members.some((m) => String(m).toLowerCase() === uname))
    .map((g) => g.name);
}
