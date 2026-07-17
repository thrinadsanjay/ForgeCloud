import { useEffect, useRef, useState } from "react";
import {
  getK8sContext, getK8sNamespaces, createK8sNamespace, deleteK8sNamespace,
  getK8sPods, getK8sDeployments, createK8sDeployment, deleteK8sDeployment,
} from "../api/client.js";
import { useDialog } from "../components/DialogProvider.jsx";
import EmptyState from "../components/EmptyState.jsx";

function phaseClass(phase) {
  const p = (phase || "").toLowerCase();
  if (p === "running" || p === "active" || p === "succeeded") return "badge-running";
  if (p === "failed" || p === "unknown") return "badge-stopped";
  return "badge-neutral";
}

function Icon({ name }) {
  const paths = {
    box: <><path d="M21 8l-9-5-9 5v8l9 5 9-5V8z" /><path d="M3 8l9 5 9-5M12 13v8" /></>,
    trash: <path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13" />,
    caret: <path d="M6 9l6 6 6-6" />,
  };
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor"
      strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>
  );
}

// Row actions: a "Deploy containers" icon button, plus a split delete button
// whose caret opens a menu with a Force-terminate toggle.
function NamespaceActions({ ns, onOpen, onDelete }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [force, setForce] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!menuOpen) return undefined;
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setMenuOpen(false); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [menuOpen]);

  return (
    <div className="ch-actions" ref={ref}>
      <button className="ch-icon-btn" title="Deploy containers" onClick={() => onOpen(ns)}>
        <Icon name="box" /><span>Deploy</span>
      </button>

      <div className="ch-split">
        <button
          className={`ch-icon-btn danger ${force ? "force" : ""}`}
          title={force ? "Force terminate namespace" : "Delete namespace"}
          aria-label={force ? "Force terminate namespace" : "Delete namespace"}
          onClick={() => onDelete(ns.name, force)}
        >
          <Icon name="trash" />
        </button>
        <button
          className={`ch-caret-btn ${menuOpen ? "open" : ""}`}
          aria-label="More delete options"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((v) => !v)}
        >
          <Icon name="caret" />
        </button>

        {menuOpen && (
          <div className="ch-menu">
            <div className="ch-menu-toggle">
              <span>
                <span className="ch-menu-toggle-title">Force terminate</span>
                <span className="ch-menu-toggle-sub">Clears finalizers to remove a stuck namespace</span>
              </span>
              <button
                type="button"
                role="switch"
                aria-checked={force}
                className={`switch ${force ? "on" : ""}`}
                onClick={() => setForce((v) => !v)}
              >
                <span className="switch-knob" />
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ---- Create namespace modal ----
function NewNamespaceModal({ context, onClose, onCreated }) {
  const [form, setForm] = useState({ name: "", team: "", env: "", project: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const upd = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setError("");
    try {
      await createK8sNamespace(form);
      onCreated();
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card ch-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>New namespace</h3>
          <button className="ds-close" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="modal-body">
          {error && <div className="login-error" style={{ marginBottom: 12 }}>{error}</div>}
          <form className="ch-form" onSubmit={submit}>
            <div className="field">
              <label>Namespace name</label>
              <input className="ch-input" required placeholder="my-app" value={form.name} onChange={upd("name")} />
            </div>
            <div className="field">
              <label>Team {context.teams?.length === 0 && <span className="muted">— you're not in any group</span>}</label>
              <select className="ch-input" value={form.team} onChange={upd("team")}>
                <option value="">Just me (private)</option>
                {(context.teams || []).map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
              <p className="muted" style={{ margin: "6px 0 0", fontSize: 12 }}>
                Assigning a team lets everyone in that group see and manage this namespace.
              </p>
            </div>
            <div className="field">
              <label>Environment</label>
              <select className="ch-input" value={form.env} onChange={upd("env")}>
                <option value="">—</option>
                {(context.envs || []).map((e) => <option key={e} value={e}>{e}</option>)}
              </select>
            </div>
            <div className="field">
              <label>Project <span className="muted">(optional)</span></label>
              <input className="ch-input" placeholder="billing-portal" value={form.project} onChange={upd("project")} />
            </div>
            <div className="modal-actions">
              <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
              <button className="btn btn-primary" disabled={busy || !form.name.trim()}>{busy ? "Creating…" : "Create namespace"}</button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}

// ---- Deploy workload modal ----
function DeployModal({ namespace, onClose, onDeployed }) {
  const [form, setForm] = useState({ name: "", image: "", replicas: 1, port: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const upd = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setError("");
    try {
      await createK8sDeployment(namespace, {
        name: form.name,
        image: form.image,
        replicas: Number(form.replicas) || 1,
        port: form.port ? Number(form.port) : undefined,
      });
      onDeployed();
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card ch-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>Deploy pods to <span className="mono">{namespace}</span></h3>
          <button className="ds-close" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="modal-body">
          {error && <div className="login-error" style={{ marginBottom: 12 }}>{error}</div>}
          <form className="ch-form" onSubmit={submit}>
            <div className="field">
              <label>Workload name</label>
              <input className="ch-input" required placeholder="web" value={form.name} onChange={upd("name")} />
            </div>
            <div className="field">
              <label>Container image</label>
              <input className="ch-input" required placeholder="nginx:latest" value={form.image} onChange={upd("image")} />
            </div>
            <div className="provision-field-grid">
              <div className="field">
                <label>Replicas</label>
                <input className="ch-input" type="number" min="1" max="20" value={form.replicas} onChange={upd("replicas")} />
              </div>
              <div className="field">
                <label>Container port <span className="muted">(optional)</span></label>
                <input className="ch-input" type="number" min="1" max="65535" placeholder="80" value={form.port} onChange={upd("port")} />
              </div>
            </div>
            <div className="modal-actions">
              <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
              <button className="btn btn-primary" disabled={busy || !form.name.trim() || !form.image.trim()}>
                {busy ? "Deploying…" : "Deploy"}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}

// ---- Namespace detail (deployments + pods) ----
function NamespaceDetail({ ns, onBack }) {
  const { confirm, alert } = useDialog();
  const [deployments, setDeployments] = useState([]);
  const [pods, setPods] = useState([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [showDeploy, setShowDeploy] = useState(false);

  const load = () => {
    setLoading(true);
    Promise.all([getK8sDeployments(ns.name), getK8sPods(ns.name)])
      .then(([d, p]) => { setDeployments(d); setPods(p); setError(""); })
      .catch((e) => setError(e.response?.data?.error || e.message))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, [ns.name]);

  const removeDeployment = async (name) => {
    if (!(await confirm({ title: "Delete workload", message: `Delete workload "${name}" and its pods?`, confirmLabel: "Delete", tone: "danger" }))) return;
    try { await deleteK8sDeployment(ns.name, name); load(); }
    catch (e) { alert({ title: "Couldn't delete workload", message: e.response?.data?.error || e.message, tone: "danger" }); }
  };

  return (
    <div>
      <button className="btn btn-ghost btn-sm" onClick={onBack} style={{ marginBottom: 14 }}>← All namespaces</button>

      <div className="row-between" style={{ marginBottom: 16 }}>
        <div>
          <h2 style={{ margin: 0 }}>{ns.name}</h2>
          <div className="ch-ns-meta" style={{ marginTop: 6 }}>
            {ns.team && <span className="badge badge-neutral">team: {ns.team}</span>}
            {ns.env && <span className="badge badge-neutral">env: {ns.env}</span>}
            {ns.project && <span className="badge badge-neutral">project: {ns.project}</span>}
            <span className="muted" style={{ fontSize: 12 }}>owner: {ns.owner}</span>
          </div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button className="btn btn-ghost btn-sm" onClick={load} disabled={loading}>{loading ? "Refreshing…" : "↻ Refresh"}</button>
          <button className="btn btn-primary" onClick={() => setShowDeploy(true)}>Deploy pods</button>
        </div>
      </div>

      {error && <div className="login-error" style={{ marginBottom: 14 }}>{error}</div>}

      <div className="section-title" style={{ marginTop: 0 }}>Workloads</div>
      <div className="card" style={{ overflow: "auto", marginBottom: 26 }}>
        <table className="table">
          <thead>
            <tr><th>Name</th><th>Ready</th><th>Replicas</th><th>Image</th><th>Actions</th></tr>
          </thead>
          <tbody>
            {deployments.map((d) => (
              <tr key={d.name}>
                <td style={{ fontWeight: 600 }}>{d.name}</td>
                <td className="mono">{d.ready}/{d.replicas}</td>
                <td className="mono">{d.replicas}</td>
                <td className="mono">{d.images.join(", ") || "—"}</td>
                <td><button className="btn btn-danger btn-sm" onClick={() => removeDeployment(d.name)}>Delete</button></td>
              </tr>
            ))}
            {deployments.length === 0 && <tr><td colSpan={5} className="empty">No workloads yet. Deploy pods to get started.</td></tr>}
          </tbody>
        </table>
      </div>

      <div className="section-title">Pods</div>
      <div className="card" style={{ overflow: "auto" }}>
        <table className="table">
          <thead>
            <tr><th>Pod</th><th>Status</th><th>Ready</th><th>Restarts</th><th>Node</th><th>Image</th></tr>
          </thead>
          <tbody>
            {pods.map((p) => (
              <tr key={p.name}>
                <td className="mono">{p.name}</td>
                <td><span className={`badge ${phaseClass(p.phase)}`}>{p.phase}</span></td>
                <td className="mono">{p.ready}</td>
                <td className="mono">{p.restarts}</td>
                <td className="mono">{p.node || "—"}</td>
                <td className="mono">{p.images.join(", ")}</td>
              </tr>
            ))}
            {pods.length === 0 && <tr><td colSpan={6} className="empty">No pods running.</td></tr>}
          </tbody>
        </table>
      </div>

      {showDeploy && (
        <DeployModal namespace={ns.name} onClose={() => setShowDeploy(false)} onDeployed={() => { setShowDeploy(false); load(); }} />
      )}
    </div>
  );
}

export default function ContainerHosting({ embedded = false }) {
  const { confirm, alert } = useDialog();
  const [context, setContext] = useState({ teams: [], envs: [], isAdmin: false });
  const [namespaces, setNamespaces] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [selected, setSelected] = useState(null);

  const loadNamespaces = () => {
    setLoading(true);
    getK8sNamespaces()
      .then((data) => { setNamespaces(data); setError(""); })
      .catch((e) => setError(e.response?.data?.error || e.message))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    getK8sContext().then(setContext).catch(() => {});
    loadNamespaces();
  }, []);

  const remove = async (name, force = false) => {
    const msg = force
      ? `Force terminate namespace "${name}"? This clears finalizers and removes it even if it's stuck — cleanup guarantees are dropped.`
      : `Delete namespace "${name}"? This removes everything inside it.`;
    if (!(await confirm({ title: force ? "Force terminate namespace" : "Delete namespace", message: msg, confirmLabel: force ? "Force terminate" : "Delete", tone: "danger" }))) return;
    try { await deleteK8sNamespace(name, force); loadNamespaces(); }
    catch (e) { alert({ title: "Couldn't delete namespace", message: e.response?.data?.error || e.message, tone: "danger" }); }
  };

  const k3sNotConfigured = /K3s API (URL|token) is not configured/i.test(error || "");

  return (
    <div className={embedded ? "" : "page"}>
      <div className="page-head row-between">
        <div>
          <div className="eyebrow">Container hosting</div>
          <h1>Kubernetes namespaces</h1>
          <p>Create namespaces and deploy pods on the K3s cluster. You only see namespaces you own or that belong to your team.</p>
        </div>
        {!selected && !k3sNotConfigured && (
          <button className="btn btn-primary" onClick={() => setShowCreate(true)}>New namespace</button>
        )}
      </div>

      {error && !k3sNotConfigured && (
        <div className="login-error" style={{ marginBottom: 16 }}>{error}</div>
      )}

      {selected ? (
        <NamespaceDetail ns={selected} onBack={() => { setSelected(null); loadNamespaces(); }} />
      ) : k3sNotConfigured ? (
        <EmptyState
          tone="warn"
          icon="⚠"
          title="K3s is not configured"
          description="Set the Kubernetes API URL and token so Forge can manage namespaces and workloads."
          actionLabel="Open K3s settings"
          actionHref="/admin?tab=k3s"
          secondaryLabel="Back to VMs"
          secondaryHref="/provision"
        />
      ) : !loading && namespaces.length === 0 ? (
        <EmptyState
          icon="📦"
          title="No namespaces yet"
          description="Create a namespace to deploy pods and workloads on the cluster."
          actionLabel="New namespace"
          onAction={() => setShowCreate(true)}
        />
      ) : (
        <div className="card" style={{ overflow: "auto" }}>
          <table className="table">
            <thead>
              <tr><th>Namespace</th><th>Team</th><th>Env</th><th>Project</th><th>Owner</th><th>Status</th><th>Actions</th></tr>
            </thead>
            <tbody>
              {namespaces.map((ns) => (
                <tr key={ns.name}>
                  <td style={{ fontWeight: 600 }}>{ns.name}</td>
                  <td>{ns.team || <span className="muted">—</span>}</td>
                  <td>{ns.env || <span className="muted">—</span>}</td>
                  <td>{ns.project || <span className="muted">—</span>}</td>
                  <td className="mono" style={{ fontSize: 12 }}>{ns.owner}</td>
                  <td><span className={`badge ${phaseClass(ns.status)}`}>{ns.status}</span></td>
                  <td>
                    <NamespaceActions ns={ns} onOpen={setSelected} onDelete={remove} />
                  </td>
                </tr>
              ))}
              {loading && <tr><td colSpan={7} className="empty">Loading…</td></tr>}
            </tbody>
          </table>
        </div>
      )}

      {showCreate && (
        <NewNamespaceModal
          context={context}
          onClose={() => setShowCreate(false)}
          onCreated={() => { setShowCreate(false); loadNamespaces(); }}
        />
      )}
    </div>
  );
}
