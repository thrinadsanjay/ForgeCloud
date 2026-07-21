import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { getNotifications, markNotificationRead, markAllNotificationsRead } from "../api/client.js";

const POLL_MS = 25000;

function timeAgo(iso) {
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

const TYPE_ICON = {
  approval: "🛡",
  approved: "✅",
  rejected: "🚫",
  resize_approved: "🔧",
  resize_failed: "⚠",
  provision_complete: "✅",
  provision_failed: "⚠",
  info: "🔔",
};

/** Deep-link for a notification — prefer stored link, else derive from type/meta. */
function resolveNotificationLink(n) {
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
      return m.vmid
        ? `/resources?vmid=${encodeURIComponent(m.vmid)}`
        : "/resources";
    case "renew_failed":
      return rid
        ? `/deployments?tab=failed&request=${rid}`
        : "/deployments?tab=failed";
    default:
      return "/deployments";
  }
}

// Bell in the top nav: polls the inbox, shows an unread badge, and a dropdown of
// notifications. Clicking one marks it read and navigates to its linked page
// (approval review, deployment log, or resize reboot prompt).
export default function NotificationBell() {
  const [items, setItems] = useState([]);
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);
  const navigate = useNavigate();

  const load = () => getNotifications()
    .then((d) => { setItems(d.notifications || []); setUnread(d.unread || 0); })
    .catch(() => {});

  useEffect(() => {
    load();
    const t = setInterval(load, POLL_MS);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    const onDocClick = (e) => { if (!rootRef.current?.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  const openItem = async (n) => {
    setOpen(false);
    if (!n.read) {
      try { await markNotificationRead(n.id); } catch { /* ignore */ }
      load();
    }
    const to = resolveNotificationLink(n);
    if (to) navigate(to);
  };

  const markAll = async () => {
    try { await markAllNotificationsRead(); } catch { /* ignore */ }
    load();
  };

  return (
    <div className="notif-bell" ref={rootRef}>
      <button
        type="button"
        className="notif-bell-btn"
        aria-label={`Notifications${unread ? ` (${unread} unread)` : ""}`}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span aria-hidden="true">🔔</span>
        {unread > 0 && <span className="notif-badge">{unread > 9 ? "9+" : unread}</span>}
      </button>

      {open && (
        <div className="notif-popover" role="menu">
          <div className="notif-popover-head">
            <span>Notifications</span>
            {unread > 0 && <button type="button" className="notif-markall" onClick={markAll}>Mark all read</button>}
          </div>
          <div className="notif-list">
            {items.length === 0 && <div className="notif-empty">You're all caught up.</div>}
            {items.map((n) => (
              <button
                type="button"
                key={n.id}
                className={`notif-item ${n.read ? "" : "notif-item-unread"}`}
                onClick={() => openItem(n)}
              >
                <span className="notif-item-icon" aria-hidden="true">{TYPE_ICON[n.type] || "🔔"}</span>
                <span className="notif-item-body">
                  <span className="notif-item-title">{n.title}</span>
                  {n.message && <span className="notif-item-msg">{n.message}</span>}
                  <span className="notif-item-time">{timeAgo(n.createdAt)}</span>
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
