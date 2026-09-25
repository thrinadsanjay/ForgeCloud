import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { approveProvisionRequest, getProvisionRequests } from "../api/client.js";
import { useAuth } from "../context/AuthContext.jsx";
import RejectRequestModal from "../components/RejectRequestModal.jsx";
import RequestDetailsModal from "../components/RequestDetailsModal.jsx";

function statusClass(status = "") {
  const s = status.toLowerCase();
  if (s.includes("pending")) return "badge badge-provisioning";
  if (s.includes("approved") || s.includes("completed")) return "badge badge-ready";
  if (s.includes("failed") || s.includes("rejected")) return "badge badge-failed";
  if (s.includes("provision")) return "badge badge-booting";
  return "badge badge-stopped";
}

export default function Requests() {
  const { isAdmin } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const [items, setItems] = useState([]);
  const [query, setQuery] = useState("");
  const [rejectTarget, setRejectTarget] = useState(null);  // request being rejected
  const [viewTarget, setViewTarget] = useState(null);      // request being reviewed

  const load = async () => {
    const data = await getProvisionRequests();
    setItems(Array.isArray(data) ? data : []);
  };

  useEffect(() => {
    load().catch(() => {});
  }, []);

  // Deep-link from an approval notification: /requests?review=<id> opens the
  // review dialog for a pending request (admins only).
  useEffect(() => {
    const reviewId = searchParams.get("review");
    if (!reviewId || !isAdmin || items.length === 0) return;
    const target = items.find((r) => r.id === reviewId && r.status === "pending_approval");
    if (target) setViewTarget(target);
    const next = new URLSearchParams(searchParams);
    next.delete("review");
    setSearchParams(next, { replace: true });
  }, [searchParams, items, isAdmin]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter((r) =>
      (r.id || "").toLowerCase().includes(q)
      || (r.requestedBy || "").toLowerCase().includes(q)
      || (r.kind || "").toLowerCase().includes(q)
      || (r.status || "").toLowerCase().includes(q)
      || (r.payload?.hostname || r.payload?.hostnamePrefix || "").toLowerCase().includes(q)
    );
  }, [items, query]);

  // Approve from the review modal. Lets errors propagate so the modal can show
  // them inline; refreshes the list on success.
  const handleApprove = async (id) => {
    await approveProvisionRequest(id);
    await load();
  };


  return (
    <div className="page">
      <div className="page-head">
        <div className="eyebrow">Workflow</div>
        <h1>Requests</h1>
        <p>{isAdmin ? "Review and approve user requests before provisioning." : "Track all provisioning requests and current status."}</p>
      </div>

      <div className="toolbar toolbar-panel" style={{ marginBottom: 14 }}>
        <input
          className="control-input"
          placeholder="Search by request id, user, kind, status..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <span className="muted" style={{ marginLeft: "auto", fontSize: 13 }}>{filtered.length} requests</span>
      </div>

      <div className="card">
        <table className="table">
          <thead>
            <tr>
              <th>Request</th>
              {isAdmin && <th>User</th>}
              <th>Target</th>
              <th>Kind</th>
              <th>Status</th>
              <th>ServiceNow</th>
              <th>Created</th>
              <th>Job</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((r) => {
              const target = r.payload?.hostname || r.payload?.hostnamePrefix || r.payload?.templateId || r.payload?.stackId || "-";
              const canReview = isAdmin && r.status === "pending_approval";
              const specs = [
                r.payload?.cpu != null ? `${r.payload.cpu} vCPU` : null,
                r.payload?.memoryGB != null ? `${r.payload.memoryGB} GB` : null,
                r.payload?.diskGB ? `+${r.payload.diskGB} GB disk` : null,
              ].filter(Boolean).join(" · ");
              return (
                <tr key={r.id}>
                  <td className="mono">{r.id}</td>
                  {isAdmin && <td>{r.requestedBy}</td>}
                  <td>
                    <div>{target}</div>
                    {specs && <div className="muted" style={{ fontSize: 12 }}>{specs}</div>}
                  </td>
                  <td>{r.kind}</td>
                  <td><span className={statusClass(r.status)}>{r.status}</span></td>
                  <td>
                    {r.servicenow?.ritmNumber ? (
                      r.servicenow.ritmUrl ? (
                        <a className="mono" href={r.servicenow.ritmUrl} target="_blank" rel="noreferrer">{r.servicenow.ritmNumber}</a>
                      ) : (
                        <span className="mono">{r.servicenow.ritmNumber}</span>
                      )
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                  <td className="mono">{new Date(r.createdAt).toLocaleString()}</td>
                  <td className="mono">{r.jobId || "-"}</td>
                  <td className="actions-cell">
                    <button
                      className={`btn btn-sm ${canReview ? "btn-primary" : "btn-ghost"}`}
                      onClick={() => setViewTarget(r)}
                    >
                      {canReview ? "Review" : "Details"}
                    </button>
                  </td>
                </tr>
              );
            })}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={isAdmin ? 9 : 8} className="muted" style={{ textAlign: "center", padding: 24 }}>
                  No requests found.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {viewTarget && (
        <RequestDetailsModal
          request={viewTarget}
          onApprove={handleApprove}
          onReject={(r) => { setViewTarget(null); setRejectTarget(r); }}
          onClose={() => setViewTarget(null)}
        />
      )}

      {rejectTarget && (
        <RejectRequestModal
          request={rejectTarget}
          onClose={() => setRejectTarget(null)}
          onDone={() => load().catch(() => {})}
        />
      )}
    </div>
  );
}
