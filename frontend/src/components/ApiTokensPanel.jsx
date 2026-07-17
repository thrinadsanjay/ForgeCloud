import { useEffect, useState } from "react";
import { listPats, createPat, revokePat } from "../api/client.js";
import { useDialog } from "./DialogProvider.jsx";

const EXPIRY_OPTIONS = [
  { value: 30, label: "30 days" },
  { value: 90, label: "90 days" },
  { value: 365, label: "1 year" },
  { value: 0, label: "No expiry" },
];

function fmtDate(ts) {
  if (!ts) return "—";
  try { return new Date(ts).toLocaleDateString(); } catch { return "—"; }
}

// Personal Access Token management, shown inside the account menu. Lets a user
// mint a token for Terraform/Ansible/CLI, see it once, and revoke old ones.
export default function ApiTokensPanel() {
  const { confirm } = useDialog();
  const [pats, setPats] = useState([]);
  const [name, setName] = useState("");
  const [expiresInDays, setExpiresInDays] = useState(90);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [newToken, setNewToken] = useState("");
  const [copied, setCopied] = useState(false);

  const load = () => listPats().then((d) => setPats(d.pats || [])).catch(() => {});

  useEffect(() => { load(); }, []);

  const generate = async (e) => {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const { token } = await createPat({ name: name.trim() || "token", expiresInDays });
      setNewToken(token);
      setCopied(false);
      setName("");
      await load();
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (id) => {
    if (!(await confirm({ title: "Revoke token", message: "Revoke this token? Any tool using it will stop working.", confirmLabel: "Revoke", tone: "danger" }))) return;
    try {
      await revokePat(id);
      await load();
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    }
  };

  const copyToken = async () => {
    try {
      await navigator.clipboard.writeText(newToken);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="pat-panel">
      <div className="user-menu-section-title">API tokens</div>
      <p className="pat-hint">Use with Terraform, Ansible or any REST client via <code>Authorization: Bearer &lt;token&gt;</code>.</p>

      {newToken && (
        <div className="pat-new">
          <div className="pat-new-label">Copy your token now — it won't be shown again.</div>
          <code className="pat-new-value">{newToken}</code>
          <div className="pat-new-actions">
            <button type="button" className="btn btn-primary btn-sm" onClick={copyToken}>{copied ? "Copied ✓" : "Copy"}</button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setNewToken("")}>Done</button>
          </div>
        </div>
      )}

      <form className="pat-form" onSubmit={generate}>
        <input
          className="control-input pat-name"
          placeholder="Token name (e.g. terraform-ci)"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <select className="control-select" value={expiresInDays} onChange={(e) => setExpiresInDays(Number(e.target.value))}>
          {EXPIRY_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <button className="btn btn-primary btn-sm" disabled={busy}>{busy ? "Generating…" : "Generate"}</button>
      </form>

      {error && <p className="login-error" style={{ margin: "8px 0 0" }}>{error}</p>}

      <div className="pat-list">
        {pats.length === 0 && <div className="muted" style={{ fontSize: 12, padding: "6px 0" }}>No tokens yet.</div>}
        {pats.map((p) => (
          <div key={p.id} className="pat-item">
            <div className="pat-item-main">
              <span className="pat-item-name">{p.name}</span>
              <span className="pat-item-meta mono">{p.prefix}</span>
            </div>
            <div className="pat-item-sub">
              <span>Created {fmtDate(p.createdAt)}</span>
              <span>· Expires {p.expiresAt ? fmtDate(p.expiresAt) : "never"}</span>
            </div>
            <button type="button" className="pat-revoke" onClick={() => revoke(p.id)} title="Revoke token">Revoke</button>
          </div>
        ))}
      </div>
    </div>
  );
}
