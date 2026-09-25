import { useEffect, useState } from "react";

/**
 * Edit KEY=value environment lines.
 * @param {{
 *   title: string,
 *   subtitle?: string,
 *   loadEnv: () => Promise<string[]>,
 *   saveEnv: (env: string[]) => Promise<{ message?: string } | void>,
 *   restartNote?: string,
 *   onClose: () => void,
 *   onSaved?: () => void,
 * }} props
 */
export default function EnvEditorModal({
  title,
  subtitle = "",
  loadEnv,
  saveEnv,
  restartNote = "Saving replaces environment variables and restarts the workload.",
  onClose,
  onSaved,
}) {
  const [text, setText] = useState("");
  const [original, setOriginal] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError("");
      try {
        const lines = await loadEnv();
        const joined = (Array.isArray(lines) ? lines : []).join("\n");
        if (!cancelled) {
          setText(joined);
          setOriginal(joined);
        }
      } catch (e) {
        if (!cancelled) setError(e.response?.data?.error || e.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [loadEnv]);

  const dirty = text !== original;

  const submit = async (e) => {
    e.preventDefault();
    const env = text.split("\n").map((l) => l.trim()).filter(Boolean);
    for (const line of env) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*=/.test(line)) {
        setError(`Invalid entry "${line}" — use KEY=value`);
        return;
      }
    }
    setSaving(true);
    setError("");
    setInfo("");
    try {
      const result = await saveEnv(env);
      setOriginal(text);
      setInfo(result?.message || "Environment saved. Workload will restart.");
      onSaved?.();
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card ch-modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 640 }}>
        <div className="modal-header">
          <h3>{title}</h3>
          <button className="ds-close" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="modal-body">
          {subtitle && <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>{subtitle}</p>}
          <p className="muted" style={{ fontSize: 12.5, marginTop: 0 }}>{restartNote}</p>
          {error && <div className="login-error" style={{ marginBottom: 12 }}>{error}</div>}
          {info && (
            <div style={{ marginBottom: 12, padding: "8px 12px", borderRadius: 8, background: "var(--ok-tint)", color: "var(--ok)", fontSize: 13 }}>
              {info}
            </div>
          )}
          {loading ? (
            <p className="muted">Loading…</p>
          ) : (
            <form className="ch-form" onSubmit={submit}>
              <div className="field">
                <label>Environment variables <span className="muted">(one KEY=value per line)</span></label>
                <textarea
                  className="ch-input mono"
                  rows={14}
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  spellCheck={false}
                  style={{ fontSize: 12.5, lineHeight: 1.45 }}
                />
              </div>
              {dirty && (
                <p style={{ color: "var(--warn)", fontSize: 13, margin: "0 0 10px" }}>
                  Unsaved changes — applying will restart the container / roll out new pods.
                </p>
              )}
              <div className="modal-actions">
                <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
                <button className="btn btn-primary" disabled={saving || !dirty}>
                  {saving ? "Saving…" : "Save & restart"}
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
