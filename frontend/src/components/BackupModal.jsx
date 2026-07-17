import { useEffect, useState } from "react";
import { getBackupConfig, saveBackupConfig, deleteBackupConfig, runBackupNow } from "../api/client.js";
import { useDialog } from "./DialogProvider.jsx";

const DAYS = [
  { id: "mon", label: "Monday" }, { id: "tue", label: "Tuesday" }, { id: "wed", label: "Wednesday" },
  { id: "thu", label: "Thursday" }, { id: "fri", label: "Friday" }, { id: "sat", label: "Saturday" },
  { id: "sun", label: "Sunday" },
];

// Turn form controls into a Proxmox calendar schedule string.
function buildSchedule({ frequency, day, time }) {
  return frequency === "weekly" ? `${day} ${time}` : time;
}

// Best-effort parse of an existing schedule back into the controls.
function parseSchedule(schedule) {
  const s = String(schedule || "").trim();
  let m = /^(\d{2}:\d{2})$/.exec(s);
  if (m) return { frequency: "daily", day: "mon", time: m[1] };
  m = /^(mon|tue|wed|thu|fri|sat|sun)\s+(\d{2}:\d{2})$/i.exec(s);
  if (m) return { frequency: "weekly", day: m[1].toLowerCase(), time: m[2] };
  return null;
}

export default function BackupModal({ resource, onClose }) {
  const { type, vmid, name } = resource;
  const { confirm } = useDialog();

  const [storages, setStorages] = useState([]);
  const [form, setForm] = useState({
    enabled: true, storage: "", frequency: "daily", day: "mon", time: "02:00", keepLast: 3, mode: "snapshot",
  });
  const [rawSchedule, setRawSchedule] = useState(""); // shown when we can't parse it
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    setLoading(true);
    getBackupConfig(type, vmid)
      .then(({ config, storages: st }) => {
        setStorages(st || []);
        const firstStorage = st?.[0]?.storage || "";
        if (config) {
          const parsed = parseSchedule(config.schedule);
          setRawSchedule(parsed ? "" : config.schedule);
          setForm((f) => ({
            ...f,
            enabled: config.enabled,
            storage: config.storage || firstStorage,
            mode: config.mode || "snapshot",
            keepLast: config.keepLast || 3,
            ...(parsed || {}),
          }));
        } else {
          setForm((f) => ({ ...f, storage: firstStorage }));
        }
        setError("");
      })
      .catch((e) => setError(e.response?.data?.error || e.message))
      .finally(() => setLoading(false));
  }, [type, vmid]);

  const upd = (k) => (e) => {
    const v = e.target.type === "number" ? Number(e.target.value) : e.target.value;
    setForm((f) => ({ ...f, [k]: v }));
  };

  const save = async () => {
    setBusy("save"); setError(""); setNotice("");
    try {
      await saveBackupConfig(type, vmid, {
        enabled: form.enabled,
        storage: form.storage,
        schedule: buildSchedule(form),
        mode: form.mode,
        keepLast: Number(form.keepLast),
      });
      setNotice("Backup schedule saved.");
    } catch (e) {
      setError(e.response?.data?.error || e.message);
    } finally {
      setBusy("");
    }
  };

  const remove = async () => {
    if (!(await confirm({ title: "Remove backup schedule", message: "Remove the scheduled backup for this resource?", confirmLabel: "Remove", tone: "danger" }))) return;
    setBusy("remove"); setError(""); setNotice("");
    try {
      await deleteBackupConfig(type, vmid);
      setNotice("Backup schedule removed.");
    } catch (e) {
      setError(e.response?.data?.error || e.message);
    } finally {
      setBusy("");
    }
  };

  const runNow = async () => {
    if (!form.storage) { setError("Pick a storage first."); return; }
    setBusy("run"); setError(""); setNotice("");
    try {
      await runBackupNow(type, vmid, { storage: form.storage, mode: form.mode });
      setNotice("Backup started — it runs in the background on Proxmox.");
    } catch (e) {
      setError(e.response?.data?.error || e.message);
    } finally {
      setBusy("");
    }
  };

  const working = !!busy;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card ch-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>Configure backup — <span className="mono">{name}</span></h3>
          <button className="ds-close" onClick={onClose} aria-label="Close">×</button>
        </div>

        <div className="modal-body">
          {error && <div className="login-error" style={{ marginBottom: 12 }}>{error}</div>}
          {notice && <div className="set-notice" style={{ marginBottom: 12 }}>{notice}</div>}

          {loading ? (
            <div className="empty">Loading…</div>
          ) : storages.length === 0 ? (
            <div className="empty">No backup-capable storage found on the node. Add one in Proxmox first.</div>
          ) : (
            <form className="ch-form" onSubmit={(e) => { e.preventDefault(); save(); }}>
              <div className="set-row set-row-toggle" style={{ margin: "0 0 14px" }}>
                <div className="set-row-label">
                  <label>Scheduled backups enabled</label>
                </div>
                <button type="button" role="switch" aria-checked={form.enabled}
                  className={`switch ${form.enabled ? "on" : ""}`}
                  onClick={() => setForm((f) => ({ ...f, enabled: !f.enabled }))}>
                  <span className="switch-knob" />
                </button>
              </div>

              <div className="field">
                <label>Storage</label>
                <select className="ch-input" value={form.storage} onChange={upd("storage")}>
                  {storages.map((s) => <option key={s.storage} value={s.storage}>{s.storage}</option>)}
                </select>
              </div>

              <div className="provision-field-grid">
                <div className="field">
                  <label>Frequency</label>
                  <select className="ch-input" value={form.frequency} onChange={upd("frequency")}>
                    <option value="daily">Daily</option>
                    <option value="weekly">Weekly</option>
                  </select>
                </div>
                <div className="field">
                  <label>Time</label>
                  <input className="ch-input" type="time" value={form.time} onChange={upd("time")} />
                </div>
              </div>

              {form.frequency === "weekly" && (
                <div className="field">
                  <label>Day of week</label>
                  <select className="ch-input" value={form.day} onChange={upd("day")}>
                    {DAYS.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
                  </select>
                </div>
              )}

              <div className="provision-field-grid">
                <div className="field">
                  <label>Keep last</label>
                  <input className="ch-input" type="number" min="1" max="365" value={form.keepLast} onChange={upd("keepLast")} />
                </div>
                <div className="field">
                  <label>Mode</label>
                  <select className="ch-input" value={form.mode} onChange={upd("mode")}>
                    <option value="snapshot">Snapshot (no downtime)</option>
                    <option value="suspend">Suspend</option>
                    <option value="stop">Stop</option>
                  </select>
                </div>
              </div>

              {rawSchedule && (
                <p className="muted" style={{ marginTop: 0, marginBottom: 12, fontSize: 12 }}>
                  Current schedule <span className="mono">{rawSchedule}</span> — saving will replace it with your selection above.
                </p>
              )}

              <div className="modal-actions" style={{ justifyContent: "space-between" }}>
                <button type="button" className="btn btn-ghost btn-sm" disabled={working} onClick={runNow}>
                  {busy === "run" ? "Starting…" : "Back up now"}
                </button>
                <div style={{ display: "flex", gap: 10 }}>
                  <button type="button" className="btn btn-danger btn-sm" disabled={working} onClick={remove}>
                    {busy === "remove" ? "Removing…" : "Remove"}
                  </button>
                  <button className="btn btn-primary" disabled={working || !form.storage}>
                    {busy === "save" ? "Saving…" : "Save schedule"}
                  </button>
                </div>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
