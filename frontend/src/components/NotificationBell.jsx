import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  getNotifications,
  markNotificationRead,
  markNotificationsReadMany,
  markAllNotificationsRead,
} from "../api/client.js";
import {
  timeAgo,
  LEVEL_ICON,
  groupNotifications,
  notificationCategory,
} from "../lib/notifications.js";

const POLL_MS = 25000;
const POPOVER_LIMIT = 10;

const TABS = [
  { id: "action", label: "Needs action" },
  { id: "update", label: "Updates" },
  { id: "all", label: "All" },
];

export default function NotificationBell() {
  const [items, setItems] = useState([]);
  const [actionUnread, setActionUnread] = useState(0);
  const [updateUnread, setUpdateUnread] = useState(0);
  const [tab, setTab] = useState("action");
  const [expanded, setExpanded] = useState(null);
  const [open, setOpen] = useState(false);
  const [busyIds, setBusyIds] = useState(() => new Set());
  const rootRef = useRef(null);
  const navigate = useNavigate();

  const load = () => getNotifications({ limit: 80 })
    .then((d) => {
      setItems(d.notifications || []);
      setActionUnread(d.actionUnread || 0);
      setUpdateUnread(d.updateUnread || 0);
    })
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

  const filtered = useMemo(() => {
    if (tab === "all") return items;
    return items.filter((n) => notificationCategory(n) === tab);
  }, [items, tab]);

  const groups = useMemo(() => groupNotifications(filtered).slice(0, POPOVER_LIMIT), [filtered]);
  const totalUnread = actionUnread + updateUnread;
  const badge = actionUnread;

  const unreadIdsFor = (g) => (g.ids || []).filter((id) => {
    const n = items.find((x) => x.id === id);
    return n && !n.read;
  });

  const openGroup = async (g) => {
    setOpen(false);
    const unreadIds = unreadIdsFor(g);
    if (unreadIds.length === 1) {
      try { await markNotificationRead(unreadIds[0]); } catch { /* ignore */ }
    } else if (unreadIds.length > 1) {
      try { await markNotificationsReadMany(unreadIds); } catch { /* ignore */ }
    }
    load();
    if (g.link) navigate(g.link);
  };

  const markGroupRead = async (g, e) => {
    e?.stopPropagation?.();
    e?.preventDefault?.();
    const ids = unreadIdsFor(g);
    if (!ids.length) return;
    setBusyIds((prev) => new Set([...prev, g.id]));
    try {
      if (ids.length === 1) await markNotificationRead(ids[0]);
      else await markNotificationsReadMany(ids);
      await load();
    } catch { /* ignore */ }
    setBusyIds((prev) => {
      const next = new Set(prev);
      next.delete(g.id);
      return next;
    });
  };

  const markOneRead = async (id, e) => {
    e?.stopPropagation?.();
    e?.preventDefault?.();
    const n = items.find((x) => x.id === id);
    if (!n || n.read) return;
    setBusyIds((prev) => new Set([...prev, id]));
    try {
      await markNotificationRead(id);
      await load();
    } catch { /* ignore */ }
    setBusyIds((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  };

  const markAll = async (e) => {
    e?.stopPropagation?.();
    try {
      await markAllNotificationsRead({ category: tab === "all" ? "all" : tab });
      await load();
    } catch { /* ignore */ }
  };

  return (
    <div className="notif-bell" ref={rootRef}>
      <button
        type="button"
        className="notif-bell-btn"
        aria-label={`Notifications${badge ? ` (${badge} need attention)` : ""}`}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span aria-hidden="true">🔔</span>
        {badge > 0 && <span className="notif-badge">{badge > 9 ? "9+" : badge}</span>}
      </button>

      {open && (
        <div className="notif-popover" role="menu">
          <div className="notif-popover-head">
            <span>Notifications</span>
            <button
              type="button"
              className="notif-markall"
              disabled={totalUnread === 0}
              onClick={markAll}
              title={tab === "all" ? "Mark all notifications as read" : `Mark all in “${TABS.find((t) => t.id === tab)?.label}” as read`}
            >
              Mark all as read
            </button>
          </div>

          <div className="notif-tabs" role="tablist">
            {TABS.map((t) => {
              const count = t.id === "action" ? actionUnread : t.id === "update" ? updateUnread : totalUnread;
              return (
                <button
                  key={t.id}
                  type="button"
                  role="tab"
                  aria-selected={tab === t.id}
                  className={`notif-tab ${tab === t.id ? "is-active" : ""}`}
                  onClick={() => { setTab(t.id); setExpanded(null); }}
                >
                  {t.label}
                  {count > 0 && <span className="notif-tab-count">{count}</span>}
                </button>
              );
            })}
          </div>

          <div className="notif-list">
            {groups.length === 0 && (
              <div className="notif-empty">
                {tab === "action" ? "Nothing needs your attention." : "You're all caught up."}
              </div>
            )}
            {groups.map((g) => {
              const unread = unreadIdsFor(g).length > 0;
              return (
                <div key={g.id} className={`notif-group ${unread ? "notif-item-unread" : ""}`}>
                  <div className={`notif-row notif-item-${g.level}`}>
                    <button
                      type="button"
                      className="notif-item notif-item-main"
                      onClick={() => openGroup(g)}
                    >
                      <span className={`notif-item-icon notif-icon-${g.level}`} aria-hidden="true">
                        {LEVEL_ICON[g.level]}
                      </span>
                      <span className="notif-item-body">
                        <span className="notif-item-title">{g.title}</span>
                        {g.message && <span className="notif-item-msg">{g.message}</span>}
                        <span className="notif-item-time">{timeAgo(g.createdAt)}</span>
                      </span>
                    </button>
                    <button
                      type="button"
                      className={`notif-read-bubble ${unread ? "is-unread" : "is-read"}`}
                      disabled={!unread || busyIds.has(g.id)}
                      title={unread ? "Mark as read" : "Read"}
                      aria-label={unread ? "Mark as read" : "Already read"}
                      onClick={(e) => markGroupRead(g, e)}
                    >
                      {busyIds.has(g.id) ? "…" : unread ? "" : "✓"}
                    </button>
                  </div>
                  {g.kind === "group" && (
                    <button
                      type="button"
                      className="notif-expand"
                      onClick={(e) => {
                        e.stopPropagation();
                        setExpanded(expanded === g.id ? null : g.id);
                      }}
                    >
                      {expanded === g.id ? "Hide" : `Show ${g.notes.length}`}
                    </button>
                  )}
                  {expanded === g.id && g.notes?.map((n) => (
                    <div key={n.id} className={`notif-row notif-row-nested notif-item-${g.level}`}>
                      <button
                        type="button"
                        className="notif-item notif-item-main notif-item-nested"
                        onClick={() => openGroup({
                          ...g,
                          kind: "single",
                          ids: [n.id],
                          link: n.link || g.link,
                          notes: [n],
                        })}
                      >
                        <span className="notif-item-body">
                          <span className="notif-item-title">{n.title}</span>
                          {n.message && <span className="notif-item-msg">{n.message}</span>}
                        </span>
                      </button>
                      <button
                        type="button"
                        className={`notif-read-bubble ${n.read ? "is-read" : "is-unread"}`}
                        disabled={!!n.read || busyIds.has(n.id)}
                        title={n.read ? "Read" : "Mark as read"}
                        aria-label={n.read ? "Already read" : "Mark as read"}
                        onClick={(e) => markOneRead(n.id, e)}
                      >
                        {busyIds.has(n.id) ? "…" : n.read ? "✓" : ""}
                      </button>
                    </div>
                  ))}
                </div>
              );
            })}
          </div>

          <div className="notif-popover-foot">
            <button
              type="button"
              className="notif-viewall"
              onClick={() => { setOpen(false); navigate("/notifications"); }}
            >
              View all notifications
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
