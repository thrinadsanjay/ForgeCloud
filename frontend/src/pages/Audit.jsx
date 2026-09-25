import { Fragment, useEffect, useMemo, useState } from "react";
import { getAudit } from "../api/client.js";
import EmptyState from "../components/EmptyState.jsx";
import AdminPageHeader from "../components/AdminPageHeader.jsx";

function fmtAbsolute(iso) {
  const d = new Date(iso);
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function fmtRelative(iso) {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return fmtAbsolute(iso);
  const sec = Math.floor(ms / 1000);
  if (sec < 45) return "just now";
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 14) return `${d}d ago`;
  return fmtAbsolute(iso);
}

const ACTION_LABELS = {
  "auth.login": "Sign in",
  "vm.create": "Create VM",
  "vm.request": "Request VM",
  "vm.start": "Start VM", "vm.stop": "Stop VM", "vm.shutdown": "Shutdown VM",
  "vm.reboot": "Reboot VM", "vm.delete": "Delete VM",
  "container.create": "Create container",
  "container.request": "Request container",
  "container.start": "Start container", "container.stop": "Stop container",
  "container.shutdown": "Shutdown container", "container.reboot": "Reboot container",
  "container.delete": "Delete container",
  "stack.create": "Create stack",
  "stack.request": "Request stack",
  "user.create": "Create user", "user.update_role": "Change role", "user.delete": "Delete user",
};

function actionFamily(action) {
  const a = String(action || "");
  if (a.startsWith("auth.")) return { key: "auth", label: "Auth" };
  if (a.startsWith("servicenow") || a.includes("snow") || a.includes("ritm") || a.includes("cmdb")) {
    return { key: "itsm", label: "ITSM" };
  }
  if (a.startsWith("user.") || a.startsWith("group.") || a.startsWith("admin.")) {
    return { key: "admin", label: "Admin" };
  }
  if (/\.(request|approve|reject)/.test(a) || a.includes("provision")) {
    return { key: "provision", label: "Provision" };
  }
  if (a.startsWith("vm.") || a.startsWith("container.") || a.startsWith("stack.")) {
    return { key: "lifecycle", label: "Lifecycle" };
  }
  return { key: "other", label: "Other" };
}

function detailPreview(detail) {
  if (!detail || typeof detail !== "object") return null;
  const keys = Object.keys(detail);
  if (!keys.length) return null;
  try {
    return JSON.stringify(detail, null, 2);
  } catch {
    return String(detail);
  }
}

export default function Audit() {
  const [entries, setEntries] = useState([]);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [actionFilter, setActionFilter] = useState("all");
  const [page, setPage] = useState(1);
  const [expanded, setExpanded] = useState(null);

  const load = () => getAudit({ limit: 300 }).then(setEntries).catch((e) => setError(e.response?.data?.error || e.message));
  useEffect(() => { load(); const t = setInterval(load, 15000); return () => clearInterval(t); }, []);
  useEffect(() => { setPage(1); }, [filter, statusFilter, actionFilter]);

  const shown = filter
    ? entries.filter((e) =>
        (e.actor?.username || "").toLowerCase().includes(filter.toLowerCase()) ||
        (e.action || "").toLowerCase().includes(filter.toLowerCase()) ||
        (e.target || "").toLowerCase().includes(filter.toLowerCase()))
    : entries;

  const actionKeys = Array.from(new Set(entries.map((e) => e.action).filter(Boolean))).sort();
  const filtered = shown.filter((e) => {
    const statusOk = statusFilter === "all" || e.status === statusFilter;
    const actionOk = actionFilter === "all" || e.action === actionFilter;
    return statusOk && actionOk;
  });
  const pageSize = 25;
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const pageStart = (safePage - 1) * pageSize;
  const pageItems = filtered.slice(pageStart, pageStart + pageSize);

  const stats = useMemo(() => {
    const ok = entries.filter((e) => e.status === "success").length;
    const fail = entries.filter((e) => e.status === "failed").length;
    const latest = entries[0]?.timestamp;
    return { ok, fail, latest };
  }, [entries]);

  return (
    <div className="page adm-board">
      <AdminPageHeader
        title="Audit log"
        description="Every provisioning, lifecycle, and access event — newest first."
      />

      {error && <div className="login-error">{error}</div>}

      <div className="adm-stat-grid">
        <div className="adm-stat-card">
          <span className="adm-stat-icon is-brand" aria-hidden="true">≡</span>
          <div>
            <div className="adm-stat-label">Events</div>
            <div className="adm-stat-value">{entries.length}</div>
            <div className="adm-stat-hint">{filtered.length} matching</div>
          </div>
        </div>
        <div className="adm-stat-card">
          <span className="adm-stat-icon is-ok" aria-hidden="true">✓</span>
          <div>
            <div className="adm-stat-label">Success</div>
            <div className="adm-stat-value">{stats.ok}</div>
            <div className="adm-stat-hint">Loaded window</div>
          </div>
        </div>
        <div className="adm-stat-card">
          <span className="adm-stat-icon is-danger" aria-hidden="true">!</span>
          <div>
            <div className="adm-stat-label">Failed</div>
            <div className="adm-stat-value">{stats.fail}</div>
            <div className="adm-stat-hint">Needs attention</div>
          </div>
        </div>
        <div className="adm-stat-card">
          <span className="adm-stat-icon is-blue" aria-hidden="true">◷</span>
          <div>
            <div className="adm-stat-label">Latest</div>
            <div className="adm-stat-value adm-stat-sm">{stats.latest ? fmtRelative(stats.latest) : "—"}</div>
            <div className="adm-stat-hint">{stats.latest ? fmtAbsolute(stats.latest) : "No events yet"}</div>
          </div>
        </div>
      </div>

      <div className="adm-board-toolbar">
        <input
          className="control-input adm-board-search"
          placeholder="Filter by user, action, or target…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          aria-label="Filter audit events"
        />
        <select className="control-select" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
          <option value="all">All results</option>
          <option value="success">Success</option>
          <option value="failed">Failed</option>
        </select>
        <select className="control-select" value={actionFilter} onChange={(e) => setActionFilter(e.target.value)}>
          <option value="all">All actions</option>
          {actionKeys.map((action) => (
            <option key={action} value={action}>{ACTION_LABELS[action] || action}</option>
          ))}
        </select>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          disabled={filtered.length === 0}
          onClick={() => {
            const blob = new Blob([JSON.stringify(filtered, null, 2)], { type: "application/json" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = `forge-audit-${new Date().toISOString().slice(0, 10)}.json`;
            a.click();
            URL.revokeObjectURL(url);
          }}
        >
          Export JSON
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          disabled={filtered.length === 0}
          onClick={() => {
            const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
            const header = ["timestamp", "actor", "action", "target", "status", "detail"];
            const lines = [header.join(",")];
            for (const e of filtered) {
              lines.push([
                esc(e.timestamp),
                esc(e.actor?.username || "system"),
                esc(e.action),
                esc(e.target),
                esc(e.status),
                esc(typeof e.detail === "string" ? e.detail : JSON.stringify(e.detail || {})),
              ].join(","));
            }
            const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = `forge-audit-${new Date().toISOString().slice(0, 10)}.csv`;
            a.click();
            URL.revokeObjectURL(url);
          }}
        >
          Export CSV
        </button>
      </div>

      <div className="adm-table-wrap">
        <div className="adm-table-head">
          <h3 className="adm-table-title">Events</h3>
          <span className="muted adm-table-count">{filtered.length} shown</span>
        </div>
        <div className="adm-scroll">
          {filtered.length === 0 ? (
            <EmptyState
              icon="📋"
              title="No matching events"
              description={entries.length === 0
                ? "Audit events appear as users sign in and provision resources."
                : "Try clearing the search or result filters."}
              actionLabel={entries.length ? "Clear filters" : undefined}
              onAction={entries.length ? () => { setFilter(""); setStatusFilter("all"); setActionFilter("all"); } : undefined}
            />
          ) : (
            <table className="table table-dense audit-table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>User</th>
                  <th>Action</th>
                  <th>Target</th>
                  <th>Result</th>
                  <th aria-label="Detail" />
                </tr>
              </thead>
              <tbody>
                {pageItems.map((e) => {
                  const family = actionFamily(e.action);
                  const detail = detailPreview(e.detail);
                  const open = expanded === e.id;
                  return (
                    <Fragment key={e.id}>
                      <tr className={open ? "audit-row-open" : undefined}>
                        <td className="mono" title={fmtAbsolute(e.timestamp)}>{fmtRelative(e.timestamp)}</td>
                        <td>{e.actor?.username || "system"}</td>
                        <td>
                          <div className="audit-action">
                            <span className={`audit-family audit-family-${family.key}`}>{family.label}</span>
                            <span>{ACTION_LABELS[e.action] || e.action}</span>
                          </div>
                        </td>
                        <td className="mono audit-target">{e.target || "—"}</td>
                        <td>
                          <span className={`badge ${e.status === "success" ? "badge-running" : "badge-failed"}`}>{e.status}</span>
                        </td>
                        <td>
                          {detail ? (
                            <button
                              type="button"
                              className="btn btn-ghost btn-sm"
                              aria-expanded={open}
                              onClick={() => setExpanded(open ? null : e.id)}
                            >
                              {open ? "Hide" : "Detail"}
                            </button>
                          ) : (
                            <span className="muted">—</span>
                          )}
                        </td>
                      </tr>
                      {open && detail && (
                        <tr className="audit-detail-row">
                          <td colSpan={6}>
                            <pre className="audit-detail-pre">{detail}</pre>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {filtered.length > 0 && (
        <div className="pagination-row">
          <button className="btn btn-ghost btn-sm" disabled={safePage <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>Previous</button>
          <span className="muted">Page {safePage} / {totalPages}</span>
          <button className="btn btn-ghost btn-sm" disabled={safePage >= totalPages} onClick={() => setPage((p) => Math.min(totalPages, p + 1))}>Next</button>
        </div>
      )}
    </div>
  );
}
