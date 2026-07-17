import { nanoid } from "nanoid";
import { prisma, fireAndForget } from "../db/client.js";

const MAX_NOTIFICATIONS = 500;

let notifications = [];

export async function hydrateNotifications() {
  const rows = await prisma.notification.findMany({ orderBy: { createdAt: "desc" }, take: MAX_NOTIFICATIONS });
  notifications = rows.map((row) => ({
    id: row.id,
    recipient: row.recipient,
    role: row.role,
    type: row.type,
    title: row.title,
    message: row.message,
    link: row.link,
    meta: row.meta || {},
    read: row.read,
    createdAt: row.createdAt.toISOString(),
  }));
}

function persistAll() {
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

export function addNotification({ recipient = null, role = null, type = "info", title, message = "", link = null, meta = {} }) {
  const note = {
    id: nanoid(10),
    recipient,
    role,
    type,
    title,
    message,
    link,
    meta,
    read: false,
    createdAt: new Date().toISOString(),
  };
  notifications.push(note);
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

export function listForUser(user, { limit = 50 } = {}) {
  return notifications
    .filter((n) => isForUser(n, user))
    .slice(0, limit);
}

export function unreadCountForUser(user) {
  return notifications.filter((n) => isForUser(n, user) && !n.read).length;
}

export function markRead(id, user) {
  const note = notifications.find((n) => n.id === id && isForUser(n, user));
  if (!note) return false;
  note.read = true;
  persistAll();
  return true;
}

export function markAllRead(user) {
  let changed = 0;
  for (const n of notifications) {
    if (isForUser(n, user) && !n.read) { n.read = true; changed += 1; }
  }
  if (changed) persistAll();
  return changed;
}
