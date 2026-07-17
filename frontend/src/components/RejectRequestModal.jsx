import { useState } from "react";
import { rejectProvisionRequest } from "../api/client.js";

// Reject a provisioning request with an optional reason. Small floating form,
// consistent with the Edit/Extend modals (replaces a window.prompt).
export default function RejectRequestModal({ request, onClose, onDone }) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async (e) => {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      await rejectProvisionRequest(request.id, reason.trim() || "Rejected by admin");
      onDone?.();
      onClose();
    } catch (err) {
      setError(err.response?.data?.error || err.message);
      setBusy(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal-card">
        <div className="modal-header">
          <h3>Reject request</h3>
          <button className="close-btn" onClick={onClose}>×</button>
        </div>

        <form onSubmit={submit} className="modal-body">
          <p className="muted" style={{ fontSize: 12, marginTop: 0 }}>
            Request <span className="mono">{request.id}</span>
            {request.requestedBy && <> from <strong>{request.requestedBy}</strong></>}.
          </p>

          <label className="field">
            <span>Reason <em className="muted">— optional</em></span>
            <textarea
              rows={3}
              autoFocus
              placeholder="Rejected by admin"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </label>

          {error && <p className="login-error" style={{ marginTop: 0 }}>{error}</p>}

          <div className="modal-actions">
            <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
            <button type="submit" className="btn btn-danger" disabled={busy}>
              {busy ? "Rejecting…" : "Reject request"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
