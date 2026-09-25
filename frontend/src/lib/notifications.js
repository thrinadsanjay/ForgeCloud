/** Shared notification helpers for bell + inbox page. */

export function timeAgo(iso) {
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function notificationLevel(n) {
  const raw = String(n?.meta?.level || "").toLowerCase();
  if (raw === "error" || raw === "danger" || raw === "failed") return "error";
  if (raw === "warn" || raw === "warning") return "warn";
  if (raw === "success" || raw === "ok") return "success";
  if (raw === "info") return "info";

  const t = `${n?.type || ""} ${n?.title || ""}`;
  if (/fail|reject|error|crash|expired/i.test(t)) return "error";
  if (/warn|expir|stopped|removed|approval needed/i.test(t) || n?.type === "approval") return "warn";
  if (/complete|approved|ready|success|added|created|updated|saved|digest/i.test(t)) return "success";
  return "info";
}

export function notificationCategory(n) {
  const c = n?.meta?.category;
  if (c === "action" || c === "update") return c;
  const level = notificationLevel(n);
  if (level === "error" || level === "warn") return "action";
  const t = String(n?.type || "");
  if (/approval|fail|reject|expir/i.test(t)) return "action";
  return "update";
}

export const LEVEL_ICON = {
  error: "✕",
  warn: "!",
  success: "✓",
  info: "i",
};

export function resolveNotificationLink(n) {
  if (n?.link) return n.link;
  const m = n?.meta || {};
  const rid = m.requestId ? encodeURIComponent(m.requestId) : null;
  const jid = m.jobId ? encodeURIComponent(m.jobId) : null;
  switch (n?.type) {
    case "approval":
      return rid ? `/deployments?tab=hold&request=${rid}` : "/deployments?tab=hold";
    case "approved":
      return jid
        ? `/deployments?tab=running&job=${jid}`
        : rid
          ? `/deployments?tab=running&request=${rid}`
          : "/deployments?tab=running";
    case "provision_complete":
      return jid
        ? `/deployments?tab=completed&job=${jid}`
        : "/deployments?tab=completed";
    case "provision_failed":
    case "rejected":
    case "resize_failed":
      return jid
        ? `/deployments?tab=failed&job=${jid}`
        : rid
          ? `/deployments?tab=failed&request=${rid}`
          : "/deployments?tab=failed";
    case "resize_approved":
      return m.vmid
        ? `/resources?reboot=${encodeURIComponent(m.vmid)}${rid ? `&request=${rid}` : ""}`
        : "/resources";
    case "renew_approved":
    case "resource_expiring":
    case "resource_expired":
      return "/resources?tab=compute";
    case "renew_failed":
      return rid
        ? `/deployments?tab=failed&request=${rid}`
        : "/deployments?tab=failed";
    default:
      return "/deployments";
  }
}

/**
 * Collapse same-type notifications from the same calendar day into one row
 * (unless already a backend digest with digestKey).
 */
export function groupNotifications(items) {
  const map = new Map();
  for (const n of items || []) {
    const day = String(n.createdAt || "").slice(0, 10);
    const key = n.meta?.digestKey || `${notificationCategory(n)}|${n.type}|${day}|${notificationLevel(n)}`;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(n);
  }

  const groups = [];
  for (const [key, notes] of map) {
    notes.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    if (notes.length === 1) {
      groups.push({
        id: notes[0].id,
        kind: "single",
        note: notes[0],
        level: notificationLevel(notes[0]),
        category: notificationCategory(notes[0]),
        unread: !notes[0].read,
        createdAt: notes[0].createdAt,
        title: notes[0].title,
        message: notes[0].message,
        link: resolveNotificationLink(notes[0]),
        ids: [notes[0].id],
      });
      continue;
    }

    const level = notes.reduce((worst, n) => {
      const order = { error: 3, warn: 2, info: 1, success: 0 };
      const l = notificationLevel(n);
      return (order[l] || 0) >= (order[worst] || 0) ? l : worst;
    }, "info");

    const typeLabel = notes[0].type?.replace(/_/g, " ") || "updates";
    groups.push({
      id: key,
      kind: "group",
      notes,
      level,
      category: notificationCategory(notes[0]),
      unread: notes.some((n) => !n.read),
      createdAt: notes[0].createdAt,
      title: `${notes.length} ${typeLabel}`,
      message: notes.map((n) => n.title).slice(0, 4).join(" · ")
        + (notes.length > 4 ? ` · +${notes.length - 4} more` : ""),
      link: resolveNotificationLink(notes[0]),
      ids: notes.map((n) => n.id),
    });
  }

  return groups.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}
