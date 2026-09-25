import { useState } from "react";
import { extendResource } from "../api/client.js";
import { useAuth } from "../context/AuthContext.jsx";

// Renew / extend a resource's expiry. Owners always submit an approval request
// for admins/approvers. Admins can apply immediately (ops shortcut).
export default function ExtendExpiryModal({ resource, onClose, onSaved }) {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const [days, setDays] = useState(30);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const current = resource.expiresAt
    ? new Date(resource.expiresAt).toLocaleDateString()
    : "no expiry set";

  const submit = async (e) => {
    e.preventDefault();
    setError("");
    setNotice("");
    const n = Number(days);
    if (!Number.isFinite(n) || n <= 0) {
      setError("Enter a positive number of days.");
      return;
    }
    setBusy(true);
    try {
      // Owners always go through approval; admins extend immediately unless they
      // tick "submit for review" (not exposed — keep admin path instant).
      const result = await extendResource(resource.type, resource.vmid, n, {
        requireApproval: !isAdmin,
      });
      if (result?.pendingApproval) {
        setNotice(result.message || "Renewal submitted for approval.");
        onSaved?.({ pendingApproval: true, request: result.request });
        // Keep modal open briefly so the user sees the confirmation, then close.
        setTimeout(() => onClose(), 1200);
      } else {
        onSaved?.({ pendingApproval: false, expiresAt: result.expiresAt });
        onClose();
      }
    } catch (err) {
      const pending = err.response?.data?.request;
      if (err.response?.status === 409 && pending) {
        setError(err.response.data.error || "A renewal is already pending approval.");
      } else {
        setError(err.response?.data?.error || err.message);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal-card">
        <div className="modal-header">
          <h3>Renew {resource.name || `VMID ${resource.vmid}`}</h3>
          <button className="close-btn" onClick={onClose}>×</button>
        </div>

        <form onSubmit={submit} className="modal-body">
          <p className="muted" style={{ fontSize: 12, marginTop: 0 }}>
            Current expiry: <strong>{current}</strong>
            {resource.daysLeft != null && !resource.expired && ` (${resource.daysLeft}d left)`}
            {resource.expired && " (expired — powered off)"}
          </p>

          {!isAdmin && (
            <p className="muted" style={{ fontSize: 12 }}>
              This sends a renewal request to admins and deployment approvers.
              Power on stays blocked until they approve.
            </p>
          )}

          <label className="field">
            <span>Extend by (days from now)</span>
            <input
              type="number"
              min="1"
              max="3650"
              value={days}
              autoFocus
              onChange={(e) => setDays(e.target.value)}
            />
          </label>

          <div className="extend-quick">
            {[7, 30, 90, 365].map((d) => (
              <button
                type="button"
                key={d}
                className={`chip-btn ${Number(days) === d ? "chip-btn-active" : ""}`}
                onClick={() => setDays(d)}
              >
                {d}d
              </button>
            ))}
          </div>

          <p className="muted" style={{ fontSize: 12 }}>
            The new expiry will be {days || "…"} day{Number(days) === 1 ? "" : "s"} from approval
            {isAdmin ? " (applied immediately as admin)" : ""}.
          </p>

          {notice && <p className="set-notice" style={{ marginTop: 0 }}>{notice}</p>}
          {error && <p className="login-error" style={{ marginTop: 0 }}>{error}</p>}

          <div className="modal-actions">
            <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={busy}>
              {busy ? "Submitting…" : isAdmin ? "Extend now" : "Request renewal"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
