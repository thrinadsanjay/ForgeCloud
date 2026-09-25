import { nanoid } from "nanoid";
import { prisma, fireAndForget } from "../db/client.js";

const MAX_NOTIFICATIONS = 500;

/** Retention: info/success expire sooner; action items (error/warn) keep longer. */
const RETENTION_MS = {
  info: 7 * 86400000,
  success: 7 * 86400000,
  warn: 30 * 86400000,
  error: 30 * 86400000,
};
const READ_GRACE_MS = {
  info: 24 * 3600000,
  success: 24 * 3600000,
  warn: 7 * 86400000,
  error: 7 * 86400000,
};

const ACTION_TYPES = new Set([
  "approval",
  "provision_failed",
  "rejected",
  "resize_failed",
  "renew_failed",
  "resource_expired",
  "resource_expiring",
]);

let notifications = [];

export async function hydrateNotifications() {
  const rows = await prisma.notification.findMany({ orderBy: { createdAt: "desc" }, take: MAX_NOTIFICATIONS });
  notifications = rows.map(rowToNote);
  pruneExpired({ persist: true });
}

function rowToNote(row) {
  const meta = row.meta || {};
  const level = normalizeLevel(meta.level || levelFromType(row.type));
  return {
    id: row.id,
    recipient: row.recipient,
    role: row.role,
    type: row.type,
    title: row.title,
    message: row.message,
    link: row.link,
    meta: { ...meta, level, category: meta.category || categoryFor(row.type, level) },
    read: row.read,
    createdAt: row.createdAt.toISOString(),
  };
}

function persistAll() {
  pruneExpired({ persist: false });
  const trimmed = notifications
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    .slice(0, MAX_NOTIFICATIONS);
  notifications = trimmed;
  fireAndForget(
    prisma.$transaction([
      prisma.notification.deleteMany(),
      ...trimmed.map((n) =>
        prisma.notification.create({
          data: {
            id: n.id,
            recipient: n.recipient,
            role: n.role,
            type: n.type,
            title: n.title,
            message: n.message,
            link: n.link,
            meta: n.meta || {},
            read: n.read,
            createdAt: new Date(n.createdAt),
          },
        })
      ),
    ]),
    "notifications"
  );
}

export function normalizeLevel(level) {
  const v = String(level || "info").toLowerCase();
  if (v === "error" || v === "danger" || v === "failed") return "error";
  if (v === "warn" || v === "warning") return "warn";
  if (v === "success" || v === "ok") return "success";
  return "info";
}

export function levelFromType(type) {
  const t = String(type || "");
  if (/fail|reject|error|crash|expired$/i.test(t)) return "error";
  if (/warn|expir|stopped|removed|approval$/i.test(t) || t === "approval") return "warn";
  if (/complete|approved|ready|success|added|created|updated|digest/i.test(t)) return "success";
  return "info";
}

export function categoryFor(type, level) {
  if (ACTION_TYPES.has(String(type || ""))) return "action";
  if (level === "error" || level === "warn") return "action";
  return "update";
}

function noteLevel(n) {
  return normalizeLevel(n?.meta?.level || levelFromType(n?.type));
}

function isExpired(n, now = Date.now()) {
  const level = noteLevel(n);
  const created = new Date(n.createdAt).getTime();
  const age = now - created;
  if (age > (RETENTION_MS[level] || RETENTION_MS.info)) return true;
  if (n.read) {
    const grace = READ_GRACE_MS[level] || READ_GRACE_MS.info;
    if (age > grace && (level === "info" || level === "success")) return true;
  }
  return false;
}

export function pruneExpired({ persist = true } = {}) {
  const before = notifications.length;
  notifications = notifications.filter((n) => !isExpired(n));
  if (persist && notifications.length !== before) persistAll();
  return before - notifications.length;
}

export function addNotification({
  recipient = null,
  role = null,
  type = "info",
  level = null,
  category = null,
  title,
  message = "",
  link = null,
  meta = {},
}) {
  const resolvedLevel = normalizeLevel(level || meta.level || levelFromType(type));
  const resolvedCategory = category || meta.category || categoryFor(type, resolvedLevel);
  const note = {
    id: nanoid(10),
    recipient,
    role,
    type,
    title,
    message,
    link,
    meta: { ...meta, level: resolvedLevel, category: resolvedCategory },
    read: false,
    createdAt: new Date().toISOString(),
  };
  notifications.push(note);
  persistAll();
  return note;
}

/**
 * Merge many similar events into one inbox row (e.g. expiry warnings).
 * digestKey should include day + audience, e.g. `expiry-warn:alice:2026-08-07`.
 */
export function upsertDigest({
  recipient = null,
  role = null,
  digestKey,
  type = "digest",
  level = "warn",
  title,
  itemTitle,
  itemMessage = "",
  link = null,
  maxItems = 8,
}) {
  if (!digestKey) throw new Error("digestKey is required");
  const resolvedLevel = normalizeLevel(level);
  const category = categoryFor(type, resolvedLevel);

  let note = notifications.find((n) => (
    n.meta?.digestKey === digestKey
    && n.recipient === recipient
    && n.role === role
  ));

  const entry = {
    title: itemTitle || title,
    message: itemMessage,
    at: new Date().toISOString(),
  };

  if (!note) {
    note = {
      id: nanoid(10),
      recipient,
      role,
      type,
      title,
      message: itemMessage || itemTitle || "",
      link,
      meta: {
        level: resolvedLevel,
        category,
        digestKey,
        items: [entry],
      },
      read: false,
      createdAt: new Date().toISOString(),
    };
    notifications.push(note);
  } else {
    const items = Array.isArray(note.meta.items) ? [...note.meta.items] : [];
    items.unshift(entry);
    let overflow = Number(note.meta.overflow || 0);
    if (items.length > maxItems) {
      overflow += items.length - maxItems;
      items.length = maxItems;
    }
    note.meta = {
      ...note.meta,
      level: resolvedLevel,
      category,
      digestKey,
      items,
      overflow,
    };
    const count = items.length + overflow;
    note.title = count > 1 ? `${title} (${count})` : title;
    note.message = items.map((i) => i.title).slice(0, 4).join(" · ")
      + (count > 4 ? ` · +${count - 4} more` : "");
    note.link = link || note.link;
    note.read = false;
    note.createdAt = new Date().toISOString();
  }

  persistAll();
  return note;
}

export function notifyAdmins(payload) {
  return addNotification({ ...payload, role: "admin", recipient: null });
}

/** Admins + Deployment Approvers (size-policy holds). */
export function notifyReviewers(payload) {
  addNotification({ ...payload, role: "admin", recipient: null });
  return addNotification({ ...payload, role: "approver", recipient: null });
}

export function notifyUser(username, payload) {
  return addNotification({ ...payload, recipient: username, role: null });
}

function isForUser(note, user) {
  if (note.recipient && note.recipient === user.username) return true;
  if (note.role && note.role === user.role) return true;
  return false;
}

function sortNewest(a, b) {
  return a.createdAt < b.createdAt ? 1 : -1;
}

export function listForUser(user, { limit = 50, category = null } = {}) {
  pruneExpired({ persist: false });
  return notifications
    .filter((n) => isForUser(n, user))
    .filter((n) => {
      if (!category || category === "all") return true;
      return (n.meta?.category || categoryFor(n.type, noteLevel(n))) === category;
    })
    .sort(sortNewest)
    .slice(0, limit);
}

export function unreadCountForUser(user, { category = null } = {}) {
  pruneExpired({ persist: false });
  return notifications.filter((n) => {
    if (!isForUser(n, user) || n.read) return false;
    if (!category || category === "all") return true;
    return (n.meta?.category || categoryFor(n.type, noteLevel(n))) === category;
  }).length;
}

export function markRead(id, user) {
  const note = notifications.find((n) => n.id === id && isForUser(n, user));
  if (!note) return false;
  note.read = true;
  persistAll();
  return true;
}

export function markManyRead(ids, user) {
  let changed = 0;
  const set = new Set(ids || []);
  for (const n of notifications) {
    if (set.has(n.id) && isForUser(n, user) && !n.read) {
      n.read = true;
      changed += 1;
    }
  }
  if (changed) persistAll();
  return changed;
}

export function markAllRead(user, { category = null } = {}) {
  let changed = 0;
  for (const n of notifications) {
    if (!isForUser(n, user) || n.read) continue;
    if (category && category !== "all") {
      const cat = n.meta?.category || categoryFor(n.type, noteLevel(n));
      if (cat !== category) continue;
    }
    n.read = true;
    changed += 1;
  }
  if (changed) persistAll();
  return changed;
}

export function dismissNotification(id, user) {
  const idx = notifications.findIndex((n) => n.id === id && isForUser(n, user));
  if (idx < 0) return false;
  notifications.splice(idx, 1);
  persistAll();
  return true;
}
