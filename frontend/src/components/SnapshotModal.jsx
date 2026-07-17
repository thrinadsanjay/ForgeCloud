import { useEffect, useState } from "react";
import { getSnapshots, createSnapshot, rollbackSnapshot, deleteSnapshot } from "../api/client.js";
import { useDialog } from "./DialogProvider.jsx";

function fmtTime(ms) {
  if (!ms) return "—";
  try { return new Date(ms).toLocaleString(); } catch { return "—"; }
}

export default function SnapshotModal({ resource, onClose, onChanged }) {
  const { type, vmid, name } = resource;
  const { confirm } = useDialog();
  const canRam = type === "vm" && resource.status === "running";

  const [snaps, setSnaps] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");            // action label while working
  const [form, setForm] = useState({ name: "", description: "", includeRam: false });

  const load = () => {
    setLoading(true);
    getSnapshots(type, vmid)
      .then((d) => { setSnaps(d); setError(""); })
      .catch((e) => setError(e.response?.data?.error || e.message))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, [type, vmid]);

  const take = async (e) => {
    e.preventDefault();
    setBusy("Creating snapshot"); setError("");
    try {
      await createSnapshot(type, vmid, { name: form.name.trim(), description: form.description.trim(), includeRam: form.includeRam });
      setForm({ name: "", description: "", includeRam: false });
      load();
      onChanged?.();
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setBusy("");
    }
  };

  const restore = async (snap) => {
    if (!(await confirm({ title: "Restore snapshot", message: `Restore "${name}" to snapshot "${snap}"? Current state since the snapshot will be lost.`, confirmLabel: "Restore", tone: "danger" }))) return;
    setBusy(`Restoring ${snap}`); setError("");
    try {
      await rollbackSnapshot(type, vmid, snap);
      load();
      onChanged?.();
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setBusy("");
    }
  };

  const remove = async (snap) => {
    if (!(await confirm({ title: "Delete snapshot", message: `Delete snapshot "${snap}"? This can't be undone.`, confirmLabel: "Delete", tone: "danger" }))) return;
    setBusy(`Deleting ${snap}`); setError("");
    try {
      await deleteSnapshot(type, vmid, snap);
      load();
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setBusy("");
    }
  };

  const working = !!busy;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card ch-modal snap-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>Snapshots — <span className="mono">{name}</span></h3>
          <button className="ds-close" onClick={onClose} aria-label="Close">×</button>
        </div>

        <div className="modal-body">
          {error && <div className="login-error" style={{ marginBottom: 12 }}>{error}</div>}

          <form className="ch-form" onSubmit={take}>
            <div className="field">
              <label>New snapshot name</label>
              <input className="ch-input" required placeholder="before-upgrade" value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
            </div>
            <div className="field">
              <label>Description <span className="muted">(optional)</span></label>
              <input className="ch-input" placeholder="What state is this?" value={form.description}
                onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} />
            </div>
            {canRam && (
              <div className="set-row set-row-toggle" style={{ margin: "0 0 12px" }}>
                <div className="set-row-label">
                  <label>Include memory (RAM) state</label>
                  <p className="set-help">Captures the running VM's RAM so a restore resumes live.</p>
                </div>
                <button type="button" role="switch" aria-checked={form.includeRam}
                  className={`switch ${form.includeRam ? "on" : ""}`}
                  onClick={() => setForm((f) => ({ ...f, includeRam: !f.includeRam }))}>
                  <span className="switch-knob" />
                </button>
              </div>
            )}
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <button className="btn btn-primary" disabled={working || !form.name.trim()}>
                {busy === "Creating snapshot" ? "Creating…" : "Take snapshot"}
              </button>
            </div>
          </form>

          <div className="section-title" style={{ marginTop: 18 }}>Existing snapshots</div>
          {loading ? (
            <div className="empty">Loading…</div>
          ) : snaps.length === 0 ? (
            <div className="empty">No snapshots yet.</div>
          ) : (
            <ul className="snap-list">
              {snaps.map((s) => (
                <li key={s.name} className="snap-item">
                  <div className="snap-info">
                    <div className="snap-name">
                      {s.name}
                      {s.vmstate && <span className="badge badge-neutral" style={{ marginLeft: 8 }}>RAM</span>}
                    </div>
                    {s.description && <div className="muted snap-desc">{s.description}</div>}
                    <div className="muted snap-time">{fmtTime(s.snaptime)}</div>
                  </div>
                  <div className="snap-actions">
                    <button className="btn btn-ghost btn-sm" disabled={working} onClick={() => restore(s.name)}>Restore</button>
                    <button className="btn btn-danger btn-sm" disabled={working} onClick={() => remove(s.name)}>Delete</button>
                  </div>
                </li>
              ))}
            </ul>
          )}

          {working && <p className="muted" style={{ marginTop: 12 }}><span className="spinner" style={{ width: 12, height: 12 }} /> {busy}…</p>}
        </div>
      </div>
    </div>
  );
}
