import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  getK8sContext, getK8sNamespaces, createK8sNamespace, deleteK8sNamespace,
  getK8sPods, getK8sDeployments, deleteK8sDeployment, deleteK8sPod,
  scaleK8sDeployment, restartK8sDeployment, execK8sPod,
  getK8sDeploymentEnv, updateK8sDeploymentEnv,
  getK8sServices, deleteK8sService,
  getK8sIngresses, deleteK8sIngress,
  getK8sPvcs, deleteK8sPvc,
} from "../api/client.js";
import K8sDeployPanel from "../components/K8sDeployPanel.jsx";
import { useDialog } from "../components/DialogProvider.jsx";
import { useToast } from "../components/ToastProvider.jsx";
import EmptyState from "../components/EmptyState.jsx";
import ProviderStatusBanner from "../components/ProviderStatusBanner.jsx";
import Toggle from "../components/Toggle.jsx";
import PowerMenu from "../components/PowerMenu.jsx";
import RowMenu from "../components/RowMenu.jsx";
import AnchoredPopover from "../components/AnchoredPopover.jsx";
import WsTerminalModal from "../components/WsTerminalModal.jsx";
import LiveLogsModal from "../components/LiveLogsModal.jsx";
import EnvEditorModal from "../components/EnvEditorModal.jsx";
import useProviderHealth from "../hooks/useProviderHealth.js";
import {
  IconActions,
  IconBolt,
  IconCopy,
  IconEdit,
  IconEnv,
  IconExternal,
  IconLogs,
  IconPlay,
  IconPower,
  IconReboot,
  IconTerminal,
  IconTrash,
} from "../components/icons.jsx";

function phaseClass(phase) {
  const p = (phase || "").toLowerCase();
  if (p === "running" || p === "active" || p === "succeeded") return "badge-running";
  if (p === "failed" || p === "unknown") return "badge-stopped";
  return "badge-neutral";
}

/** Build a browser URL for an Ingress host+path (http for private lab hosts). */
function ingressHref(host, path = "/") {
  const h = String(host || "").trim();
  if (!h) return "";
  if (/^https?:\/\//i.test(h)) {
    try {
      const u = new URL(h);
      if (path && path !== "/") u.pathname = path;
      return u.toString();
    } catch {
      return h;
    }
  }
  const p = path && path !== "/" ? path : "";
  return `http://${h}${p}`;
}

function IngressUrlCell({ rules, onCopy }) {
  const entries = (rules || []).flatMap((r) =>
    (r.paths || []).map((p) => ({
      host: r.host,
      path: p.path || "/",
      display: `${r.host}${p.path || "/"}`,
      href: ingressHref(r.host, p.path || "/"),
    })),
  ).filter((e) => e.host);

  if (!entries.length) return <span className="muted">—</span>;

  return (
    <div className="ki-url-list">
      {entries.map((e) => (
        <div key={e.display} className="ki-url-row">
          <a
            className="ki-url-link mono"
            href={e.href}
            target="_blank"
            rel="noopener noreferrer"
            title={`Open ${e.href}`}
          >
            {e.display}
          </a>
          <button
            type="button"
            className="icon-btn ki-url-btn"
            title="Copy URL"
            onClick={() => onCopy?.(e.href)}
          >
            <IconCopy size={14} />
          </button>
          <a
            className="icon-btn ki-url-btn"
            href={e.href}
            target="_blank"
            rel="noopener noreferrer"
            title="Open in new tab"
          >
            <IconExternal size={14} />
          </a>
        </div>
      ))}
    </div>
  );
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

function NamespaceActions({ ns, onDeploy, onDelete, canProvision, provisionBlocked, showResourcesLink }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [force, setForce] = useState(false);
  const ref = useRef(null);
  const caretRef = useRef(null);

  return (
    <div className="ch-actions" ref={ref}>
      {canProvision && (
        <button
          className="ch-icon-btn"
          title={provisionBlocked ? "Kubernetes is unreachable" : "Deploy workload"}
          onClick={() => onDeploy(ns)}
          disabled={provisionBlocked}
        >
          <Icon name="box" /><span>Deploy</span>
        </button>
      )}
      {showResourcesLink && (
        <a
          className="ch-icon-btn"
          href={`/resources?tab=kubernetes&ns=${encodeURIComponent(ns.name)}`}
          title="Open workloads in Resources"
        >
          <IconExternal size={15} /><span>Resources</span>
        </a>
      )}

      <div className="ch-split">
        <button
          className={`ch-icon-btn danger ${force ? "force" : ""}`}
          title={force ? "Force terminate namespace" : "Terminate namespace"}
          aria-label={force ? "Force terminate namespace" : "Terminate namespace"}
          onClick={() => onDelete(ns.name, force)}
        >
          <Icon name="trash" /><span>{force ? "Force terminate" : "Terminate"}</span>
        </button>
        <button
          ref={caretRef}
          className={`ch-caret-btn ${menuOpen ? "open" : ""}`}
          aria-label="More terminate options"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((v) => !v)}
        >
          <Icon name="caret" />
        </button>

        <AnchoredPopover
          open={menuOpen}
          onClose={() => setMenuOpen(false)}
          anchorRef={caretRef}
          className="ch-menu"
          estimatedHeight={72}
          estimatedWidth={250}
        >
          <div className="ch-menu-toggle">
            <span>
              <span className="ch-menu-toggle-title">Force terminate</span>
              <span className="ch-menu-toggle-sub">Clears finalizers to remove a stuck namespace</span>
            </span>
            <Toggle
              variant="danger"
              size="sm"
              checked={force}
              onChange={setForce}
              title="Force terminate"
            />
          </div>
        </AnchoredPopover>
      </div>
    </div>
  );
}

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
              <label>Team {context.teams?.length === 0 && <span className="muted">— you&apos;re not in any group</span>}</label>
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

function groupPods(deployments, pods) {
  const depNames = new Set(deployments.map((d) => d.name));
  const byDep = new Map(deployments.map((d) => [d.name, []]));
  const other = [];
  for (const p of pods) {
    const key = p.deployment && depNames.has(p.deployment) ? p.deployment : null;
    if (key) byDep.get(key).push(p);
    else other.push(p);
  }
  return { byDep, other };
}

function TextOutputModal({ title, text, loading, error, onClose }) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card ch-modal deploy-log-modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 900 }}>
        <div className="modal-header">
          <h3>{title}</h3>
          <button className="ds-close" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="modal-body">
          {error && <div className="login-error" style={{ marginBottom: 12 }}>{error}</div>}
          {loading ? (
            <p className="muted">Loading…</p>
          ) : (
            <pre className="mono" style={{ margin: 0, maxHeight: "60vh", overflow: "auto", whiteSpace: "pre-wrap", fontSize: 12.5 }}>
              {text || "(empty)"}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}

function PodRows({ pods, nsName, indent = 2, onLogs, onTerm, onExecOnce, onCopy, onDeletePod, busyKey }) {
  if (!pods.length) {
    return (
      <tr className={`ki-child ki-indent-${indent}`}>
        <td colSpan={7} className="muted" style={{ fontSize: 12.5 }}>No pods</td>
      </tr>
    );
  }
  return pods.map((p) => {
    const running = (p.phase || "").toLowerCase() === "running";
    const key = `${nsName}/${p.name}`;
    const busy = busyKey === key;
    const actionItems = [
      running && {
        key: "exec",
        label: "Run command…",
        icon: <IconBolt size={15} />,
        onClick: () => onExecOnce(nsName, p.name),
      },
      {
        key: "copy",
        label: "Copy pod name",
        icon: <IconCopy size={15} />,
        onClick: () => onCopy(p.name),
      },
      onDeletePod && {
        key: "terminate",
        label: "Terminate",
        icon: <IconTrash size={15} />,
        danger: true,
        onClick: () => onDeletePod(nsName, p.name, false),
      },
      onDeletePod && {
        key: "force-terminate",
        label: "Force terminate",
        icon: <IconTrash size={15} />,
        danger: true,
        onClick: () => onDeletePod(nsName, p.name, true),
      },
    ].filter(Boolean);

    return (
      <tr key={p.name} className={`ki-child ki-indent-${indent}`}>
        <td colSpan={2}>
          <span className="ki-pod-label">Pod</span>
          <span className="mono">{p.name}</span>
          {p.reason ? (
            <div className="ki-pod-reason" title={p.message || p.reason}>
              <span className="ki-pod-reason-tag">{p.reason}</span>
              {p.message ? <span className="muted">{p.message}</span> : null}
            </div>
          ) : null}
        </td>
        <td><span className={`badge ${phaseClass(p.phase)}`}>{p.phase}</span></td>
        <td className="mono">{p.ready}</td>
        <td className="mono">{p.restarts}</td>
        <td className="mono">{p.node || "—"}</td>
        <td>
          <div className="actions-cell">
            {busy ? (
              <span className="muted" style={{ fontSize: 12 }}><span className="spinner" style={{ width: 12, height: 12 }} /> …</span>
            ) : (
              <>
                <button
                  type="button"
                  className="icon-btn power-trigger"
                  title={running ? "Pod shell" : "Shell requires a running pod"}
                  disabled={!running}
                  onClick={() => onTerm(nsName, p.name)}
                >
                  <IconTerminal />
                </button>
                <button
                  type="button"
                  className="icon-btn power-trigger"
                  title="Pod logs"
                  onClick={() => onLogs(nsName, p.name)}
                >
                  <IconLogs />
                </button>
                <RowMenu icon={<IconActions />} title="More actions" items={actionItems} />
              </>
            )}
          </div>
        </td>
      </tr>
    );
  });
}

function NamespaceTreeRow({
  ns, expanded, onToggle, cache, loadingChildren, openDeps, onToggleDep, onDeploy, onDelete,
  onDeleteDep, onScaleDep, onRestartDep, onEnvDep, onEditDep, onPodLogs, onPodTerm, onPodExec, onPodDelete, onCopy,
  onDeleteSvc, onDeleteIng, onDeletePvc,
  depBusy, podBusy, canProvision, provisionBlocked,
}) {
  const canManage = !canProvision;
  const children = cache[ns.name];
  const { byDep, other } = useMemo(
    () => (children ? groupPods(children.deployments, children.pods) : { byDep: new Map(), other: [] }),
    [children]
  );
  const services = children?.services || [];
  const ingresses = children?.ingresses || [];
  const pvcs = children?.pvcs || [];
  const emptyWorkloads = children && !loadingChildren
    && (children.deployments || []).length === 0 && other.length === 0
    && services.length === 0 && ingresses.length === 0 && pvcs.length === 0;

  /* Provisioning: flat namespace rows only — workloads live under Resources. */
  if (canProvision) {
    return (
      <tr className="ki-ns-row">
        <td><strong>{ns.name}</strong></td>
        <td>{ns.team || <span className="muted">—</span>}</td>
        <td>{ns.env || <span className="muted">—</span>}</td>
        <td>{ns.project || <span className="muted">—</span>}</td>
        <td className="mono" style={{ fontSize: 12 }}>{ns.owner}</td>
        <td><span className={`badge ${phaseClass(ns.status)}`}>{ns.status}</span></td>
        <td>
          <NamespaceActions
            ns={ns}
            onDeploy={onDeploy}
            onDelete={onDelete}
            canProvision
            provisionBlocked={provisionBlocked}
            showResourcesLink
          />
        </td>
      </tr>
    );
  }

  return (
    <>
      <tr className={`ki-ns-row ${expanded ? "open" : ""}`}>
        <td>
          <button type="button" className="ki-expand" onClick={() => onToggle(ns)} aria-expanded={expanded}>
            <span className={`ki-chevron ${expanded ? "open" : ""}`}>▸</span>
            <strong>{ns.name}</strong>
          </button>
        </td>
        <td>{ns.team || <span className="muted">—</span>}</td>
        <td>{ns.env || <span className="muted">—</span>}</td>
        <td>{ns.project || <span className="muted">—</span>}</td>
        <td className="mono" style={{ fontSize: 12 }}>{ns.owner}</td>
        <td><span className={`badge ${phaseClass(ns.status)}`}>{ns.status}</span></td>
        <td>
          <NamespaceActions ns={ns} onDeploy={onDeploy} onDelete={onDelete} canProvision={false} provisionBlocked={false} />
        </td>
      </tr>

      {expanded && loadingChildren && (
        <tr className="ki-child ki-indent-1">
          <td colSpan={7} className="muted">Loading workloads…</td>
        </tr>
      )}

      {expanded && emptyWorkloads && (
        <tr className="ki-child ki-indent-1">
          <td colSpan={7} className="muted">
            No workloads yet.{" "}
            <a className="btn btn-ghost btn-sm" href="/provision?tab=containers">Provision →</a>
          </td>
        </tr>
      )}

      {expanded && children && !loadingChildren && (children.deployments || []).map((d) => {
        const depOpen = !!openDeps[`${ns.name}/${d.name}`];
        const depPods = byDep.get(d.name) || [];
        return (
          <FragmentDep
            key={d.name}
            ns={ns}
            d={d}
            depOpen={depOpen}
            depPods={depPods}
            onToggleDep={onToggleDep}
            onDeleteDep={onDeleteDep}
            onScaleDep={onScaleDep}
            onRestartDep={onRestartDep}
            onEnvDep={onEnvDep}
            onEditDep={onEditDep}
            onPodLogs={onPodLogs}
            onPodTerm={onPodTerm}
            onPodExec={onPodExec}
            onPodDelete={onPodDelete}
            onCopy={onCopy}
            depBusy={depBusy}
            podBusy={podBusy}
          />
        );
      })}

      {expanded && children && !loadingChildren && other.length > 0 && (
        <>
          <tr className="ki-child ki-indent-1 ki-group">
            <td colSpan={7}><strong>Other pods</strong></td>
          </tr>
          <PodRows
            pods={other}
            nsName={ns.name}
            indent={2}
            onLogs={onPodLogs}
            onTerm={onPodTerm}
            onExecOnce={onPodExec}
            onCopy={onCopy}
            onDeletePod={onPodDelete}
            busyKey={podBusy}
          />
        </>
      )}

      {expanded && children && !loadingChildren && services.length > 0 && (
        <>
          <tr className="ki-child ki-indent-1 ki-group">
            <td colSpan={7}><strong>Services</strong></td>
          </tr>
          {services.map((s) => (
            <tr key={`svc-${s.name}`} className="ki-child ki-indent-2">
              <td colSpan={2}>
                <span className="ki-dep-label">Service</span>{" "}
                <strong className="mono">{s.name}</strong>
              </td>
              <td colSpan={2} className="mono" style={{ fontSize: 12 }}>
                {s.type} · {s.clusterIP || "—"}
              </td>
              <td colSpan={2} className="mono" style={{ fontSize: 12 }}>
                {(s.ports || []).map((p) => `${p.port}${p.nodePort ? `→NP${p.nodePort}` : ""}`).join(", ") || "—"}
              </td>
              <td>
                {canManage && (
                  <button type="button" className="btn btn-ghost btn-sm" title="Delete service" onClick={() => onDeleteSvc?.(ns.name, s.name)}>
                    <IconTrash />
                  </button>
                )}
              </td>
            </tr>
          ))}
        </>
      )}

      {expanded && children && !loadingChildren && ingresses.length > 0 && (
        <>
          <tr className="ki-child ki-indent-1 ki-group">
            <td colSpan={7}><strong>Routes / Ingress</strong></td>
          </tr>
          {ingresses.map((ing) => (
            <tr key={`ing-${ing.name}`} className="ki-child ki-indent-2">
              <td colSpan={2}>
                <span className="ki-dep-label">Ingress</span>{" "}
                <strong className="mono">{ing.name}</strong>
              </td>
              <td colSpan={3}>
                <IngressUrlCell rules={ing.rules} onCopy={onCopy} />
              </td>
              <td className="muted" style={{ fontSize: 12 }}>{ing.className || "default"}</td>
              <td>
                {canManage && (
                  <button type="button" className="btn btn-ghost btn-sm" title="Delete ingress" onClick={() => onDeleteIng?.(ns.name, ing.name)}>
                    <IconTrash />
                  </button>
                )}
              </td>
            </tr>
          ))}
        </>
      )}

      {expanded && children && !loadingChildren && pvcs.length > 0 && (
        <>
          <tr className="ki-child ki-indent-1 ki-group">
            <td colSpan={7}><strong>Volumes (PVC)</strong></td>
          </tr>
          {pvcs.map((p) => (
            <tr key={`pvc-${p.name}`} className="ki-child ki-indent-2">
              <td colSpan={2}>
                <span className="ki-dep-label">PVC</span>{" "}
                <strong className="mono">{p.name}</strong>
              </td>
              <td colSpan={2}>{p.capacity || "—"}</td>
              <td><span className={`badge ${phaseClass(p.status)}`}>{p.status}</span></td>
              <td className="muted" style={{ fontSize: 12 }}>{p.storageClass || "default"}</td>
              <td>
                {canManage && (
                  <button type="button" className="btn btn-ghost btn-sm" title="Delete PVC" onClick={() => onDeletePvc?.(ns.name, p.name)}>
                    <IconTrash />
                  </button>
                )}
              </td>
            </tr>
          ))}
        </>
      )}
    </>
  );
}

function FragmentDep({
  ns, d, depOpen, depPods, onToggleDep, onDeleteDep, onScaleDep, onRestartDep, onEnvDep, onEditDep,
  onPodLogs, onPodTerm, onPodExec, onPodDelete, onCopy, depBusy, podBusy,
}) {
  const depKey = `${ns.name}/${d.name}`;
  const replicas = Number(d.replicas) || 0;
  const busy = depBusy === depKey;

  const powerItems = [
    {
      key: "restart",
      label: "Restart (rollout)",
      icon: <IconReboot size={15} className="icon-spin-hover" style={{ color: "var(--accent)" }} />,
      onClick: () => onRestartDep(ns.name, d.name),
    },
    replicas > 0
      ? {
        key: "stop",
        label: "Scale to 0",
        icon: <IconPower size={15} style={{ color: "var(--warn)" }} />,
        onClick: () => onScaleDep(ns.name, d.name, 0, { skipPrompt: true }),
      }
      : {
        key: "start",
        label: "Scale to 1",
        icon: <IconPlay size={15} style={{ color: "var(--ok)" }} />,
        onClick: () => onScaleDep(ns.name, d.name, 1, { skipPrompt: true }),
      },
  ];

  const actionItems = [
    {
      key: "edit",
      label: "Edit deployment…",
      icon: <IconEdit size={15} />,
      onClick: () => onEditDep(ns.name, d.name),
    },
    {
      key: "scale",
      label: "Scale…",
      icon: <IconBolt size={15} />,
      onClick: () => onScaleDep(ns.name, d.name, d.replicas),
    },
    {
      key: "env",
      label: "View / edit Env vars",
      icon: <IconEnv size={15} />,
      onClick: () => onEnvDep(ns.name, d.name),
    },
    {
      key: "copy",
      label: "Copy deployment name",
      icon: <IconCopy size={15} />,
      onClick: () => onCopy(d.name),
    },
    {
      key: "terminate",
      label: "Terminate",
      icon: <IconTrash size={15} />,
      danger: true,
      onClick: () => onDeleteDep(ns.name, d.name, false),
    },
    {
      key: "force-terminate",
      label: "Force terminate",
      icon: <IconTrash size={15} />,
      danger: true,
      onClick: () => onDeleteDep(ns.name, d.name, true),
    },
  ];

  return (
    <>
      <tr className="ki-child ki-indent-1 ki-dep-row">
        <td colSpan={2}>
          <button
            type="button"
            className="ki-expand"
            onClick={() => onToggleDep(ns.name, d.name)}
            aria-expanded={depOpen}
          >
            <span className={`ki-chevron ${depOpen ? "open" : ""}`}>▸</span>
            <span className="ki-dep-label">Deployment</span>
            <strong>{d.name}</strong>
          </button>
        </td>
        <td className="mono">{d.ready}/{d.replicas}</td>
        <td className="mono" colSpan={2}>{(d.images || []).join(", ") || "—"}</td>
        <td className="muted" style={{ fontSize: 12 }}>{depPods.length} pod{depPods.length === 1 ? "" : "s"}</td>
        <td>
          <div className="actions-cell">
            {busy ? (
              <span className="muted" style={{ fontSize: 12 }}><span className="spinner" style={{ width: 12, height: 12 }} /> …</span>
            ) : (
              <>
                <button
                  type="button"
                  className="icon-btn power-trigger"
                  title="Edit deployment"
                  onClick={() => onEditDep(ns.name, d.name)}
                >
                  <IconEdit />
                </button>
                <PowerMenu items={powerItems} />
                <RowMenu icon={<IconActions />} title="Deployment actions" items={actionItems} />
              </>
            )}
          </div>
        </td>
      </tr>
      {depOpen && (
        <PodRows
          pods={depPods}
          nsName={ns.name}
          indent={2}
          onLogs={onPodLogs}
          onTerm={onPodTerm}
          onExecOnce={onPodExec}
          onCopy={onCopy}
          onDeletePod={onPodDelete}
          busyKey={podBusy}
        />
      )}
    </>
  );
}

/**
 * Kubernetes namespaces / deployments / pods.
 * @param {"inventory"|"provision"} mode
 *   inventory — Resources: view & manage only; create lives under Provisioning
 *   provision — Provisioning: create namespace + deploy workloads
 */
export default function KubernetesInventory({ initialNs = null, mode = "inventory", embedded = false }) {
  const canProvision = mode === "provision";
  const { confirm, alert } = useDialog();
  const { info: toastInfo, error: toastError } = useToast();
  const k3s = useProviderHealth("k3s");
  const [context, setContext] = useState({ teams: [], envs: [], isAdmin: false });
  const [namespaces, setNamespaces] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [deployNs, setDeployNs] = useState(null);
  const [expanded, setExpanded] = useState(() => new Set(initialNs ? [initialNs] : []));
  const [openDeps, setOpenDeps] = useState({});
  const [cache, setCache] = useState({});
  const [loadingNs, setLoadingNs] = useState({});
  const [depBusy, setDepBusy] = useState("");
  const [podBusy, setPodBusy] = useState("");
  const [execModal, setExecModal] = useState(null);
  const [termTarget, setTermTarget] = useState(null);
  const [logsTarget, setLogsTarget] = useState(null);
  const [envTarget, setEnvTarget] = useState(null);
  const [editTarget, setEditTarget] = useState(null);

  const provisionBlocked = canProvision && k3s.blocked;

  useEffect(() => {
    if (provisionBlocked) {
      setShowCreate(false);
      setDeployNs(null);
    }
  }, [provisionBlocked]);

  const loadNamespaces = () => {
    setLoading(true);
    getK8sNamespaces()
      .then((data) => { setNamespaces(Array.isArray(data) ? data : []); setError(""); })
      .catch((e) => setError(e.response?.data?.error || e.message))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    getK8sContext().then(setContext).catch(() => {});
    loadNamespaces();
  }, []);

  useEffect(() => {
    if (initialNs) {
      setExpanded((prev) => new Set([...prev, initialNs]));
    }
  }, [initialNs]);

  const loadChildren = (nsName) => {
    setLoadingNs((m) => ({ ...m, [nsName]: true }));
    Promise.all([
      getK8sDeployments(nsName),
      getK8sPods(nsName),
      getK8sServices(nsName).catch(() => []),
      getK8sIngresses(nsName).catch(() => []),
      getK8sPvcs(nsName).catch(() => []),
    ])
      .then(([deployments, pods, services, ingresses, pvcs]) => {
        setCache((c) => ({
          ...c,
          [nsName]: {
            deployments: Array.isArray(deployments) ? deployments : [],
            pods: Array.isArray(pods) ? pods : [],
            services: Array.isArray(services) ? services : [],
            ingresses: Array.isArray(ingresses) ? ingresses : [],
            pvcs: Array.isArray(pvcs) ? pvcs : [],
          },
        }));
        setOpenDeps((prev) => {
          const next = { ...prev };
          for (const d of deployments || []) {
            next[`${nsName}/${d.name}`] = true;
          }
          return next;
        });
      })
      .catch((e) => {
        alert({ title: "Couldn't load workloads", message: e.response?.data?.error || e.message, tone: "danger" });
        setCache((c) => ({
          ...c,
          [nsName]: { deployments: [], pods: [], services: [], ingresses: [], pvcs: [] },
        }));
      })
      .finally(() => setLoadingNs((m) => ({ ...m, [nsName]: false })));
  };

  useEffect(() => {
    if (canProvision) return;
    for (const name of expanded) {
      if (!cache[name] && !loadingNs[name]) loadChildren(name);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- expand-driven fetch
  }, [expanded, canProvision]);

  const toggleNs = (ns) => {
    if (canProvision) return;
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(ns.name)) next.delete(ns.name);
      else next.add(ns.name);
      return next;
    });
  };

  const toggleDep = (nsName, depName) => {
    const key = `${nsName}/${depName}`;
    setOpenDeps((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const openK8sJobMonitor = (result, title, detail) => {
    if (!result?.job?.id) return false;
    toastInfo(title, detail);
    window.dispatchEvent(new CustomEvent("forge:open-deployment-monitor", { detail: { jobId: result.job.id } }));
    window.dispatchEvent(new CustomEvent("forge:pause-resource-watch", { detail: { ms: 90_000 } }));
    return true;
  };

  const remove = async (name, force = false) => {
    const modeLabel = force ? "Force terminate" : "Terminate";
    const msg = force
      ? `Force terminate namespace "${name}"? This clears finalizers and removes it even if it's stuck — cleanup guarantees are dropped. Progress opens in the deployment monitor.`
      : `Terminate namespace "${name}"? This removes everything inside it. Progress opens in the deployment monitor.`;
    if (!(await confirm({ title: `${modeLabel} namespace`, message: msg, confirmLabel: modeLabel, tone: "danger" }))) return;
    try {
      const result = await deleteK8sNamespace(name, force);
      openK8sJobMonitor(result, `${modeLabel} started`, `Namespace "${name}" — watch the deployment monitor for status.`);
      setExpanded((prev) => { const n = new Set(prev); n.delete(name); return n; });
      loadNamespaces();
      setTimeout(loadNamespaces, 4000);
    } catch (e) {
      const msgErr = e.response?.data?.error || e.message;
      toastError("Couldn't terminate namespace", msgErr);
      alert({ title: "Couldn't terminate namespace", message: msgErr, tone: "danger" });
    }
  };

  const removeDeployment = async (nsName, depName, force = false) => {
    const modeLabel = force ? "Force terminate" : "Terminate";
    if (!(await confirm({
      title: `${modeLabel} deployment`,
      message: force
        ? `Force terminate "${depName}"? Grace period is skipped; stuck pods are removed immediately. Companion Service / Ingress / PVC are cleaned up. Progress opens in the deployment monitor.`
        : `Terminate deployment "${depName}", its pods/ReplicaSets, and companion Service / Ingress / PVC? Progress opens in the deployment monitor.`,
      confirmLabel: modeLabel,
      tone: "danger",
    }))) return;
    setDepBusy(`${nsName}/${depName}`);
    try {
      const result = await deleteK8sDeployment(nsName, depName, { force: !!force });
      openK8sJobMonitor(result, `${modeLabel} started`, `Deployment "${depName}" — watch the deployment monitor for status.`);
      loadChildren(nsName);
      setTimeout(() => loadChildren(nsName), 4000);
    } catch (e) {
      const msgErr = e.response?.data?.error || e.message;
      toastError("Couldn't terminate workload", msgErr);
      alert({ title: "Couldn't terminate workload", message: msgErr, tone: "danger" });
    } finally {
      setDepBusy("");
    }
  };

  const removePod = async (nsName, podName, force = false) => {
    const modeLabel = force ? "Force terminate" : "Terminate";
    if (!(await confirm({
      title: `${modeLabel} pod`,
      message: force
        ? `Force terminate pod "${podName}"? Use this for pods stuck in Pending/Terminating. Progress opens in the deployment monitor.`
        : `Terminate pod "${podName}" with a normal grace period? Progress opens in the deployment monitor.`,
      confirmLabel: modeLabel,
      tone: "danger",
    }))) return;
    setPodBusy(`${nsName}/${podName}`);
    try {
      const result = await deleteK8sPod(nsName, podName, { force: !!force });
      openK8sJobMonitor(result, `${modeLabel} started`, `Pod "${podName}" — watch the deployment monitor for status.`);
      loadChildren(nsName);
      setTimeout(() => loadChildren(nsName), 4000);
    } catch (e) {
      const msgErr = e.response?.data?.error || e.message;
      toastError("Couldn't terminate pod", msgErr);
      await alert({ title: "Couldn't terminate pod", message: msgErr, tone: "danger" });
    } finally {
      setPodBusy("");
    }
  };

  const removeService = async (nsName, name) => {
    if (!(await confirm({ title: "Delete Service", message: `Delete service "${name}"?`, confirmLabel: "Delete", tone: "danger" }))) return;
    try {
      await deleteK8sService(nsName, name);
      loadChildren(nsName);
    } catch (e) {
      alert({ title: "Couldn't delete service", message: e.response?.data?.error || e.message, tone: "danger" });
    }
  };

  const removeIngress = async (nsName, name) => {
    if (!(await confirm({ title: "Delete Ingress", message: `Delete ingress/route "${name}"?`, confirmLabel: "Delete", tone: "danger" }))) return;
    try {
      await deleteK8sIngress(nsName, name);
      loadChildren(nsName);
    } catch (e) {
      alert({ title: "Couldn't delete ingress", message: e.response?.data?.error || e.message, tone: "danger" });
    }
  };

  const removePvc = async (nsName, name) => {
    if (!(await confirm({ title: "Delete PVC", message: `Delete volume claim "${name}"? Data may be lost.`, confirmLabel: "Delete", tone: "danger" }))) return;
    try {
      await deleteK8sPvc(nsName, name);
      loadChildren(nsName);
    } catch (e) {
      alert({ title: "Couldn't delete PVC", message: e.response?.data?.error || e.message, tone: "danger" });
    }
  };

  const scaleDeployment = async (nsName, depName, currentReplicas, { skipPrompt } = {}) => {
    let replicas = currentReplicas;
    if (!skipPrompt) {
      const raw = window.prompt(`Scale "${depName}" to how many replicas? (0–20)`, String(currentReplicas ?? 1));
      if (raw == null) return;
      replicas = Number(raw);
      if (!Number.isInteger(replicas) || replicas < 0 || replicas > 20) {
        await alert({ title: "Invalid replicas", message: "Enter an integer from 0 to 20.", tone: "danger" });
        return;
      }
    } else {
      replicas = Number(currentReplicas);
      if (!(await confirm({
        title: replicas === 0 ? "Scale to zero" : "Scale up",
        message: replicas === 0
          ? `Stop all pods for "${depName}" (scale to 0)?`
          : `Start "${depName}" with ${replicas} replica(s)?`,
        confirmLabel: replicas === 0 ? "Scale to 0" : `Scale to ${replicas}`,
      }))) return;
    }
    const key = `${nsName}/${depName}`;
    setDepBusy(key);
    try {
      await scaleK8sDeployment(nsName, depName, replicas);
      loadChildren(nsName);
    } catch (e) {
      await alert({ title: "Scale failed", message: e.response?.data?.error || e.message, tone: "danger" });
    } finally {
      setDepBusy("");
    }
  };

  const restartDeployment = async (nsName, depName) => {
    if (!(await confirm({
      title: "Restart deployment",
      message: `Rolling restart "${depName}"? Pods will be recreated one at a time.`,
      confirmLabel: "Restart",
    }))) return;
    const key = `${nsName}/${depName}`;
    setDepBusy(key);
    try {
      await restartK8sDeployment(nsName, depName);
      loadChildren(nsName);
    } catch (e) {
      await alert({ title: "Restart failed", message: e.response?.data?.error || e.message, tone: "danger" });
    } finally {
      setDepBusy("");
    }
  };

  const openPodLogs = (nsName, podName) => setLogsTarget({ ns: nsName, pod: podName });
  const openPodTerm = (nsName, podName) => setTermTarget({ ns: nsName, pod: podName });
  const openDepEnv = (nsName, depName) => setEnvTarget({ ns: nsName, dep: depName });
  const openDepEdit = (nsName, depName) => setEditTarget({ ns: nsName, dep: depName });

  const copyText = async (text) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      await alert({ title: "Copy failed", message: "Could not copy to clipboard." });
    }
  };

  const runPodExec = async (nsName, podName) => {
    const command = window.prompt(`Command to run in "${podName}":`, "id");
    if (command == null || !command.trim()) return;
    setPodBusy(`${nsName}/${podName}`);
    try {
      const result = await execK8sPod(nsName, podName, { command: command.trim() });
      const out = [result?.stdout, result?.stderr].filter(Boolean).join("\n");
      setExecModal({ ns: nsName, pod: podName, command: command.trim(), text: out || "(no output)" });
    } catch (e) {
      await alert({ title: "Exec failed", message: e.response?.data?.error || e.message, tone: "danger" });
    } finally {
      setPodBusy("");
    }
  };

  const loadEnvFor = useCallback(async () => {
    if (!envTarget) return [];
    const containers = await getK8sDeploymentEnv(envTarget.ns, envTarget.dep);
    const first = (containers || [])[0];
    if (!first) return [];
    return (first.env || [])
      .filter((e) => !e.valueFrom)
      .map((e) => `${e.name}=${e.value ?? ""}`);
  }, [envTarget]);

  const saveEnvFor = useCallback(async (env) => {
    if (!envTarget) return {};
    return updateK8sDeploymentEnv(envTarget.ns, envTarget.dep, { env });
  }, [envTarget]);

  const k3sNotConfigured = /K3s API (URL|token) is not configured/i.test(error || "")
    || (canProvision && k3s.blocked && !k3s.configured);
  const k3sUnreachable = canProvision && k3s.blocked && k3s.configured;

  return (
    <div className={`kubernetes-inventory ${embedded ? "ki-embedded" : ""}`}>
      {canProvision && (
        <ProviderStatusBanner
          providerLabel="Kubernetes"
          checking={k3s.checking}
          blocked={k3s.blocked}
          message={k3s.message}
          error={k3s.error}
          onRetry={() => { k3s.refresh(); loadNamespaces(); }}
        />
      )}

      <div className="row-between" style={{ marginBottom: 14 }}>
        <p className="muted" style={{ margin: 0, fontSize: 13.5 }}>
          {canProvision
            ? "Create namespaces and deploy stacks into them. Manage deployments, pods, and routes under Resources."
            : "Expand a namespace to manage deployments, pods, services, ingress, and volumes."}
        </p>
        <div style={{ display: "flex", gap: 8 }}>
          {!k3sNotConfigured && !k3sUnreachable && (
            <>
              <button type="button" className="btn btn-ghost btn-sm" onClick={loadNamespaces} disabled={loading}>
                {loading ? "Refreshing…" : "↻ Refresh"}
              </button>
              {canProvision ? (
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => setShowCreate(true)}
                  disabled={provisionBlocked}
                >
                  New namespace
                </button>
              ) : (
                <a className="btn btn-primary" href="/provision?tab=containers">Provision</a>
              )}
            </>
          )}
          {k3sUnreachable && (
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => { k3s.refresh(); loadNamespaces(); }} disabled={k3s.checking}>
              {k3s.checking ? "Checking…" : "↻ Retry"}
            </button>
          )}
        </div>
      </div>

      {error && !k3sNotConfigured && !k3sUnreachable && (
        <div className="login-error" style={{ marginBottom: 16 }}>{error}</div>
      )}

      {k3sNotConfigured ? (
        <EmptyState
          tone="warn"
          icon="⚠"
          title="Kubernetes is not configured"
          description="Set the K3s API URL and token so Forge can list namespaces and workloads."
          actionLabel="Open K3s settings"
          actionHref="/admin?tab=k3s"
          secondaryLabel={canProvision ? "Back to VMs" : "Back to Compute"}
          secondaryHref={canProvision ? "/provision" : "/resources?tab=compute"}
        />
      ) : k3sUnreachable && !loading && namespaces.length === 0 ? (
        <EmptyState
          tone="warn"
          icon="⚠"
          title={k3s.message || "Kubernetes is down or unreachable"}
          description="Create namespace and deploy actions are disabled until the cluster responds again."
          actionLabel="Retry connection"
          onAction={() => { k3s.refresh(); loadNamespaces(); }}
          secondaryLabel={canProvision ? "Back to VMs" : "Back to Compute"}
          secondaryHref={canProvision ? "/provision" : "/resources?tab=compute"}
        />
      ) : !loading && namespaces.length === 0 ? (
        <EmptyState
          icon="📦"
          title="No namespaces yet"
          description={canProvision
            ? "Create a namespace, then deploy a workload. Any signed-in user can create their own."
            : "Nothing to show yet. Provision a namespace first."}
          actionLabel={canProvision ? "New namespace" : "Go to Provisioning"}
          onAction={canProvision && !provisionBlocked ? () => setShowCreate(true) : undefined}
          actionHref={canProvision ? undefined : "/provision?tab=containers"}
        />
      ) : (
        <div className={`card ${provisionBlocked ? "is-disabled" : ""}`} style={{ overflow: "auto" }}>
          <table className="table ki-table">
            <thead>
              <tr>
                <th>{canProvision ? "Namespace" : "Namespace / workload"}</th>
                <th>Team</th>
                <th>Env</th>
                <th>Project</th>
                <th>Owner</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {namespaces.map((ns) => (
                <NamespaceTreeRow
                  key={ns.name}
                  ns={ns}
                  expanded={expanded.has(ns.name)}
                  onToggle={toggleNs}
                  cache={cache}
                  loadingChildren={!!loadingNs[ns.name]}
                  openDeps={openDeps}
                  onToggleDep={toggleDep}
                  onDeploy={setDeployNs}
                  onDelete={remove}
                  onDeleteDep={removeDeployment}
                  onScaleDep={scaleDeployment}
                  onRestartDep={restartDeployment}
                  onEnvDep={openDepEnv}
                  onEditDep={openDepEdit}
                  onPodLogs={openPodLogs}
                  onPodTerm={openPodTerm}
                  onPodExec={runPodExec}
                  onPodDelete={removePod}
                  onCopy={copyText}
                  onDeleteSvc={removeService}
                  onDeleteIng={removeIngress}
                  onDeletePvc={removePvc}
                  depBusy={depBusy}
                  podBusy={podBusy}
                  canProvision={canProvision}
                  provisionBlocked={provisionBlocked}
                />
              ))}
              {loading && <tr><td colSpan={7} className="empty">Loading…</td></tr>}
            </tbody>
          </table>
        </div>
      )}

      {canProvision && showCreate && !provisionBlocked && (
        <NewNamespaceModal
          context={context}
          onClose={() => setShowCreate(false)}
          onCreated={() => { setShowCreate(false); loadNamespaces(); }}
        />
      )}

      {canProvision && deployNs && !provisionBlocked && (
        <K8sDeployPanel
          namespace={deployNs.name}
          onClose={() => setDeployNs(null)}
          onDeployed={() => {
            const name = deployNs.name;
            setDeployNs(null);
            window.location.assign(`/resources?tab=kubernetes&ns=${encodeURIComponent(name)}`);
          }}
        />
      )}

      {editTarget && (
        <K8sDeployPanel
          namespace={editTarget.ns}
          editName={editTarget.dep}
          onClose={() => setEditTarget(null)}
          onDeployed={() => {
            loadChildren(editTarget.ns);
            setEditTarget(null);
          }}
        />
      )}

      {termTarget && (
        <WsTerminalModal
          title={`Pod shell · ${termTarget.pod}`}
          subtitle={`${termTarget.ns} · kubectl exec`}
          wsPath="/ws/k8s-exec"
          params={{ namespace: termTarget.ns, pod: termTarget.pod }}
          onClose={() => setTermTarget(null)}
        />
      )}
      {logsTarget && (
        <LiveLogsModal
          title={`Pod logs · ${logsTarget.pod}`}
          wsPath="/ws/k8s-logs"
          params={{ namespace: logsTarget.ns, pod: logsTarget.pod }}
          onClose={() => setLogsTarget(null)}
        />
      )}
      {envTarget && (
        <EnvEditorModal
          title={`Env · ${envTarget.dep}`}
          subtitle={`Namespace ${envTarget.ns} — plain KEY=value entries on the first container. Secret/configMap refs are preserved.`}
          restartNote="Saving updates the Deployment and triggers a rolling restart of pods."
          loadEnv={loadEnvFor}
          saveEnv={saveEnvFor}
          onClose={() => setEnvTarget(null)}
          onSaved={() => { if (envTarget) setTimeout(() => loadChildren(envTarget.ns), 800); }}
        />
      )}

      {execModal && (
        <TextOutputModal
          title={`Exec · ${execModal.pod}`}
          text={`$ ${execModal.command}\n\n${execModal.text}`}
          loading={false}
          error=""
          onClose={() => setExecModal(null)}
        />
      )}
    </div>
  );
}
