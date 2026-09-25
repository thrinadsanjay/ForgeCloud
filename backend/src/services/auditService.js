import { nanoid } from "nanoid";
import { prisma, fireAndForget } from "../db/client.js";

const MAX_ENTRIES = 5000;

let entries = [];

export async function hydrateAudit() {
  const rows = await prisma.auditEntry.findMany({ orderBy: { timestamp: "asc" } });
  entries = rows.map((row) => ({
    id: row.id,
    timestamp: row.timestamp.toISOString(),
    actor: row.actor,
    action: row.action,
    target: row.target,
    status: row.status,
    detail: row.detail || {},
  }));
}

function persistEntry(entry) {
  fireAndForget(
    prisma.auditEntry.create({
      data: {
        id: entry.id,
        timestamp: new Date(entry.timestamp),
        actor: entry.actor,
        action: entry.action,
        target: entry.target || "",
        status: entry.status,
        detail: entry.detail || {},
      },
    }),
    "audit"
  );
}

export function logAudit({ actor, action, target = "", status = "success", detail = {} }) {
  const entry = {
    id: nanoid(10),
    timestamp: new Date().toISOString(),
    actor: actor ? { id: actor.id, username: actor.username, role: actor.role } : { username: "system" },
    action,
    target,
    status,
    detail,
  };
  entries.push(entry);
  if (entries.length > MAX_ENTRIES) {
    const removed = entries.slice(0, entries.length - MAX_ENTRIES);
    entries = entries.slice(-MAX_ENTRIES);
    fireAndForget(
      prisma.auditEntry.deleteMany({ where: { id: { in: removed.map((e) => e.id) } } }),
      "audit-trim"
    );
  }
  persistEntry(entry);
}

export function listAudit({ limit = 200, action, username } = {}) {
  let list = entries.slice().reverse();
  if (action) list = list.filter((e) => e.action === action);
  if (username) list = list.filter((e) => e.actor?.username === username);
  return list.slice(0, limit);
}
