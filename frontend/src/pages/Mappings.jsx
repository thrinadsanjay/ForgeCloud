import { useEffect, useState } from "react";
import {
  getMappings, saveTemplateMapping, deleteTemplateMapping,
  saveNetworkMapping, deleteNetworkMapping,
} from "../api/client.js";
import { useDialog } from "../components/DialogProvider.jsx";
import AdminPageHeader from "../components/AdminPageHeader.jsx";

const PKG_MANAGERS = ["apt", "yum", "dnf", "apk", "zypper", "powershell", "choco", "brew"];

function Icon({ name }) {
  const paths = {
    info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 7.5v.5" /></>,
    edit: <path d="M4 20h4L18.5 9.5a2.1 2.1 0 0 0-3-3L5 17v3zM14 6l3 3" />,
    save: <><path d="M5 4h11l3 3v13H5zM8 4v5h7" /><path d="M8 14h8v6H8z" /></>,
    trash: <path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13" />,
    close: <path d="M6 6l12 12M18 6L6 18" />,
  };
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor"
      strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>
  );
}

function IconBtn({ name, title, onClick, tone = "" }) {
  return (
    <button type="button" className={`icon-btn ${tone}`} title={title} aria-label={title} onClick={onClick}>
      <Icon name={name} />
    </button>
  );
}

function CloudInitState({ file, valid }) {
  if (!file) return <span className="muted">—</span>;
  if (valid === false) return <span className="badge badge-danger" title="Not found in snippets">{file} ⚠</span>;
  return <span className="badge badge-neutral" title="Present in /var/lib/vz/snippets">{file}</span>;
}

function TemplateRow({ row, snippets, onSaved, onError }) {
  const { confirm } = useDialog();
  const [editing, setEditing] = useState(false);
  const [info, setInfo] = useState(false);
  const [busy, setBusy] = useState(false);
  const [f, setF] = useState({});

  const startEdit = () => {
    setF({
      osName: row.osName || "",
      cloudInitFile: row.cloudInitFile || "",
      credUser: row.credUser || "",
      credPassword: "",
      connectivity: row.connectivity || "ssh",
      port: row.port || 22,
      packageManager: row.packageManager || "",
    });
    setEditing(true);
  };

  const upd = (k) => (e) => setF((s) => ({ ...s, [k]: e.target.value }));

  const save = async () => {
    setBusy(true);
    try {
      await saveTemplateMapping(row.vmid, f);
      setEditing(false);
      onSaved();
    } catch (e) {
      onError(e.response?.data?.error || e.message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!(await confirm({ title: "Clear mapping", message: `Clear mapping for ${row.templateName} (VMID ${row.vmid})?`, confirmLabel: "Clear", tone: "danger" }))) return;
    try { await deleteTemplateMapping(row.vmid); onSaved(); }
    catch (e) { onError(e.response?.data?.error || e.message); }
  };

  if (editing) {
    return (
      <tr className="map-row-editing">
        <td><strong>{row.templateName}</strong><div className="mono muted">VMID {row.vmid}</div></td>
        <td><input className="control-input" value={f.osName} onChange={upd("osName")} placeholder="e.g. Ubuntu 22.04" /></td>
        <td>
          <select className="control-select" value={f.cloudInitFile} onChange={upd("cloudInitFile")}>
            <option value="">— none —</option>
            {!snippets.includes(f.cloudInitFile) && f.cloudInitFile && <option value={f.cloudInitFile}>{f.cloudInitFile} (missing)</option>}
            {snippets.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </td>
        <td><input className="control-input" value={f.credUser} onChange={upd("credUser")} placeholder="user" autoComplete="off" /></td>
        <td><input className="control-input" type="password" value={f.credPassword} onChange={upd("credPassword")} placeholder={row.hasPassword ? "•••• (unchanged)" : "password"} autoComplete="new-password" /></td>
        <td>
          <select className="control-select" value={f.connectivity} onChange={(e) => setF((s) => ({ ...s, connectivity: e.target.value, port: e.target.value === "winrm" ? 5985 : 22 }))}>
            <option value="ssh">SSH</option>
            <option value="winrm">WinRM</option>
          </select>
        </td>
        <td><input className="control-input map-port" type="number" min="1" value={f.port} onChange={upd("port")} /></td>
        <td>
          <input className="control-input" list="pkg-mgrs" value={f.packageManager} onChange={upd("packageManager")} placeholder="apt / yum…" />
        </td>
        <td>
          <div className="icon-row">
            <IconBtn name="save" title="Save" tone="ok" onClick={busy ? () => {} : save} />
            <IconBtn name="close" title="Cancel" onClick={() => setEditing(false)} />
          </div>
        </td>
      </tr>
    );
  }

  return (
    <>
      <tr>
        <td><strong>{row.templateName}</strong><div className="mono muted">VMID {row.vmid}</div></td>
        <td>{row.osName || <span className="muted">unmapped</span>}</td>
        <td><CloudInitState file={row.cloudInitFile} valid={row.cloudInitValid} /></td>
        <td>{row.credUser || <span className="muted">—</span>}</td>
        <td>{row.hasPassword ? <span className="badge badge-neutral">set</span> : <span className="muted">—</span>}</td>
        <td><span className="badge badge-neutral">{row.connectivity?.toUpperCase()}</span></td>
        <td className="mono">{row.port}</td>
        <td>{row.packageManager || <span className="muted">—</span>}</td>
        <td>
          <div className="icon-row">
            <IconBtn name="info" title="Details" onClick={() => setInfo((v) => !v)} />
            <IconBtn name="edit" title="Edit" onClick={startEdit} />
            <IconBtn name="trash" title="Clear mapping" tone="danger" onClick={remove} />
          </div>
        </td>
      </tr>
      {info && (
        <tr className="map-info-row">
          <td colSpan={9}>
            <span className="mono">VMID {row.vmid}</span> · cloud-init source: <strong>Proxmox snippet</strong>
            {" · "}file: <strong>{row.cloudInitFile || "none"}</strong>
            {row.cloudInitValid === false && <span className="badge badge-danger" style={{ marginLeft: 8 }}>snippet missing</span>}
            {" · "}connect over <strong>{row.connectivity?.toUpperCase()}</strong> on port <strong>{row.port}</strong>
            {row.packageManager && <> · package manager <strong>{row.packageManager}</strong></>}
          </td>
        </tr>
      )}
    </>
  );
}

function NetworkRow({ row, onSaved, onError }) {
  const [editing, setEditing] = useState(false);
  const [info, setInfo] = useState(false);
  const [f, setF] = useState({});

  const startEdit = () => { setF({ type: row.type, label: row.label || "" }); setEditing(true); };
  const upd = (k) => (e) => setF((s) => ({ ...s, [k]: e.target.value }));

  const save = async () => {
    try { await saveNetworkMapping(row.iface, f); setEditing(false); onSaved(); }
    catch (e) { onError(e.response?.data?.error || e.message); }
  };
  const remove = async () => {
    try { await deleteNetworkMapping(row.iface); onSaved(); }
    catch (e) { onError(e.response?.data?.error || e.message); }
  };

  const overridden = row.type !== row.detectedType;

  if (editing) {
    return (
      <tr className="map-row-editing">
        <td className="mono"><strong>{row.iface}</strong></td>
        <td><span className="badge badge-neutral">{row.detectedType}</span></td>
        <td>
          <select className="control-select" value={f.type} onChange={upd("type")}>
            <option value="bridge">Virtual bridge</option>
            <option value="vlan">VLAN</option>
          </select>
        </td>
        <td><input className="control-input" value={f.label} onChange={upd("label")} placeholder="e.g. Production LAN" /></td>
        <td>{row.active ? <span className="badge badge-running">active</span> : <span className="badge badge-stopped">down</span>}</td>
        <td className="mono">{row.cidr || "—"}</td>
        <td>
          <div className="icon-row">
            <IconBtn name="save" title="Save" tone="ok" onClick={save} />
            <IconBtn name="close" title="Cancel" onClick={() => setEditing(false)} />
          </div>
        </td>
      </tr>
    );
  }

  return (
    <>
      <tr>
        <td className="mono"><strong>{row.iface}</strong></td>
        <td><span className="badge badge-neutral">{row.detectedType}</span></td>
        <td>
          <span className={`badge ${row.type === "vlan" ? "badge-warn" : "badge-neutral"}`}>{row.type}</span>
          {overridden && <span className="muted" title="Overridden by admin"> ✎</span>}
        </td>
        <td>{row.label || <span className="muted">—</span>}</td>
        <td>{row.active ? <span className="badge badge-running">active</span> : <span className="badge badge-stopped">down</span>}</td>
        <td className="mono">{row.cidr || "—"}</td>
        <td>
          <div className="icon-row">
            <IconBtn name="info" title="Details" onClick={() => setInfo((v) => !v)} />
            <IconBtn name="edit" title="Edit" onClick={startEdit} />
            {overridden || row.label ? <IconBtn name="trash" title="Reset to auto-detected" tone="danger" onClick={remove} /> : null}
          </div>
        </td>
      </tr>
      {info && (
        <tr className="map-info-row">
          <td colSpan={7}>
            <span className="mono">{row.iface}</span> · auto-detected as <strong>{row.detectedType}</strong>
            {overridden && <> · overridden to <strong>{row.type}</strong></>}
            {row.cidr && <> · address <strong>{row.cidr}</strong></>}
            {" · "}{row.active ? "active" : "inactive"}
          </td>
        </tr>
      )}
    </>
  );
}

export default function Mappings({ embedded = false }) {
  const [data, setData] = useState({ templates: [], networks: [], snippets: [], snippetStorage: "local" });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [lastSyncedAt, setLastSyncedAt] = useState(null);

  const load = () => {
    setLoading(true);
    getMappings()
      .then((d) => {
        setData(d);
        setError("");
        setLastSyncedAt(new Date());
      })
      .catch((e) => setError(e.response?.data?.error || e.message))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, []);

  const syncAgeMs = lastSyncedAt ? Date.now() - lastSyncedAt.getTime() : null;
  const syncHealth = error
    ? { tone: "danger", label: "Sync failed" }
    : loading && !lastSyncedAt
      ? { tone: "muted", label: "Detecting…" }
      : syncAgeMs != null && syncAgeMs < 5 * 60_000
        ? { tone: "ok", label: "Fresh" }
        : syncAgeMs != null
          ? { tone: "amber", label: "Stale" }
          : { tone: "muted", label: "Not synced" };

  const syncLabel = lastSyncedAt
    ? `Last sync ${lastSyncedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`
    : "Not synced yet";

  const mappedTemplates = data.templates.filter((t) => t.osName).length;
  const activeNets = data.networks.filter((n) => n.active).length;

  return (
    <div className={embedded ? "adm-board" : "page adm-board"}>
      <AdminPageHeader
        title="Mappings"
        description="Templates and networks auto-detected from Proxmox. Map OS, cloud-init, credentials, and connectivity for provisioning."
      />

      <datalist id="pkg-mgrs">{PKG_MANAGERS.map((p) => <option key={p} value={p} />)}</datalist>

      <div className="adm-stat-grid">
        <div className="adm-stat-card">
          <span className="adm-stat-icon is-brand" aria-hidden="true">VM</span>
          <div>
            <div className="adm-stat-label">Templates</div>
            <div className="adm-stat-value">{data.templates.length}</div>
            <div className="adm-stat-hint">{mappedTemplates} mapped</div>
          </div>
        </div>
        <div className="adm-stat-card">
          <span className="adm-stat-icon is-blue" aria-hidden="true">Net</span>
          <div>
            <div className="adm-stat-label">Networks</div>
            <div className="adm-stat-value">{data.networks.length}</div>
            <div className="adm-stat-hint">{activeNets} active</div>
          </div>
        </div>
        <div className="adm-stat-card">
          <span className="adm-stat-icon is-purple" aria-hidden="true">CI</span>
          <div>
            <div className="adm-stat-label">Snippets</div>
            <div className="adm-stat-value">{data.snippets.length}</div>
            <div className="adm-stat-hint">{data.snippetStorage || "local"}</div>
          </div>
        </div>
        <div className="adm-stat-card">
          <span className={`adm-stat-icon ${syncHealth.tone === "ok" ? "is-ok" : syncHealth.tone === "danger" ? "is-danger" : "is-amber"}`} aria-hidden="true">↻</span>
          <div>
            <div className="adm-stat-label">Sync</div>
            <div className="adm-stat-value adm-stat-sm">{syncHealth.label}</div>
            <div className="adm-stat-hint">{lastSyncedAt ? lastSyncedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "—"}</div>
          </div>
        </div>
      </div>

      <div className="adm-board-toolbar">
        <button className="btn btn-ghost btn-sm" onClick={load} disabled={loading}>
          {loading ? "Detecting…" : "↻ Re-detect from Proxmox"}
        </button>
        <span className={`map-sync-chip map-sync-${syncHealth.tone}`} title={error || syncLabel}>
          <span className="map-sync-dot" aria-hidden="true" />
          {syncHealth.label}
          {lastSyncedAt && !error ? <span className="map-sync-when">· {syncLabel}</span> : null}
        </span>
      </div>

      {error && <div className="login-error">{error}</div>}

      <div className="adm-table-wrap">
        <div className="adm-table-head">
          <h3 className="adm-table-title">Templates → OS</h3>
          <span className="muted adm-table-count">{data.templates.length} templates</span>
        </div>
        <div className="adm-scroll">
          <table className="table map-table table-dense">
            <thead>
              <tr>
                <th>Template</th><th>OS name</th><th>Cloud-init</th><th>User</th>
                <th>Password</th><th>Connectivity</th><th>Port</th><th>Pkg mgr</th><th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {data.templates.map((row) => (
                <TemplateRow key={row.vmid} row={row} snippets={data.snippets} onSaved={load} onError={setError} />
              ))}
              {data.templates.length === 0 && (
                <tr><td colSpan={9} className="empty">No Proxmox templates detected.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="adm-table-wrap">
        <div className="adm-table-head">
          <h3 className="adm-table-title">Networks</h3>
          <span className="muted adm-table-count">VLAN / bridge</span>
        </div>
        <div className="adm-scroll">
          <table className="table map-table table-dense">
            <thead>
              <tr>
                <th>Interface</th><th>Detected</th><th>Type</th><th>Label</th>
                <th>State</th><th>Address</th><th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {data.networks.map((row) => (
                <NetworkRow key={row.iface} row={row} onSaved={load} onError={setError} />
              ))}
              {data.networks.length === 0 && (
                <tr><td colSpan={7} className="empty">No bridges or VLANs detected.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
