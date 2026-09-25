import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { getResources, resourceAction, confirmResizeReboot } from "../api/client.js";
import { useAuth } from "../context/AuthContext.jsx";
import { useDialog } from "../components/DialogProvider.jsx";
import TerminalModal from "../components/TerminalModal.jsx";
import EditResourceModal from "../components/EditResourceModal.jsx";
import ExtendExpiryModal from "../components/ExtendExpiryModal.jsx";
import PowerMenu from "../components/PowerMenu.jsx";
import RowMenu from "../components/RowMenu.jsx";
import TagsMenu from "../components/TagsMenu.jsx";
import SnapshotModal from "../components/SnapshotModal.jsx";
import BackupModal from "../components/BackupModal.jsx";
import {
  IconPlay,
  IconPower,
  IconReboot,
  IconTerminal,
  IconEdit,
  IconCalendarPlus,
  IconTrash,
  IconServer,
  IconBox,
  IconActions,
  IconCamera,
  IconArchive,
} from "../components/icons.jsx";
import EmptyState from "../components/EmptyState.jsx";
import ProviderStatusBanner from "../components/ProviderStatusBanner.jsx";
import useProviderHealth from "../hooks/useProviderHealth.js";

function fmtMem(b) {
  if (!b) return "—";
  return `${(b / 1024 ** 3).toFixed(0)}G`;
}

function fmtDisk(r) {
  if (r.maxdiskGB) return `${r.maxdiskGB}G`;
  if (r.maxdisk) return `${(r.maxdisk / 1024 ** 3).toFixed(0)}G`;
  return "—";
}

function fmtSpecs(r) {
  const cpu = r.cpu ? `${r.cpu}c` : "—";
  return `${cpu} · ${fmtMem(r.maxmem)} · ${fmtDisk(r)}`;
}

function dayKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Right-rail month calendar: next 30 days of expiries beside the inventory table. */
function ExpiryCalendar({ resources, onRenew }) {
  const [selectedKey, setSelectedKey] = useState(null);

  const today = startOfDay(new Date());
  const horizon = new Date(today);
  horizon.setDate(today.getDate() + 29);

  const soon = resources
    .filter((r) => r.expiresAt)
    .map((r) => ({ ...r, _at: new Date(r.expiresAt).getTime() }))
    .filter((r) => {
      if (!Number.isFinite(r._at)) return false;
      // Include already-expired (from yesterday) through +30 days.
      return r._at >= today.getTime() - 86400_000 && r._at <= horizon.getTime() + 86400_000;
    })
    .sort((a, b) => a._at - b._at);

  const byDay = new Map();
  for (const r of soon) {
    const k = dayKey(new Date(r.expiresAt));
    if (!byDay.has(k)) byDay.set(k, []);
    byDay.get(k).push(r);
  }

  // Calendar grid: pad from Sunday of the week containing today through
  // the Saturday after (or on) the 30-day horizon — a real month-style sheet.
  const gridStart = new Date(today);
  gridStart.setDate(today.getDate() - today.getDay());
  const gridEnd = new Date(horizon);
  gridEnd.setDate(horizon.getDate() + (6 - horizon.getDay()));

  const cells = [];
  for (let d = new Date(gridStart); d <= gridEnd; d.setDate(d.getDate() + 1)) {
    cells.push(new Date(d));
  }

  const activeKey = selectedKey && byDay.has(selectedKey)
    ? selectedKey
    : (soon[0] ? dayKey(new Date(soon[0].expiresAt)) : dayKey(today));
  const activeItems = byDay.get(activeKey) || [];
  const monthLabel = today.toLocaleDateString(undefined, { month: "long", year: "numeric" });

  return (
    <aside className="expiry-cal expiry-cal-side card card-pad" aria-label="Expiry calendar">
      <div className="expiry-cal-head">
        <strong>Expiring soon</strong>
        <p className="muted">
          {monthLabel} · next 30 days
          {soon.length > 0 ? ` · ${soon.length}` : ""}
        </p>
      </div>

      <div className="expiry-cal-month" role="grid" aria-label="30-day expiry calendar">
        <div className="expiry-cal-dow-row" role="row">
          {DOW.map((d) => (
            <div key={d} className="expiry-cal-dow-h" role="columnheader">{d[0]}</div>
          ))}
        </div>
        <div className="expiry-cal-weeks">
          {cells.map((d) => {
            const k = dayKey(d);
            const items = byDay.get(k) || [];
            const inWindow = d >= today && d <= horizon;
            const isToday = k === dayKey(today);
            const isSelected = k === activeKey && items.length > 0;
            const outside = !inWindow;
            return (
              <button
                key={k}
                type="button"
                role="gridcell"
                disabled={outside && items.length === 0}
                className={[
                  "expiry-cal-cell",
                  outside ? "is-outside" : "",
                  isToday ? "is-today" : "",
                  items.length ? "has-items" : "",
                  isSelected ? "is-selected" : "",
                  d < today ? "is-past" : "",
                ].filter(Boolean).join(" ")}
                title={items.length ? items.map((r) => r.name || `VMID ${r.vmid}`).join(", ") : undefined}
                onClick={() => {
                  if (items.length) setSelectedKey(k);
                }}
              >
                <span className="expiry-cal-cell-num">{d.getDate()}</span>
                {items.length > 0 && (
                  <span className="expiry-cal-dot" aria-label={`${items.length} expiring`}>
                    {items.length > 1 ? items.length : ""}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      <div className="expiry-cal-detail">
        {soon.length === 0 ? (
          <p className="expiry-cal-empty muted">Nothing expires in the next 30 days.</p>
        ) : (
          <>
            <div className="expiry-cal-detail-label">
              {new Date(`${activeKey}T12:00:00`).toLocaleDateString(undefined, {
                weekday: "short",
                month: "short",
                day: "numeric",
              })}
              {activeItems.length === 0 ? " · pick a marked day" : ""}
            </div>
            <ul className="expiry-cal-list">
              {(activeItems.length ? activeItems : soon.slice(0, 4)).map((r) => (
                <li key={`${r.type}-${r.vmid}`}>
                  <div className="expiry-cal-item-text">
                    <span className="mono">{r.name || `VMID ${r.vmid}`}</span>
                    <span className="muted">
                      {r.expired ? "Expired" : `${r.daysLeft ?? "?"}d left`}
                    </span>
                  </div>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => onRenew?.(r)}>
                    Renew
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </aside>
  );
}

// Render an expiry cell: a badge coloured by how close (or past) the date is.
function ExpiryCell({ r }) {
  if (!r.expiresAt) return <span className="muted">—</span>;
  const when = new Date(r.expiresAt).toLocaleDateString();
  if (r.expired) return <span className="badge badge-danger" title={when}>Expired</span>;
  const soon = r.daysLeft != null && r.daysLeft <= 7;
  return (
    <span className={`badge ${soon ? "badge-warn" : "badge-neutral"}`} title={when}>
      {r.daysLeft}d left
    </span>
  );
}

export default function ComputeInventory() {
  const { isAdmin } = useAuth();
  const { confirm, alert } = useDialog();
  const proxmox = useProviderHealth("proxmox");
  const [searchParams, setSearchParams] = useSearchParams();
  const rebootHandled = useRef(null);
  const [resources, setResources] = useState([]);
  const [error, setError] = useState("");
  const [pending, setPending] = useState({});       // vmid -> action label
  const [query, setQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState(() => {
    const t = searchParams.get("type");
    return t === "vm" || t === "container" ? t : "all";
  });
  const [statusFilter, setStatusFilter] = useState(() => {
    const s = searchParams.get("status");
    return s === "running" || s === "stopped" ? s : "all";
  });
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [connectTarget, setConnectTarget] = useState(null);  // { vmid, ip, hostname }
  const [editTarget, setEditTarget] = useState(null);        // resource being edited
  const [extendTarget, setExtendTarget] = useState(null);    // resource whose expiry is being extended
  const [snapshotTarget, setSnapshotTarget] = useState(null); // resource whose snapshots are managed
  const [backupTarget, setBackupTarget] = useState(null);    // resource whose backup is configured

  const load = () => getResources().then(setResources).catch((e) => setError(e.response?.data?.error || e.message));

  useEffect(() => {
    let alive = true;
    let timer;
    let failStreak = 0;
    const tick = () => {
      getResources()
        .then((rows) => {
          if (!alive) return;
          setResources(rows);
          setError("");
          failStreak = 0;
          timer = setTimeout(tick, 8000);
        })
        .catch((e) => {
          if (!alive) return;
          setError(e.response?.data?.error || e.message);
          failStreak += 1;
          // Back off when Proxmox is down (5 min after failures).
          timer = setTimeout(tick, failStreak >= 1 ? 5 * 60 * 1000 : 8000);
        });
    };
    tick();
    return () => { alive = false; clearTimeout(timer); };
  }, []);

  useEffect(() => {
    setPage(1);
  }, [query, statusFilter, typeFilter, pageSize]);

  // Deep-link from an approved-resize notification: /resources?reboot=<vmid>&request=<id>.
  // Prompt the owner to reboot now; on confirm, trigger the reboot and clear the params.
  useEffect(() => {
    const vmid = searchParams.get("reboot");
    const requestId = searchParams.get("request");
    if (!vmid || !requestId) return;
    if (rebootHandled.current === requestId) return;
    if (resources.length === 0) return; // wait for names to load
    rebootHandled.current = requestId;

    const r = resources.find((x) => String(x.vmid) === String(vmid));
    const label = r?.name || `VMID ${vmid}`;
    (async () => {
      const ok = await confirm({
        title: "Resize approved — reboot now?",
        message: `Your resize of ${label} was approved and applied. Reboot it now to bring the new resources online? It will be briefly unavailable.`,
        confirmLabel: "Reboot now",
        tone: "danger",
      });
      // Clear the query params either way so the prompt doesn't reappear.
      const next = new URLSearchParams(searchParams);
      next.delete("reboot"); next.delete("request");
      setSearchParams(next, { replace: true });
      if (!ok) return;
      try {
        await confirmResizeReboot(requestId);
        setTimeout(load, 1200);
        alert({ title: "Reboot started", message: `${label} is rebooting to apply the new size.` });
      } catch (e) {
        alert({ title: "Reboot failed", message: e.response?.data?.error || e.message, tone: "danger" });
      }
    })();
  }, [searchParams, resources]);

  const act = async (r, action) => {
    if (proxmox.blocked) {
      await alert({
        title: "Proxmox unavailable",
        message: proxmox.message || "Proxmox is down or unreachable.",
        tone: "danger",
      });
      return;
    }
    if (action === "delete" && !(await confirm({
      title: "Delete resource",
      message: `Delete ${r.name} (VMID ${r.vmid})? This cannot be undone.`,
      confirmLabel: "Delete", tone: "danger",
    }))) return;
    if (action === "reset" && !(await confirm({
      title: "Hard reset",
      message: `Hard reset ${r.name} (VMID ${r.vmid})? This forcibly resets the machine without a clean shutdown and may cause data loss.`,
      confirmLabel: "Hard reset", tone: "danger",
    }))) return;
    setPending((p) => ({ ...p, [r.vmid]: action }));
    setError("");
    window.dispatchEvent(new CustomEvent("forge:resource-action", { detail: { vmid: r.vmid, action } }));
    try {
      await resourceAction(r.type, r.vmid, action);
      setTimeout(load, 1200);
    } catch (e) {
      setError(e.response?.data?.error || e.message);
    } finally {
      setPending((p) => { const n = { ...p }; delete n[r.vmid]; return n; });
    }
  };

  const q = query.trim().toLowerCase();
  const matchesQuery = (r) => !q
    || (r.name || "").toLowerCase().includes(q)
    || String(r.vmid || "").includes(q)
    || (r.owner || "").toLowerCase().includes(q);

  // Search-only set: the summary chips count against this so they stay stable
  // while acting as status/type toggles (and reflect the active search).
  const byQuery = resources.filter(matchesQuery);

  const filtered = byQuery
    .filter((r) => {
      const matchStatus = statusFilter === "all"
        || (statusFilter === "running" && r.status === "running")
        || (statusFilter === "stopped" && r.status !== "running");
      const matchType = typeFilter === "all" || r.type === typeFilter;
      return matchStatus && matchType;
    })
    // Always order by VMID so rows keep a stable position across the 8s poll
    // (Proxmox doesn't guarantee a consistent order) and don't visibly shuffle.
    .sort((a, b) => Number(a.vmid) - Number(b.vmid));

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const pageStart = (safePage - 1) * pageSize;
  const pageItems = filtered.slice(pageStart, pageStart + pageSize);
  const runningCount = byQuery.filter((r) => r.status === "running").length;
  const stoppedCount = byQuery.filter((r) => r.status !== "running").length;
  const vmCount = byQuery.filter((r) => r.type === "vm").length;
  const ctCount = byQuery.filter((r) => r.type === "container").length;

  // Clicking a summary chip sets the matching filter (and clicking the active
  // one again clears it). "Total" resets both status and type filters.
  const isDefaultView = statusFilter === "all" && typeFilter === "all";
  const showAll = () => { setStatusFilter("all"); setTypeFilter("all"); };
  const toggleStatus = (s) => setStatusFilter((cur) => (cur === s ? "all" : s));
  const toggleType = (t) => setTypeFilter((cur) => (cur === t ? "all" : t));

  return (
    <div className="compute-inventory">
      <ProviderStatusBanner
        providerLabel="Proxmox"
        checking={proxmox.checking}
        blocked={proxmox.blocked}
        message={proxmox.message}
        error={proxmox.error}
        onRetry={() => { proxmox.refresh(); load(); }}
      />

      {error && <div className="login-error">{error}</div>}

      <div className="ci-with-cal">
        <div className="ci-main">
          <div className="toolbar toolbar-panel">
            <input
              className="control-input"
              placeholder="Search name, VMID, owner..."
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <select className="control-select" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
              <option value="all">All status</option>
              <option value="running">Running</option>
              <option value="stopped">Stopped</option>
            </select>
            <select className="control-select" value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
              <option value="all">All types</option>
              <option value="vm">VM</option>
              <option value="container">Container</option>
            </select>
            <select className="control-select" value={pageSize} onChange={(e) => setPageSize(Number(e.target.value))}>
              <option value={10}>10 per page</option>
              <option value={20}>20 per page</option>
              <option value={50}>50 per page</option>
            </select>
            <span className="muted" style={{ marginLeft: "auto", fontSize: 13 }}>{filtered.length} items</span>
          </div>

          <div className="summary-strip" style={{ marginBottom: 14 }}>
            <button
              type="button"
              className={`summary-chip ${isDefaultView ? "summary-chip-active" : ""}`}
              onClick={showAll}
              title="Show all resources"
            ><span className="icon">⚙</span> {byQuery.length} total</button>
            <button
              type="button"
              className={`summary-chip ${statusFilter === "running" ? "summary-chip-active" : ""}`}
              onClick={() => toggleStatus("running")}
              title="Filter by running"
            ><span className="icon">●</span> {runningCount} running</button>
            <button
              type="button"
              className={`summary-chip ${statusFilter === "stopped" ? "summary-chip-active" : ""}`}
              onClick={() => toggleStatus("stopped")}
              title="Filter by stopped"
            ><span className="icon">○</span> {stoppedCount} stopped</button>
            <button
              type="button"
              className={`summary-chip ${typeFilter === "vm" ? "summary-chip-active" : ""}`}
              onClick={() => toggleType("vm")}
              title="Filter by VMs"
            ><span className="icon">🖥</span> {vmCount} VMs</button>
            <button
              type="button"
              className={`summary-chip ${typeFilter === "container" ? "summary-chip-active" : ""}`}
              onClick={() => toggleType("container")}
              title="Filter by containers"
            ><span className="icon">📦</span> {ctCount} containers</button>
          </div>

          <div className="card" style={{ overflow: "hidden" }}>
            {filtered.length === 0 ? (
              <EmptyState
                icon="🖥"
                title={resources.length === 0 ? "No resources yet" : "No matches"}
                description={resources.length === 0
                  ? (isAdmin
                    ? "Nothing on this node yet — or visibility filters hid them. Provision a VM to populate inventory."
                    : "You don't own any VMs or containers yet. Provision one to see it here.")
                  : "Try clearing search or status/type filters."}
                actionLabel={resources.length === 0 ? "Provision" : "Clear filters"}
                actionHref={resources.length === 0 ? "/provision" : undefined}
                onAction={resources.length === 0 ? undefined : () => { setQuery(""); setStatusFilter("all"); setTypeFilter("all"); }}
              />
            ) : (
              <table className="table table-dense">
                <thead>
                  <tr>
                    <th>VMID</th>
                    <th>Resource</th>
                    <th>Status</th>
                    <th>Specs</th>
                    <th>Expiry</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {pageItems.map((r) => {
                    const running = r.status === "running";
                    const busy = pending[r.vmid];

                    const powerItems = [];
                    if (running) {
                      powerItems.push({ key: "shutdown", label: "Power off", icon: <IconPower size={15} style={{ color: "var(--warn)" }} />, onClick: () => act(r, "shutdown") });
                      if (!r.expired) {
                        powerItems.push({ key: "reboot", label: "Reboot", icon: <IconReboot size={15} className="icon-spin-hover" style={{ color: "var(--accent)" }} />, onClick: () => act(r, "reboot") });
                      }
                    } else if (!r.expired && isAdmin) {
                      // Power on hidden while expired — renew must be approved first.
                      powerItems.push({ key: "start", label: "Power on", icon: <IconPlay size={15} style={{ color: "var(--ok)" }} />, onClick: () => act(r, "start") });
                    }

                    const actionItems = [
                      running && { key: "console", label: "Console", icon: <IconTerminal size={15} />, onClick: () => setConnectTarget({ vmid: r.vmid, ip: r.ip, hostname: r.name || `VMID ${r.vmid}` }) },
                      { key: "edit", label: "Edit specs", icon: <IconEdit size={15} />, onClick: () => setEditTarget(r) },
                      (r.expiresAt || r.expired) && {
                        key: "renew",
                        label: r.expired ? "Renew (needs approval)" : "Renew / extend",
                        icon: <IconCalendarPlus size={15} />,
                        onClick: () => setExtendTarget(r),
                      },
                      r.type === "vm" && { key: "snapshot", label: "Snapshot", icon: <IconCamera size={15} />, onClick: () => setSnapshotTarget(r) },
                      r.type === "vm" && { key: "backup", label: "Configure backup", icon: <IconArchive size={15} />, onClick: () => setBackupTarget(r) },
                      isAdmin && { key: "delete", label: "Delete", icon: <IconTrash size={15} />, danger: true, onClick: () => act(r, "delete") },
                    ].filter(Boolean);

                    const metaParts = [
                      r.ip,
                      r.os,
                      isAdmin ? r.owner : null,
                    ].filter(Boolean);

                    return (
                      <tr key={`${r.type}-${r.vmid}`}>
                        <td className="mono res-vmid">{r.vmid}</td>
                        <td>
                          <div className="res-name-cell">
                            <span className="resource-name">
                              <span className="resource-kind-icon" title={r.type === "vm" ? "Virtual machine" : "Container"}>
                                {r.type === "vm" ? <IconServer size={15} /> : <IconBox size={15} />}
                              </span>
                              <span className="res-name-text">{r.name || "—"}</span>
                            </span>
                            {metaParts.length > 0 && (
                              <div className="res-name-meta mono">{metaParts.join(" · ")}</div>
                            )}
                          </div>
                        </td>
                        <td>
                          <span className={`badge ${running ? "badge-running" : "badge-stopped"}`}>{r.status}</span>
                        </td>
                        <td className="mono res-specs" title="CPU · RAM · Disk">{fmtSpecs(r)}</td>
                        <td><ExpiryCell r={r} /></td>
                        <td>
                          <div className="actions-cell">
                            {busy ? (
                              <span className="muted" style={{ fontSize: 12 }}><span className="spinner" style={{ width: 12, height: 12 }} /> {busy}…</span>
                            ) : (
                              <>
                                <PowerMenu items={powerItems} />
                                <RowMenu icon={<IconActions />} title="Actions" items={actionItems} />
                                <TagsMenu resource={r} onChanged={() => setTimeout(load, 600)} />
                              </>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>

          {filtered.length > 0 && (
            <div className="pagination-row">
              <button type="button" className="btn btn-ghost btn-sm" disabled={safePage <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>Previous</button>
              <span className="muted">Page {safePage} / {totalPages}</span>
              <button type="button" className="btn btn-ghost btn-sm" disabled={safePage >= totalPages} onClick={() => setPage((p) => Math.min(totalPages, p + 1))}>Next</button>
            </div>
          )}
        </div>

        <ExpiryCalendar resources={resources} onRenew={setExtendTarget} />
      </div>

      {editTarget && (
        <EditResourceModal
          resource={editTarget}
          onClose={() => setEditTarget(null)}
          onSaved={() => setTimeout(load, 800)}
        />
      )}

      {extendTarget && (
        <ExtendExpiryModal
          resource={extendTarget}
          onClose={() => setExtendTarget(null)}
          onSaved={() => setTimeout(load, 600)}
        />
      )}

      {connectTarget && (
        <TerminalModal
          vmid={connectTarget.vmid}
          ip={connectTarget.ip}
          hostname={connectTarget.hostname}
          onClose={() => setConnectTarget(null)}
        />
      )}

      {snapshotTarget && (
        <SnapshotModal
          resource={snapshotTarget}
          onClose={() => setSnapshotTarget(null)}
          onChanged={() => setTimeout(load, 1200)}
        />
      )}

      {backupTarget && (
        <BackupModal
          resource={backupTarget}
          onClose={() => setBackupTarget(null)}
        />
      )}
    </div>
  );
}
