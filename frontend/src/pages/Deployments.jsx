import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  getJobs,
  getProvisionRequests,
  approveProvisionRequest,
  cancelJob,
  rollbackJob,
  retryJob,
} from "../api/client.js";
import { useAuth } from "../context/AuthContext.jsx";
import { useFloatingPanel } from "../hooks/useFloatingPanel.js";
import JobStatus from "../components/JobStatus.jsx";
import RejectRequestModal from "../components/RejectRequestModal.jsx";
import RequestDetailsModal from "../components/RequestDetailsModal.jsx";

const TERMINAL_JOB = new Set(["ready", "failed", "cancelled", "rolled_back"]);

const FILTERS = [
  { key: "all", label: "All", color: "neutral" },
  { key: "running", label: "Running", color: "active" },
  { key: "completed", label: "Completed", color: "ok" },
  { key: "hold", label: "On Hold (Awaiting Approvals)", color: "hold" },
  { key: "failed", label: "Failed", color: "danger" },
  { key: "archived", label: "Archived", color: "muted" },
];

const TAB_ALIASES = {
  active: "running",
  approved: "completed",
  successful: "completed",
  awaiting: "hold",
  cancelled: "failed",
  rejected: "failed",
};

function normalizeTab(raw) {
  const key = raw || "all";
  if (TAB_ALIASES[key]) return TAB_ALIASES[key];
  return FILTERS.some((f) => f.key === key) ? key : "all";
}

function fmtWhen(ts) {
  if (!ts) return "—";
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return "—";
  }
}

function jobTitle(job) {
  return (
    job.resources?.[0]?.hostname ||
    job.payload?.hostname ||
    job.payload?.hostnamePrefix ||
    `Job ${job.id}`
  );
}

function requestTitle(r) {
  if (r.kind === "renew") {
    return r.payload?.hostname || (r.payload?.vmid ? `Renew VMID ${r.payload.vmid}` : `Renew ${r.id}`);
  }
  return r.payload?.hostname || r.payload?.hostnamePrefix || `Request ${r.id}`;
}

function normalizeStatus(value) {
  return String(value || "").toLowerCase().trim();
}

function requestBucket(r) {
  if (r.archivedAt) return "archived";
  const status = normalizeStatus(r.status);
  if (status === "pending_approval") return "hold";
  if (status === "rejected" || status === "failed" || status === "cancelled" || status === "canceled" || status === "rolled_back") {
    return "failed";
  }
  if (status === "completed") return "completed";
  return "running";
}

function jobBucket(j) {
  if (j.archivedAt) return "archived";
  const status = normalizeStatus(j.status);
  const category = normalizeStatus(j.category);
  if (status === "failed" || category === "failed") return "failed";
  if (
    status === "cancelled" || status === "canceled" || status === "rolled_back"
    || category === "cancelled" || category === "canceled"
  ) {
    return "failed";
  }
  if (status === "ready" || category === "successful" || category === "pending") {
    return "completed";
  }
  return "running";
}

function statusBadge(row) {
  if (row.archivedAt || row.raw?.archivedAt) {
    return { label: "Archived", cls: "badge-stopped" };
  }
  if (row.rowType === "request") {
    const s = row.status || "";
    if (s === "pending_approval") return { label: "On hold", cls: "badge-provisioning" };
    if (s === "approved" || s === "provisioning" || s === "completed") {
      return { label: s.replace(/_/g, " "), cls: "badge-ready" };
    }
    if (s === "rejected") return { label: "Rejected", cls: "badge-failed" };
    if (s === "failed") return { label: "Failed", cls: "badge-failed" };
    if (s === "rolled_back") return { label: "Rolled back", cls: "badge-failed" };
    if (s === "cancelled" || s === "canceled") return { label: "Cancelled", cls: "badge-failed" };
    return { label: s.replace(/_/g, " ") || "Request", cls: "badge-stopped" };
  }
  const cat = row.category || row.status;
  if (cat === "successful" || row.status === "ready") return { label: "Completed", cls: "badge-ready" };
  if (row.status === "rolled_back") return { label: "Rolled back", cls: "badge-failed" };
  if (cat === "failed" || row.status === "failed") return { label: "Failed", cls: "badge-failed" };
  if (cat === "pending") return { label: "Finalizing", cls: "badge-provisioning" };
  if (cat === "cancelled" || cat === "canceled" || row.status === "cancelled" || row.status === "canceled") {
    return { label: "Cancelled", cls: "badge-failed" };
  }
  return { label: "Running", cls: "badge-booting" };
}

function toRequestRow(r) {
  return {
    rowType: "request",
    id: r.id,
    kind: r.kind || "vm",
    title: requestTitle(r),
    owner: r.requestedBy || "—",
    status: r.status,
    createdAt: r.createdAt,
    archivedAt: r.archivedAt || null,
    error: r.error || null,
    raw: r,
  };
}

function toJobRow(j) {
  return {
    rowType: "job",
    id: j.id,
    kind: j.type || "job",
    title: jobTitle(j),
    owner: j.payload?.requestedBy || "—",
    status: j.status,
    category: j.category,
    createdAt: j.createdAt,
    archivedAt: j.archivedAt || null,
    error: j.errorUserMessage || j.error || null,
    errorDetail: j.errorDetail || null,
    proxmoxUpid: j.proxmoxUpid || null,
    failureCount: Number(j.failureCount || 0),
    retryCount: Number(j.retryCount || 0),
    raw: j,
  };
}

function dedupeRows(jobRows, reqRows, allJobs = []) {
  const linkedJobIds = new Set((allJobs || []).map((j) => j.id).filter(Boolean));
  const shownJobIds = new Set(jobRows.map((j) => j.id));
  const reqOnly = reqRows.filter((r) => {
    const jid = r.raw?.jobId;
    if (!jid) return true;
    if (shownJobIds.has(jid)) return false;
    // Linked job exists — show the job in its bucket, not the request in another.
    if (linkedJobIds.has(jid)) return false;
    return true;
  });
  return [...reqOnly, ...jobRows];
}

export default function Deployments() {
  const { canReviewDeployments, user } = useAuth();
  const [params, setParams] = useSearchParams();
  const [jobs, setJobs] = useState([]);
  const [requests, setRequests] = useState([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [query, setQuery] = useState("");
  const [logJobId, setLogJobId] = useState(null);
  const [viewTarget, setViewTarget] = useState(null);
  const [rejectTarget, setRejectTarget] = useState(null);
  const [stoppingId, setStoppingId] = useState(null);
  const [rollingBackId, setRollingBackId] = useState(null);
  const [retryingId, setRetryingId] = useState(null);
  const [approvingId, setApprovingId] = useState(null);

  const {
    mounted: approvalMounted,
    phase: approvalPhase,
    panelRef: approvalPanelRef,
    openPanel: openApprovalPanel,
    closePanel: closeApprovalPanel,
    isOpen: approvalOpen,
  } = useFloatingPanel({ ignoreSelectors: [".deploy-approval-trigger", ".modal-overlay"] });

  const tab = normalizeTab(params.get("tab"));

  const setTab = (key) => {
    const next = new URLSearchParams(params);
    next.set("tab", key);
    next.delete("job");
    next.delete("request");
    setParams(next, { replace: true });
  };

  const refreshData = async () => {
    const [j, r] = await Promise.all([
      getJobs(),
      getProvisionRequests().catch(() => []),
    ]);
    setJobs(Array.isArray(j) ? j : []);
    setRequests(Array.isArray(r) ? r : []);
  };

  useEffect(() => {
    const review = params.get("review");
    if (review && canReviewDeployments) {
      const next = new URLSearchParams(params);
      next.delete("review");
      next.set("tab", "hold");
      next.set("request", review);
      setParams(next, { replace: true });
      openApprovalPanel();
    }
  }, [params, canReviewDeployments, setParams, openApprovalPanel]);

  useEffect(() => {
    const raw = params.get("tab");
    if (raw && normalizeTab(raw) !== raw) {
      const next = new URLSearchParams(params);
      next.set("tab", normalizeTab(raw));
      setParams(next, { replace: true });
    }
  }, [params, setParams]);

  useEffect(() => {
    let cancelled = false;
    let timer;
    const poll = async () => {
      try {
        const [j, r] = await Promise.all([
          getJobs(),
          getProvisionRequests().catch(() => []),
        ]);
        if (cancelled) return;
        setJobs(Array.isArray(j) ? j : []);
        setRequests(Array.isArray(r) ? r : []);
        setError("");
      } catch (e) {
        if (!cancelled) setError(e.response?.data?.error || e.message);
      }
      timer = setTimeout(poll, 3500);
    };
    poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    const rid = params.get("request");
    if (!rid || !requests.length) return;
    const target = requests.find((r) => r.id === rid);
    if (!target) return;
    // Approvals: open the review modal for reviewers (or the requester viewing their own hold).
    if (target.status === "pending_approval") {
      setViewTarget(target);
      return;
    }
    // Otherwise jump to the linked job log when available.
    if (target.jobId) setLogJobId(target.jobId);
  }, [params, requests]);

  useEffect(() => {
    const jid = params.get("job");
    if (jid) setLogJobId(jid);
  }, [params]);

  const pendingApprovals = useMemo(
    () => requests.filter((r) => r.status === "pending_approval" && !r.archivedAt),
    [requests]
  );

  const awaitingCount = pendingApprovals.length;

  const filterCounts = useMemo(() => {
    const counts = { all: 0, running: 0, completed: 0, hold: 0, failed: 0, archived: 0 };

    const countBucket = (bucket) => {
      const jobRows = jobs.filter((j) => jobBucket(j) === bucket);
      const reqRows = requests.filter((r) => requestBucket(r) === bucket);
      return dedupeRows(jobRows.map(toJobRow), reqRows.map(toRequestRow), jobs).length;
    };

    counts.running = countBucket("running");
    counts.completed = countBucket("completed");
    counts.failed = countBucket("failed");
    counts.hold = requests.filter((r) => requestBucket(r) === "hold").length;
    counts.archived =
      jobs.filter((j) => j.archivedAt).length
      + requests.filter((r) => r.archivedAt).length;
    counts.all = dedupeRows(
      jobs.filter((j) => jobBucket(j) !== "archived").map(toJobRow),
      requests.filter((r) => requestBucket(r) !== "archived").map(toRequestRow),
      jobs
    ).length;

    return counts;
  }, [jobs, requests]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matchQ = (row) =>
      !q ||
      String(row.id).toLowerCase().includes(q) ||
      (row.title || "").toLowerCase().includes(q) ||
      (row.owner || "").toLowerCase().includes(q) ||
      (row.kind || "").toLowerCase().includes(q) ||
      (row.status || "").toLowerCase().includes(q);

    let list = [];

    if (tab === "all") {
      const jobRows = jobs.filter((j) => jobBucket(j) !== "archived").map(toJobRow);
      const reqRows = requests.filter((r) => requestBucket(r) !== "archived").map(toRequestRow);
      list = dedupeRows(jobRows, reqRows, jobs);
    } else if (tab === "running") {
      const jobRows = jobs.filter((j) => jobBucket(j) === "running").map(toJobRow);
      const reqRows = requests.filter((r) => requestBucket(r) === "running").map(toRequestRow);
      list = dedupeRows(jobRows, reqRows, jobs);
    } else if (tab === "completed") {
      const jobRows = jobs.filter((j) => jobBucket(j) === "completed").map(toJobRow);
      const reqRows = requests.filter((r) => requestBucket(r) === "completed").map(toRequestRow);
      list = dedupeRows(jobRows, reqRows, jobs);
    } else if (tab === "hold") {
      list = requests.filter((r) => requestBucket(r) === "hold").map(toRequestRow);
    } else if (tab === "failed") {
      const jobRows = jobs.filter((j) => jobBucket(j) === "failed").map(toJobRow);
      const reqRows = requests.filter((r) => requestBucket(r) === "failed").map(toRequestRow);
      list = dedupeRows(jobRows, reqRows, jobs);
    } else if (tab === "archived") {
      list = [
        ...requests.filter((r) => r.archivedAt).map(toRequestRow),
        ...jobs.filter((j) => j.archivedAt).map(toJobRow),
      ];
    }

    return list.filter(matchQ).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }, [tab, jobs, requests, query]);

  const emptyMessage = useMemo(() => {
    if (tab === "all") return "No deployments yet.";
    if (tab === "hold") return "No requests on hold.";
    if (tab === "completed") return "No completed deployments yet.";
    if (tab === "failed") return "No failed, cancelled, or rejected deployments.";
    if (tab === "archived") return "No archived deployments.";
    return "No running deployments.";
  }, [tab]);

  const handleApprove = async (id) => {
    const result = await approveProvisionRequest(id);
    setViewTarget(null);
    const next = new URLSearchParams(params);
    next.delete("request");
    if (result?.job?.id) {
      next.set("tab", "running");
      next.set("job", String(result.job.id));
      setLogJobId(result.job.id);
    } else {
      next.set("tab", "running");
    }
    setParams(next, { replace: true });
    await refreshData();
  };

  const handleQuickApprove = async (id) => {
    setApprovingId(id);
    try {
      await handleApprove(id);
    } catch (e) {
      setError(e.response?.data?.error || e.message);
    } finally {
      setApprovingId(null);
    }
  };

  const canStopJob = (row) => {
    if (row.rowType !== "job") return false;
    if (TERMINAL_JOB.has(row.status) || row.archivedAt) return false;
    return canReviewDeployments || row.owner === user?.username;
  };

  const canRollbackJob = (row) => {
    if (row.rowType !== "job" || row.archivedAt) return false;
    if (row.status !== "failed") return false;
    const resources = row.raw?.resources || [];
    const hasGuests = resources.some((r) => Number.isFinite(Number(r.vmid)));
    if (!hasGuests) return false;
    return canReviewDeployments || row.owner === user?.username;
  };

  const canRetryJob = (row) => {
    if (row.rowType !== "job" || row.archivedAt) return false;
    if (row.status !== "failed") return false;
    return canReviewDeployments || row.owner === user?.username;
  };

  const handleStop = async (jobId) => {
    if (!window.confirm("Stop this deployment and destroy any incomplete VMs?")) return;
    setStoppingId(jobId);
    try {
      await cancelJob(jobId);
      await refreshData();
      const next = new URLSearchParams(params);
      next.set("tab", "failed");
      next.delete("job");
      setParams(next, { replace: true });
    } catch (e) {
      setError(e.response?.data?.error || e.message);
    } finally {
      setStoppingId(null);
    }
  };

  const handleRollback = async (row) => {
    const targets = (row.raw?.resources || [])
      .filter((r) => Number.isFinite(Number(r.vmid)))
      .map((r) => (r.hostname ? `${r.vmid} (${r.hostname})` : String(r.vmid)));
    if (!window.confirm(
      `Roll back this failed deployment and destroy leftover guest(s)?\n\n${targets.join("\n")}`
    )) return;
    setRollingBackId(row.id);
    try {
      await rollbackJob(row.id);
      await refreshData();
      const next = new URLSearchParams(params);
      next.set("tab", "failed");
      next.delete("job");
      setParams(next, { replace: true });
    } catch (e) {
      setError(e.response?.data?.error || e.message);
    } finally {
      setRollingBackId(null);
    }
  };

  const handleRetry = async (row) => {
    if (!window.confirm(
      `Retry this failed deployment?\n\n${row.title}\n\nIf the VM still exists, Forge will continue from the failed step on the same deployment. Otherwise it cleans up leftovers and rebuilds under the same job id.`
    )) return;
    setRetryingId(row.id);
    setNotice("");
    try {
      const result = await retryJob(row.id);
      await refreshData();
      const next = new URLSearchParams(params);
      const jobId = result?.job?.id || row.id;
      if (result?.resumed) {
        next.set("tab", "running");
        next.set("job", String(jobId));
        setLogJobId(jobId);
        setNotice(
          `Resumed from "${result.resumeLabel || result.resumeFrom}" on VM #${result.vmid} (same deployment).`
        );
      } else if (result?.sameJob || result?.job?.id) {
        next.set("tab", "running");
        next.set("job", String(jobId));
        setLogJobId(jobId);
        setNotice(`Retry started on the same deployment — job ${jobId} is Running.`);
      } else {
        next.set("tab", "running");
        next.delete("job");
        setNotice("Retry submitted.");
      }
      setParams(next, { replace: true });
    } catch (e) {
      setError(e.response?.data?.error || e.message);
    } finally {
      setRetryingId(null);
    }
  };

  const openLog = (jobId) => {
    setLogJobId(jobId);
    const next = new URLSearchParams(params);
    next.set("job", String(jobId));
    setParams(next, { replace: true });
  };

  const closeLog = () => {
    setLogJobId(null);
    const next = new URLSearchParams(params);
    next.delete("job");
    setParams(next, { replace: true });
  };

  const toggleApprovalPanel = () => {
    if (approvalOpen) closeApprovalPanel();
    else openApprovalPanel();
  };

  return (
    <div className="page">
      <div className="page-head page-head-row">
        <div>
          <div className="eyebrow">Activity</div>
          <h1>Deployments</h1>
          <p>
            {canReviewDeployments
              ? "Monitor provisioning runs and review size-policy holds."
              : "Track your provisioning jobs and requests awaiting approval."}
          </p>
        </div>

        {canReviewDeployments && (
          <div className="deploy-approval-anchor">
            <button
              type="button"
              className={`btn deploy-approval-trigger ${awaitingCount > 0 ? "has-pending" : ""}`}
              onClick={toggleApprovalPanel}
              aria-expanded={approvalOpen}
              aria-haspopup="dialog"
            >
              Awaiting approval
              <span className="deploy-approval-trigger-count">{awaitingCount}</span>
            </button>

            {approvalMounted && (
              <div
                ref={approvalPanelRef}
                className={`deploy-approval-panel ${approvalPhase === "open" ? "deploy-approval-panel-enter" : ""} ${approvalPhase === "leaving" ? "deploy-approval-panel-leave" : ""}`}
                role="dialog"
                aria-label="Requests awaiting approval"
              >
                <div className="deploy-approval-panel-head">
                  <strong>Awaiting approval</strong>
                  <span className="muted">{awaitingCount} request{awaitingCount !== 1 ? "s" : ""}</span>
                  <button
                    type="button"
                    className="close-btn"
                    onClick={closeApprovalPanel}
                    aria-label="Close"
                  >
                    ×
                  </button>
                </div>
                <div className="deploy-approval-panel-body">
                  {pendingApprovals.length === 0 ? (
                    <p className="muted deploy-approval-empty">No requests waiting for approval.</p>
                  ) : (
                    <ul className="deploy-approval-list">
                      {pendingApprovals.map((r) => (
                        <li key={r.id} className="deploy-approval-item">
                          <div className="deploy-approval-item-main">
                            <div className="deploy-approval-item-title">{requestTitle(r)}</div>
                            <div className="deploy-approval-item-meta">
                              <span>{(r.kind || "vm").toUpperCase()}</span>
                              <span>{r.requestedBy || "—"}</span>
                              <span className="muted">{fmtWhen(r.createdAt)}</span>
                            </div>
                          </div>
                          <div className="deploy-approval-item-actions">
                            <button
                              type="button"
                              className="btn btn-ghost btn-sm"
                              onClick={() => setViewTarget(r)}
                            >
                              View
                            </button>
                            <button
                              type="button"
                              className="btn btn-primary btn-sm"
                              disabled={approvingId === r.id}
                              onClick={() => handleQuickApprove(r.id)}
                            >
                              {approvingId === r.id ? "…" : "Approve"}
                            </button>
                            <button
                              type="button"
                              className="btn btn-danger btn-sm"
                              onClick={() => setRejectTarget(r)}
                            >
                              Reject
                            </button>
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {notice && (
        <div className="set-notice" role="status" style={{ marginBottom: 12 }}>
          {notice}
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setNotice("")} style={{ marginLeft: 8 }}>
            Dismiss
          </button>
        </div>
      )}
      {error && <div className="login-error">{error}</div>}

      <nav className="deploy-tabs" role="tablist" aria-label="Deployment filters">
        {FILTERS.map((f) => {
          const count = filterCounts[f.key] || 0;
          const active = tab === f.key;
          return (
            <button
              key={f.key}
              type="button"
              role="tab"
              aria-selected={active}
              className={`deploy-tab deploy-tab-${f.color} ${active ? "is-active" : ""}`}
              onClick={() => setTab(f.key)}
            >
              {f.label}
              <span className="deploy-tab-count">{count}</span>
            </button>
          );
        })}
      </nav>

      <div className="toolbar toolbar-panel">
        <input
          className="control-input"
          placeholder="Search by host, user, id…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <span className="muted" style={{ marginLeft: "auto", fontSize: 13 }}>
          {rows.length} {rows.length === 1 ? "item" : "items"}
        </span>
      </div>

      <div className="card" style={{ overflow: "auto" }}>
        <table className="table deploy-table">
          <thead>
            <tr>
              <th>Status</th>
              <th>Name</th>
              <th>Kind</th>
              <th>Owner</th>
              <th>Started</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={6} className="muted" style={{ padding: 24, textAlign: "center" }}>
                  {emptyMessage}
                </td>
              </tr>
            ) : (
              rows.map((row) => {
                const badge = statusBadge(row);
                const priorFails = Number(row.failureCount || 0);
                const retries = Number(row.retryCount || 0);
                const showPriorFails = priorFails > 0;
                return (
                  <tr key={`${row.rowType}-${row.id}`}>
                    <td>
                      <div className="deploy-status-cell">
                        <span className={`badge ${badge.cls}`}>{badge.label}</span>
                        {showPriorFails && (
                          <span
                            className="deploy-prior-fail-badge"
                            title={
                              badge.label === "Completed" || row.status === "ready"
                                ? `Completed after ${priorFails} earlier failure${priorFails === 1 ? "" : "s"}${retries ? ` · ${retries} retry${retries === 1 ? "" : "ies"}` : ""}`
                                : `Failed ${priorFails} time${priorFails === 1 ? "" : "s"}${retries ? ` · ${retries} retry${retries === 1 ? "" : "ies"}` : ""}`
                            }
                          >
                            <span className="deploy-prior-fail-icon" aria-hidden="true">↻</span>
                            {priorFails}
                          </span>
                        )}
                      </div>
                    </td>
                    <td>
                      <div style={{ fontWeight: 600 }}>{row.title}</div>
                      <div className="muted mono" style={{ fontSize: 11 }}>
                        {row.rowType === "request" ? "req" : "job"} #{row.id}
                        {retries > 0 ? ` · retry ${retries}` : ""}
                      </div>
                      {row.error && (
                        <details className="deploy-row-error-detail">
                          <summary title={row.error}>
                            {row.error.length > 56 ? `${row.error.slice(0, 56)}…` : row.error}
                          </summary>
                          <div className="deploy-row-error-body">{row.error}</div>
                          {row.errorDetail && row.errorDetail !== row.error && (
                            <pre className="deploy-row-error-tech">{row.errorDetail}</pre>
                          )}
                          {row.proxmoxUpid && (
                            <div className="deploy-row-error-upid muted mono">
                              Proxmox task: {row.proxmoxUpid}
                            </div>
                          )}
                        </details>
                      )}
                    </td>
                    <td>{(row.kind || "—").toUpperCase()}</td>
                    <td>{row.owner}</td>
                    <td className="muted" style={{ whiteSpace: "nowrap" }}>
                      {fmtWhen(row.createdAt)}
                    </td>
                    <td>
                      <div className="actions-cell">
                        {row.rowType === "job" && (
                          <>
                            <button
                              type="button"
                              className="btn btn-ghost btn-sm"
                              onClick={() => openLog(row.id)}
                            >
                              Show log
                            </button>
                            {canStopJob(row) && (
                              <button
                                type="button"
                                className="btn btn-danger btn-sm"
                                disabled={stoppingId === row.id}
                                onClick={() => handleStop(row.id)}
                              >
                                {stoppingId === row.id ? "Stopping…" : "Stop"}
                              </button>
                            )}
                            {canRetryJob(row) && (
                              <button
                                type="button"
                                className="btn btn-primary btn-sm"
                                disabled={retryingId === row.id}
                                onClick={() => handleRetry(row)}
                              >
                                {retryingId === row.id ? "Retrying…" : "Retry"}
                              </button>
                            )}
                            {canRollbackJob(row) && (
                              <button
                                type="button"
                                className="btn btn-danger btn-sm"
                                disabled={rollingBackId === row.id}
                                onClick={() => handleRollback(row)}
                              >
                                {rollingBackId === row.id ? "Rolling back…" : "Rollback"}
                              </button>
                            )}
                          </>
                        )}
                        {row.rowType === "request" && row.status === "pending_approval" && !canReviewDeployments && (
                          <span className="muted" style={{ fontSize: 12 }}>
                            Waiting for approval
                          </span>
                        )}
                        {row.rowType === "request" && row.raw?.jobId && (
                          <button
                            type="button"
                            className="btn btn-ghost btn-sm"
                            onClick={() => openLog(row.raw.jobId)}
                          >
                            Show log
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {logJobId && (
        <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && closeLog()}>
          <div className="modal-card deploy-log-modal">
            <div className="modal-header">
              <h3>Deployment log</h3>
              <button type="button" className="close-btn" onClick={closeLog} aria-label="Close">
                ×
              </button>
            </div>
            <div className="modal-body">
              <JobStatus key={logJobId} jobId={logJobId} onClose={closeLog} />
            </div>
          </div>
        </div>
      )}

      {viewTarget && (
        <RequestDetailsModal
          request={viewTarget}
          onClose={() => {
            setViewTarget(null);
            const next = new URLSearchParams(params);
            next.delete("request");
            setParams(next, { replace: true });
          }}
          onApprove={handleApprove}
          onReject={() => {
            setRejectTarget(viewTarget);
            setViewTarget(null);
          }}
        />
      )}

      {rejectTarget && (
        <RejectRequestModal
          request={rejectTarget}
          onClose={() => setRejectTarget(null)}
          onDone={async () => {
            setRejectTarget(null);
            setTab("failed");
            const r = await getProvisionRequests();
            setRequests(Array.isArray(r) ? r : []);
          }}
        />
      )}
    </div>
  );
}
