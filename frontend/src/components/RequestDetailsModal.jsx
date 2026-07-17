import { useEffect, useState } from "react";
import { getRequestImpact } from "../api/client.js";
import ServiceNowPanel from "./ServiceNowPanel.jsx";

const GB = 1024 ** 3;

function fmt(value, unit) {
  if (unit === "cores") {
    const n = Number(value || 0);
    return `${Number.isInteger(n) ? n : n.toFixed(1)} vCPU`;
  }
  const gb = Number(value || 0) / GB;
  if (gb >= 1024) return `${(gb / 1024).toFixed(1)} TB`;
  return `${gb.toFixed(gb < 10 ? 1 : 0)} GB`;
}

const pct = (p) => `${Number(p || 0).toFixed(1)}%`;

function ResourceInfo({ r }) {
  return (
    <span className="info-tip" tabIndex={0} aria-label={`${r.label} capacity breakdown`}>
      <span className="info-tip-icon" aria-hidden="true">i</span>
      <span className="info-tip-pop" role="tooltip">
        <span className="info-tip-title">{r.label} capacity</span>
        <table className="info-tip-table">
          <thead>
            <tr><th></th><th>Before</th><th>After</th></tr>
          </thead>
          <tbody>
            <tr>
              <td>Total</td>
              <td>{fmt(r.total, r.unit)}</td>
              <td>{fmt(r.total, r.unit)}</td>
            </tr>
            <tr>
              <td>In use</td>
              <td>{fmt(r.currentUsed, r.unit)}</td>
              <td>{fmt(r.projectedUsed, r.unit)}</td>
            </tr>
            <tr>
              <td>Balance</td>
              <td>{fmt(r.balanceBefore, r.unit)}</td>
              <td className={r.balanceAfter < 0 ? "usage-red" : ""}>{fmt(r.balanceAfter, r.unit)}</td>
            </tr>
          </tbody>
        </table>
      </span>
    </span>
  );
}

function fmtWhen(ts) {
  if (!ts) return "—";
  try { return new Date(ts).toLocaleString(); } catch { return String(ts); }
}

/**
 * Review / view a provision request.
 * - pending_approval + onApprove/onReject → approve UI
 * - otherwise read-only request details (past deployments)
 */
export default function RequestDetailsModal({ request, onApprove, onReject, onClose }) {
  const [impact, setImpact] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const p = request.payload || {};
  const isRenew = request.kind === "renew";
  const target = p.hostname || p.hostnamePrefix || (p.vmid ? `VMID ${p.vmid}` : null) || p.templateId || p.stackId || "-";
  const packages = Array.isArray(p.packages) ? p.packages.filter(Boolean) : [];
  const reviewing = request.status === "pending_approval" && typeof onApprove === "function";
  const os = impact?.details?.os;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    getRequestImpact(request.id)
      .then((data) => { if (!cancelled) setImpact(data); })
      .catch((err) => {
        // Past requests may fail impact calc (node offline) — details still useful.
        if (!cancelled && reviewing && !isRenew) setError(err.response?.data?.error || err.message);
        else if (!cancelled) setImpact(isRenew ? { canApprove: true, resources: {}, details: {} } : null);
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [request.id, reviewing, isRenew]);

  const canApprove = (isRenew ? !busy && !loading : impact?.canApprove && !busy && !loading);

  const approve = async () => {
    setBusy(true);
    try {
      await onApprove(request.id);
      onClose();
    } catch (err) {
      setError(err.response?.data?.error || err.message);
      setBusy(false);
    }
  };

  const resources = impact?.resources
    ? [impact.resources.cpu, impact.resources.memory, impact.resources.storage].filter(Boolean)
    : [];
  const worst = resources.some((r) => r.level === "red") ? "red"
    : resources.some((r) => r.level === "amber") ? "amber"
    : resources.length ? "green" : "";

  return (
    <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal-card modal-card-wide">
        <div className="modal-header">
          <h3>{reviewing ? (isRenew ? "Review renewal" : "Review request") : "Request details"}</h3>
          <button className="close-btn" onClick={onClose}>×</button>
        </div>

        <div className="modal-body">
          <div className="req-summary">
            <div className="req-summary-row"><span>Request</span><strong className="mono">{request.id}</strong></div>
            <div className="req-summary-row"><span>Requested by</span><strong>{request.requestedBy || "—"}</strong></div>
            <div className="req-summary-row"><span>Status</span><strong>{request.status}</strong></div>
            <div className="req-summary-row"><span>Type</span><strong>{request.kind}</strong></div>
            <div className="req-summary-row"><span>Target host</span><strong>{target}</strong></div>
            {isRenew ? (
              <>
                <div className="req-summary-row"><span>VMID</span><strong className="mono">{p.vmid || "—"}</strong></div>
                <div className="req-summary-row"><span>Extend by</span><strong>{p.days ? `${p.days} days` : "—"}</strong></div>
              </>
            ) : (
              <div className="req-summary-row"><span>OS / template</span><strong>{os || p.templateId || p.stackId || (loading ? "…" : "—")}</strong></div>
            )}
            {p.environment && <div className="req-summary-row"><span>Environment</span><strong>{p.environment}</strong></div>}
            {request.jobId && <div className="req-summary-row"><span>Job</span><strong className="mono">{request.jobId}</strong></div>}
            <div className="req-summary-row"><span>Submitted</span><strong>{fmtWhen(request.createdAt)}</strong></div>
            {request.approvedAt && (
              <div className="req-summary-row">
                <span>Approved</span>
                <strong>{fmtWhen(request.approvedAt)}{request.approvedBy ? ` · ${request.approvedBy}` : ""}</strong>
              </div>
            )}
            {request.rejectedAt && (
              <div className="req-summary-row">
                <span>Rejected</span>
                <strong>{fmtWhen(request.rejectedAt)}{request.rejectedBy ? ` · ${request.rejectedBy}` : ""}</strong>
              </div>
            )}
            {request.rejectionReason && (
              <div className="req-summary-row"><span>Reason</span><strong>{request.rejectionReason}</strong></div>
            )}
            {!isRenew && (
              <div className="req-summary-grid">
                <div className="req-chip"><span>CPU</span><strong>{p.cpu ? `${p.cpu} vCPU` : "—"}</strong></div>
                <div className="req-chip"><span>RAM</span><strong>{p.memoryGB ? `${p.memoryGB} GB` : "—"}</strong></div>
                <div className="req-chip"><span>Storage</span><strong>{p.diskGB ? `${p.diskGB} GB` : "—"}</strong></div>
              </div>
            )}
            {packages.length > 0 && (
              <div className="req-summary-row" style={{ marginTop: 10, alignItems: "flex-start" }}>
                <span>Packages</span>
                <strong style={{ textAlign: "right" }}>{packages.join(", ")}</strong>
              </div>
            )}
            {impact?.requested?.units > 1 && (
              <p className="muted" style={{ fontSize: 11.5, margin: "8px 0 0" }}>
                Stack provisions {impact.requested.units} nodes — totals below reflect all of them.
              </p>
            )}
          </div>

          <ServiceNowPanel servicenow={request.servicenow} />

          {isRenew && reviewing && (
            <div className="usage-box usage-box-green">
              <div className="usage-box-title">Renewal request</div>
              <p className="muted" style={{ fontSize: 13, margin: 0 }}>
                Approving extends the expiry by {p.days || "—"} days from now and unlocks Power on for this resource.
                No additional Proxmox capacity is reserved.
              </p>
              {error && <p className="login-error" style={{ margin: "8px 0 0" }}>{error}</p>}
            </div>
          )}

          {!isRenew && (reviewing || impact) && (
            <div className={`usage-box usage-box-${worst || "muted"}`}>
              <div className="usage-box-title">Projected node usage after provisioning</div>
              {loading && <p className="muted" style={{ fontSize: 13, margin: 0 }}>Calculating capacity impact…</p>}
              {error && <p className="login-error" style={{ margin: 0 }}>{error}</p>}
              {!loading && !error && impact && resources.length > 0 && (
                <ul className="usage-bullets">
                  {resources.map((r) => (
                    <li key={r.label} className={`usage-bullet usage-${r.level}`}>
                      <span className={`usage-bullet-dot usage-fill-${r.level}`} />
                      <span className="usage-bullet-label">{r.label}</span>
                      <span className={`usage-bullet-val usage-${r.level}`}>{pct(r.percentAfter)}</span>
                      <ResourceInfo r={r} />
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {reviewing && impact && !impact.canApprove && !isRenew && (
            <p className="usage-block-warning">
              Approval blocked — provisioning would exceed 80% on {impact.blocking.join(", ")}.
            </p>
          )}

          <div className="modal-actions">
            {reviewing ? (
              <>
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => onReject(request)}
                  disabled={busy}
                >
                  Reject
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={approve}
                  disabled={!canApprove}
                  title={impact && !impact.canApprove ? "Usage would exceed 80%" : undefined}
                >
                  {busy ? "Approving…" : "Approve"}
                </button>
              </>
            ) : (
              <button type="button" className="btn btn-primary" onClick={onClose}>Close</button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
