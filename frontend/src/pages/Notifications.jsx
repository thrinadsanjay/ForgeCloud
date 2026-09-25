import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import {
  getNotifications,
  markNotificationRead,
  markNotificationsReadMany,
  markAllNotificationsRead,
  dismissNotification,
} from "../api/client.js";
import {
  timeAgo,
  LEVEL_ICON,
  groupNotifications,
  notificationCategory,
  resolveNotificationLink,
} from "../lib/notifications.js";

const TABS = [
  { id: "action", label: "Needs action" },
  { id: "update", label: "Updates" },
  { id: "all", label: "All" },
];

export default function Notifications() {
  const [params, setParams] = useSearchParams();
  const tab = ["action", "update", "all"].includes(params.get("tab")) ? params.get("tab") : "action";
  const [items, setItems] = useState([]);
  const [actionUnread, setActionUnread] = useState(0);
  const [updateUnread, setUpdateUnread] = useState(0);
  const [expanded, setExpanded] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busyIds, setBusyIds] = useState(() => new Set());
  const navigate = useNavigate();

  const load = useCallback(() => {
    setLoading(true);
    getNotifications({ limit: 200 })
      .then((d) => {
        setItems(d.notifications || []);
        setActionUnread(d.actionUnread || 0);
        setUpdateUnread(d.updateUnread || 0);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  const filtered = useMemo(() => {
    if (tab === "all") return items;
    return items.filter((n) => notificationCategory(n) === tab);
  }, [items, tab]);

  const groups = useMemo(() => groupNotifications(filtered), [filtered]);
  const totalUnread = actionUnread + updateUnread;

  const setTab = (id) => {
    setParams(id === "action" ? {} : { tab: id });
    setExpanded(null);
  };

  const unreadIdsFor = (g) => (g.ids || []).filter((id) => items.find((x) => x.id === id && !x.read));

  const openGroup = async (g) => {
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

  const dismiss = async (id, e) => {
    e?.stopPropagation?.();
    try { await dismissNotification(id); } catch { /* ignore */ }
    load();
  };

  return (
    <div className="page">
      <div className="page-head page-head-row">
        <div>
          <h1>Notifications</h1>
          <p className="muted">Actionable alerts stay here; quiet updates are grouped and expire automatically.</p>
        </div>
        <div className="notif-page-actions">
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={totalUnread === 0}
            onClick={async () => {
              await markAllNotificationsRead({ category: "all" });
              load();
            }}
          >
            Mark all as read
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            disabled={(tab === "action" ? actionUnread : tab === "update" ? updateUnread : totalUnread) === 0}
            onClick={async () => {
              await markAllNotificationsRead({ category: tab === "all" ? "all" : tab });
              load();
            }}
          >
            Mark tab as read
          </button>
          <Link className="btn btn-ghost btn-sm" to="/deployments">Deployments</Link>
        </div>
      </div>

      <div className="notif-tabs notif-tabs-page" role="tablist">
        {TABS.map((t) => {
          const count = t.id === "action" ? actionUnread : t.id === "update" ? updateUnread : totalUnread;
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              className={`notif-tab ${tab === t.id ? "is-active" : ""}`}
              onClick={() => setTab(t.id)}
            >
              {t.label}
              {count > 0 && <span className="notif-tab-count">{count}</span>}
            </button>
          );
        })}
      </div>

      {loading && <p className="muted">Loading…</p>}
      {!loading && groups.length === 0 && (
        <div className="notif-empty notif-empty-page">
          {tab === "action" ? "Nothing needs your attention." : "No notifications in this view."}
        </div>
      )}

      <div className="notif-page-list">
        {groups.map((g) => {
          const unread = unreadIdsFor(g).length > 0;
          return (
            <div key={g.id} className={`notif-card notif-item-${g.level} ${unread ? "is-unread" : ""}`}>
              <button type="button" className="notif-card-main" onClick={() => openGroup(g)}>
                <span className={`notif-item-icon notif-icon-${g.level}`} aria-hidden="true">
                  {LEVEL_ICON[g.level]}
                </span>
                <span className="notif-item-body">
                  <span className="notif-item-title">{g.title}</span>
                  {g.message && <span className="notif-item-msg">{g.message}</span>}
                  <span className="notif-item-time">{timeAgo(g.createdAt)}</span>
                </span>
              </button>
              <div className="notif-card-side">
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
                {g.kind === "group" && (
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => setExpanded(expanded === g.id ? null : g.id)}
                  >
                    {expanded === g.id ? "Collapse" : `Expand (${g.notes.length})`}
                  </button>
                )}
                {g.kind === "single" && (
                  <button type="button" className="btn btn-ghost btn-sm" onClick={(e) => dismiss(g.ids[0], e)}>
                    Dismiss
                  </button>
                )}
              </div>
              {expanded === g.id && g.notes?.map((n) => (
                <div key={n.id} className="notif-card-child">
                  <button
                    type="button"
                    className="notif-card-main"
                    onClick={() => openGroup({
                      kind: "single",
                      ids: [n.id],
                      link: resolveNotificationLink(n),
                    })}
                  >
                    <span className="notif-item-body">
                      <span className="notif-item-title">{n.title}</span>
                      {n.message && <span className="notif-item-msg">{n.message}</span>}
                      <span className="notif-item-time">{timeAgo(n.createdAt)}</span>
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
                  <button type="button" className="btn btn-ghost btn-sm" onClick={(e) => dismiss(n.id, e)}>
                    Dismiss
                  </button>
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
