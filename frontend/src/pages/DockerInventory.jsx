import { useCallback, useEffect, useState, Fragment } from "react";
import { Link } from "react-router-dom";
import {
  listDockerProjects,
  downDockerProject,
  restartDockerProject,
  startDockerContainer,
  stopDockerContainer,
  restartDockerContainer,
  deleteDockerContainer,
  inspectDockerContainer,
  updateDockerContainerEnv,
  getDockerContainerHealth,
} from "../api/client.js";
import { useDialog } from "../components/DialogProvider.jsx";
import EmptyState from "../components/EmptyState.jsx";
import ProviderStatusBanner from "../components/ProviderStatusBanner.jsx";
import PowerMenu from "../components/PowerMenu.jsx";
import RowMenu from "../components/RowMenu.jsx";
import WsTerminalModal from "../components/WsTerminalModal.jsx";
import LiveLogsModal from "../components/LiveLogsModal.jsx";
import EnvEditorModal from "../components/EnvEditorModal.jsx";
import useProviderHealth from "../hooks/useProviderHealth.js";
import { useAuth } from "../context/AuthContext.jsx";
import {
  IconActions,
  IconArchive,
  IconCopy,
  IconEnv,
  IconExternal,
  IconGlobe,
  IconHeart,
  IconLogs,
  IconPlay,
  IconPower,
  IconReboot,
  IconTerminal,
  IconTrash,
} from "../components/icons.jsx";

function phaseClass(state) {
  const s = (state || "").toLowerCase();
  if (s === "running") return "badge-running";
  if (s === "exited" || s === "dead") return "badge-stopped";
  return "badge-neutral";
}

function healthClass(status) {
  const s = (status || "").toLowerCase();
  if (s === "healthy") return "badge-running";
  if (s === "unhealthy") return "badge-stopped";
  return "badge-neutral";
}

/** Same chrome as VM TagsMenu — always visible; opens URL(s) or explains none. */
function OpenWebButton({ urls, onOpen }) {
  if (urls?.length === 1) {
    return (
      <a
        className="icon-btn power-trigger"
        href={urls[0].url}
        target="_blank"
        rel="noreferrer"
        title={`Open ${urls[0].label}`}
      >
        <IconGlobe />
      </a>
    );
  }
  if (urls?.length > 1) {
    return (
      <RowMenu
        icon={<IconGlobe />}
        title="Open in web"
        items={urls.map((u) => ({
          key: u.url,
          label: u.label,
          icon: <IconExternal size={15} />,
          onClick: () => window.open(u.url, "_blank", "noopener,noreferrer"),
        }))}
      />
    );
  }
  return (
    <button
      type="button"
      className="icon-btn power-trigger"
      title="Open in web"
      onClick={onOpen}
    >
      <IconGlobe />
    </button>
  );
}

export default function DockerInventory() {
  const { isAdmin } = useAuth();
  const { confirm, alert } = useDialog();
  const docker = useProviderHealth("docker");
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState(() => new Set());
  const [busyKey, setBusyKey] = useState("");
  const [healthMap, setHealthMap] = useState({});
  const [webUrlsMap, setWebUrlsMap] = useState({});
  const [termTarget, setTermTarget] = useState(null);
  const [logsTarget, setLogsTarget] = useState(null);
  const [envTarget, setEnvTarget] = useState(null);

  const load = async () => {
    setLoading(true);
    try {
      const data = await listDockerProjects();
      setRows(Array.isArray(data) ? data : []);
      setError("");
    } catch (e) {
      setError(e.response?.data?.error || e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const toggle = (key) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const down = async (hostId, project) => {
    if (!(await confirm({
      title: "Compose down",
      message: `Remove project "${project}" (containers + project networks)? Volumes are kept.`,
      confirmLabel: "Down",
      tone: "danger",
    }))) return;
    setBusyKey(`${hostId}:${project}:down`);
    try {
      await downDockerProject(hostId, project);
      await load();
    } catch (e) {
      await alert({ title: "Down failed", message: e.response?.data?.error || e.message, tone: "danger" });
    } finally {
      setBusyKey("");
    }
  };

  const restart = async (hostId, project) => {
    if (!(await confirm({
      title: "Restart project",
      message: `Restart all containers in Compose project "${project}"?`,
      confirmLabel: "Restart",
    }))) return;
    setBusyKey(`${hostId}:${project}:restart`);
    try {
      await restartDockerProject(hostId, project);
      await load();
    } catch (e) {
      await alert({ title: "Restart failed", message: e.response?.data?.error || e.message, tone: "danger" });
    } finally {
      setBusyKey("");
    }
  };

  const containerAct = async (hostId, containerId, action) => {
    setBusyKey(`${hostId}:${containerId}:${action}`);
    window.dispatchEvent(new CustomEvent("forge:docker-action", {
      detail: { key: `${hostId}:${containerId}`, action },
    }));
    try {
      if (action === "start") await startDockerContainer(hostId, containerId);
      else if (action === "stop") await stopDockerContainer(hostId, containerId);
      else if (action === "restart") await restartDockerContainer(hostId, containerId);
      else if (action === "delete") {
        if (!(await confirm({
          title: "Delete container",
          message: "Force-remove this container? This cannot be undone.",
          confirmLabel: "Delete",
          tone: "danger",
        }))) return;
        window.dispatchEvent(new CustomEvent("forge:docker-action", {
          detail: { key: `${hostId}:${containerId}`, action: "delete" },
        }));
        await deleteDockerContainer(hostId, containerId);
      }
      await load();
    } catch (e) {
      await alert({ title: "Action failed", message: e.response?.data?.error || e.message, tone: "danger" });
    } finally {
      setBusyKey("");
    }
  };

  const checkHealth = async (hostId, containerId) => {
    const key = `${hostId}:${containerId}:health`;
    setBusyKey(key);
    try {
      const info = await getDockerContainerHealth(hostId, containerId);
      setHealthMap((m) => ({ ...m, [`${hostId}:${containerId}`]: info }));
    } catch (e) {
      await alert({ title: "Health check failed", message: e.response?.data?.error || e.message, tone: "danger" });
    } finally {
      setBusyKey("");
    }
  };

  const refreshWebUrls = async (hostId, containerId) => {
    try {
      const info = await inspectDockerContainer(hostId, containerId);
      setWebUrlsMap((m) => ({ ...m, [`${hostId}:${containerId}`]: info.webUrls || [] }));
      return info.webUrls || [];
    } catch {
      return [];
    }
  };

  const openWeb = async (hostId, containerId) => {
    const cached = webUrlsMap[`${hostId}:${containerId}`];
    const urls = cached?.length ? cached : await refreshWebUrls(hostId, containerId);
    if (!urls.length) {
      await alert({ title: "No published ports", message: "This container has no host-published TCP ports to open." });
      return;
    }
    if (urls.length === 1) {
      window.open(urls[0].url, "_blank", "noopener,noreferrer");
      return;
    }
    // Multiple ports: open first; menu already handles multi via OpenWebMenu when cached.
    window.open(urls[0].url, "_blank", "noopener,noreferrer");
  };

  const copyId = async (id) => {
    try {
      await navigator.clipboard.writeText(id);
    } catch {
      await alert({ title: "Copy failed", message: "Could not copy container id." });
    }
  };

  const loadEnvFor = useCallback(async () => {
    if (!envTarget) return [];
    const info = await inspectDockerContainer(envTarget.hostId, envTarget.id);
    return info.env || [];
  }, [envTarget]);

  const saveEnvFor = useCallback(async (env) => {
    if (!envTarget) return {};
    return updateDockerContainerEnv(envTarget.hostId, envTarget.id, env);
  }, [envTarget]);

  const hasAnyHost = rows.length > 0;
  const hasAnyProject = rows.some((r) => (r.projects || []).length > 0);

  return (
    <div className="docker-inventory">
      <ProviderStatusBanner
        providerLabel="Docker"
        checking={docker.checking}
        blocked={docker.blocked}
        message={docker.message}
        error={docker.error}
        hosts={docker.hosts}
        onRetry={() => { docker.refresh(); load(); }}
      />

      <div className="row-between" style={{ marginBottom: 14 }}>
        <p className="muted" style={{ margin: 0, fontSize: 13.5 }}>
          Compose projects on Docker hosts you can access. Deploy new stacks under Provisioning.
        </p>
        <div style={{ display: "flex", gap: 8 }}>
          <button type="button" className="btn btn-ghost btn-sm" onClick={load} disabled={loading}>
            {loading ? "Refreshing…" : "↻ Refresh"}
          </button>
          <Link className="btn btn-primary btn-sm" to="/provision?tab=compose">Deploy</Link>
        </div>
      </div>

      {error && <div className="login-error" style={{ marginBottom: 12 }}>{error}</div>}

      {!loading && !hasAnyHost ? (
        <EmptyState
          tone="warn"
          icon="🐳"
          title="No Docker hosts"
          description={isAdmin
            ? "Register engines under Admin → Docker hosts. Leave Team tags empty so all users can deploy, or set tags that match group names."
            : "No Docker host is assigned to your teams. Ask an admin to open Admin → Docker hosts and clear Team tags (all users) or add your group."}
          actionLabel={isAdmin ? "Open Docker hosts" : "Open Support"}
          actionHref={isAdmin ? "/admin?tab=docker" : "/support"}
        />
      ) : !loading && !hasAnyProject ? (
        <EmptyState
          icon="📦"
          title="No Compose projects"
          description="Nothing running with Compose labels on your hosts yet."
          actionLabel="Deploy stack"
          actionHref="/provision?tab=compose"
        />
      ) : (
        <div className={`card ${docker.blocked ? "is-disabled" : ""}`} style={{ overflow: "auto" }}>
          <table className="table">
            <thead>
              <tr>
                <th>Host / project</th>
                <th>Containers</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <HostBlock
                  key={row.host.id}
                  row={row}
                  expanded={expanded}
                  onToggle={toggle}
                  onDown={down}
                  onRestart={restart}
                  onContainerAct={containerAct}
                  onHealth={checkHealth}
                  onTerm={(c) => setTermTarget(c)}
                  onLogs={(c) => setLogsTarget(c)}
                  onEnv={(c) => setEnvTarget(c)}
                  onOpenWeb={openWeb}
                  onCopyId={copyId}
                  onPrefetchWeb={refreshWebUrls}
                  healthMap={healthMap}
                  webUrlsMap={webUrlsMap}
                  busyKey={busyKey}
                  dockerBlocked={docker.blocked}
                />
              ))}
              {loading && <tr><td colSpan={4} className="empty">Loading…</td></tr>}
            </tbody>
          </table>
        </div>
      )}

      {termTarget && (
        <WsTerminalModal
          title={`Container shell · ${termTarget.name}`}
          subtitle="Docker exec"
          wsPath="/ws/docker-exec"
          params={{ hostId: termTarget.hostId, containerId: termTarget.id }}
          onClose={() => setTermTarget(null)}
        />
      )}
      {logsTarget && (
        <LiveLogsModal
          title={`Container logs · ${logsTarget.name}`}
          wsPath="/ws/docker-logs"
          params={{ hostId: logsTarget.hostId, containerId: logsTarget.id }}
          onClose={() => setLogsTarget(null)}
        />
      )}
      {envTarget && (
        <EnvEditorModal
          title={`Env · ${envTarget.name}`}
          subtitle="Compose tip: prefer editing the compose file for durable changes. This recreates the container."
          restartNote="Saving recreates the container with the new environment (equivalent to a restart)."
          loadEnv={loadEnvFor}
          saveEnv={saveEnvFor}
          onClose={() => setEnvTarget(null)}
          onSaved={() => { setTimeout(load, 800); }}
        />
      )}
    </div>
  );
}

function HostBlock({
  row, expanded, onToggle, onDown, onRestart, onContainerAct, onHealth,
  onTerm, onLogs, onEnv, onOpenWeb, onCopyId, onPrefetchWeb,
  healthMap, webUrlsMap, busyKey, dockerBlocked,
}) {
  const host = row.host;
  const projects = row.projects || [];
  return (
    <>
      <tr className="ki-ns-row">
        <td colSpan={4}>
          <strong>{host.name}</strong>
          <span className="muted mono" style={{ marginLeft: 10, fontSize: 12 }}>{host.endpoint}</span>
          {row.error && <span className="badge badge-stopped" style={{ marginLeft: 10 }}>{row.error}</span>}
        </td>
      </tr>
      {projects.map((p) => {
        const key = `${host.id}:${p.name}`;
        const open = expanded.has(key);
        const running = (p.containers || []).filter((c) => c.state === "running").length;
        const total = (p.containers || []).length;
        const projectBusy = busyKey.startsWith(`${key}:`);
        const projectPower = [
          {
            key: "restart",
            label: "Restart project",
            icon: <IconReboot size={15} className="icon-spin-hover" style={{ color: "var(--accent)" }} />,
            onClick: () => onRestart(host.id, p.name),
          },
        ];
        const projectActions = [
          {
            key: "down",
            label: "Compose down",
            icon: <IconTrash size={15} />,
            danger: true,
            onClick: () => onDown(host.id, p.name),
          },
        ];
        return (
          <Fragment key={key}>
            <tr>
              <td>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => onToggle(key)} aria-expanded={open}>
                  {open ? "▾" : "▸"} <span className="mono">{p.name}</span>
                </button>
              </td>
              <td>{total}</td>
              <td>{running}/{total} running</td>
              <td>
                <div className="actions-cell">
                  {projectBusy ? (
                    <span className="muted" style={{ fontSize: 12 }}><span className="spinner" style={{ width: 12, height: 12 }} /> …</span>
                  ) : (
                    <>
                      <PowerMenu items={dockerBlocked ? [] : projectPower} />
                      <RowMenu icon={<IconActions />} title="Project actions" items={dockerBlocked ? [] : projectActions} />
                    </>
                  )}
                </div>
              </td>
            </tr>
            {open && (p.containers || []).map((c) => {
              const healthKey = `${host.id}:${c.id}`;
              const healthInfo = healthMap[healthKey];
              const healthStatus = healthInfo?.health?.status;
              const isRunning = c.state === "running";
              const cBusy = busyKey.startsWith(`${healthKey}:`);
              const webUrls = webUrlsMap[healthKey] || [];

              const powerItems = [];
              if (isRunning) {
                powerItems.push({
                  key: "stop",
                  label: "Stop",
                  icon: <IconPower size={15} style={{ color: "var(--warn)" }} />,
                  onClick: () => onContainerAct(host.id, c.id, "stop"),
                });
                powerItems.push({
                  key: "restart",
                  label: "Restart",
                  icon: <IconReboot size={15} className="icon-spin-hover" style={{ color: "var(--accent)" }} />,
                  onClick: () => onContainerAct(host.id, c.id, "restart"),
                });
              } else {
                powerItems.push({
                  key: "start",
                  label: "Start",
                  icon: <IconPlay size={15} style={{ color: "var(--ok)" }} />,
                  onClick: () => onContainerAct(host.id, c.id, "start"),
                });
              }

              // Overflow only — frequent ops are icon buttons like VM inventory.
              const actionItems = [
                {
                  key: "env",
                  label: "View / edit Env vars",
                  icon: <IconEnv size={15} />,
                  onClick: () => onEnv({ hostId: host.id, id: c.id, name: c.name }),
                },
                {
                  key: "health",
                  label: "Check health",
                  icon: <IconHeart size={15} />,
                  onClick: () => onHealth(host.id, c.id),
                },
                {
                  key: "copy",
                  label: "Copy container ID",
                  icon: <IconCopy size={15} />,
                  onClick: () => onCopyId(c.id),
                },
                {
                  key: "inspect",
                  label: "Refresh published URLs",
                  icon: <IconArchive size={15} />,
                  onClick: () => onPrefetchWeb(host.id, c.id),
                },
                {
                  key: "delete",
                  label: "Delete",
                  icon: <IconTrash size={15} />,
                  danger: true,
                  onClick: () => onContainerAct(host.id, c.id, "delete"),
                },
              ];

              return (
                <tr key={c.id} className="ki-pod-row">
                  <td style={{ paddingLeft: 36 }}>
                    <span className="mono">{c.name}</span>
                    <div className="muted" style={{ fontSize: 12 }}>{c.image}</div>
                  </td>
                  <td>{(c.ports || []).join(", ") || "—"}</td>
                  <td>
                    <span className={`badge ${phaseClass(c.state)}`}>{c.state}</span>
                    {healthStatus && (
                      <span className={`badge ${healthClass(healthStatus)}`} style={{ marginLeft: 6 }} title="Docker healthcheck">
                        {healthStatus}
                      </span>
                    )}
                  </td>
                  <td>
                    <div className="actions-cell">
                      {cBusy ? (
                        <span className="muted" style={{ fontSize: 12 }}><span className="spinner" style={{ width: 12, height: 12 }} /> …</span>
                      ) : (
                        <>
                          <PowerMenu items={dockerBlocked ? [] : powerItems} />
                          <button
                            type="button"
                            className="icon-btn power-trigger"
                            title={isRunning ? "Container shell" : "Shell requires a running container"}
                            disabled={dockerBlocked || !isRunning}
                            onClick={() => onTerm({ hostId: host.id, id: c.id, name: c.name })}
                          >
                            <IconTerminal />
                          </button>
                          <button
                            type="button"
                            className="icon-btn power-trigger"
                            title="Container logs"
                            disabled={dockerBlocked}
                            onClick={() => onLogs({ hostId: host.id, id: c.id, name: c.name })}
                          >
                            <IconLogs />
                          </button>
                          <OpenWebButton
                            urls={webUrls}
                            onOpen={() => onOpenWeb(host.id, c.id)}
                          />
                          <RowMenu icon={<IconActions />} title="More actions" items={dockerBlocked ? [] : actionItems} />
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </Fragment>
        );
      })}
      {!projects.length && !row.error && (
        <tr><td colSpan={4} className="muted" style={{ paddingLeft: 24 }}>No Compose projects on this host</td></tr>
      )}
    </>
  );
}
