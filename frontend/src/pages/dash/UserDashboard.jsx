import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  ResponsiveContainer, AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip,
} from "recharts";
import {
  getDashboard, getJobs, getProvisionRequests, getResources, getCostRates,
  listDockerProjects, getK8sNamespaces, getDockerStatus,
} from "../../api/client.js";
import { useAuth } from "../../context/AuthContext.jsx";
import { canReviewDeployments } from "../../lib/roles.js";
import {
  ACCENT, AnimatedNumber, DashSkeleton, KpiCard, StatusPill,
  firstName, jobLabel, relativeTime, requestLabel,
} from "./shared.jsx";

function summarizeDocker(rows, status = null) {
  let hosts = 0;
  let projects = 0;
  let containers = 0;
  let running = 0;
  let hostErrors = 0;
  const hostList = [];
  for (const row of rows || []) {
    hosts += 1;
    if (row.error) hostErrors += 1;
    hostList.push({
      id: row.host?.id,
      name: row.host?.name || row.host?.endpoint || "Host",
      endpoint: row.host?.endpoint || "",
      ok: !row.error,
      error: row.error || null,
      projects: (row.projects || []).length,
      containers: (row.projects || []).reduce((n, p) => n + (p.containers || []).length, 0),
    });
    for (const p of row.projects || []) {
      projects += 1;
      for (const c of p.containers || []) {
        containers += 1;
        if (String(c.state || "").toLowerCase() === "running") running += 1;
      }
    }
  }

  const probeHosts = Array.isArray(status?.hosts) ? status.hosts : null;
  if (probeHosts?.length) {
    for (const ph of probeHosts) {
      const existing = hostList.find((h) => h.id === ph.id);
      if (existing) {
        existing.ok = !!ph.ok;
        existing.error = ph.error || null;
        existing.version = ph.detail?.version || ph.detail?.apiVersion || null;
      } else {
        hostList.push({
          id: ph.id,
          name: ph.name || ph.endpoint || "Host",
          endpoint: ph.endpoint || "",
          ok: !!ph.ok,
          error: ph.error || null,
          version: ph.detail?.version || ph.detail?.apiVersion || null,
          projects: 0,
          containers: 0,
        });
        hosts += 1;
        if (!ph.ok) hostErrors += 1;
      }
    }
    hostErrors = hostList.filter((h) => !h.ok).length;
    hosts = hostList.length;
  }

  const configured = status ? status.configured !== false : hosts > 0;
  const ok = status ? !!status.ok : (hosts > 0 && hostErrors === 0);
  let tone = "off";
  if (!configured || hosts === 0) tone = "off";
  else if (ok && hostErrors === 0) tone = "ok";
  else if (ok && hostErrors > 0) tone = "warn";
  else tone = "danger";

  return {
    hosts,
    projects,
    containers,
    running,
    stopped: Math.max(0, containers - running),
    hostErrors,
    hostList,
    configured,
    ok,
    tone,
    unavailable: !configured || hosts === 0,
  };
}

function dockerPill(tone) {
  if (tone === "ok") return "healthy";
  if (tone === "warn") return "degraded";
  if (tone === "danger") return "unreachable";
  if (tone === "checking") return "checking";
  return "unconfigured";
}

function openSupportChat() {
  window.dispatchEvent(new CustomEvent("forge:open-chat", { detail: { prompt: "I need help with my resources" } }));
}

export default function UserDashboard() {
  const { user } = useAuth();
  const reviewer = canReviewDeployments(user?.role);
  const [data, setData] = useState(null);
  const [jobs, setJobs] = useState([]);
  const [requests, setRequests] = useState([]);
  const [resources, setResources] = useState([]);
  const [docker, setDocker] = useState(null);
  const [k8sNs, setK8sNs] = useState(null);
  const [rates, setRates] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    let timer;
    const load = async (scheduleNext = true) => {
      try {
        const [dash, j, r, res, dockerRows, dockerStatus, namespaces] = await Promise.all([
          getDashboard().catch(() => null),
          getJobs().catch(() => []),
          getProvisionRequests().catch(() => []),
          getResources().catch(() => []),
          listDockerProjects().catch(() => null),
          getDockerStatus().catch(() => null),
          getK8sNamespaces().catch(() => null),
        ]);
        if (!alive) return;
        if (dash) setData(dash);
        setJobs(Array.isArray(j) ? j : []);
        setRequests(Array.isArray(r) ? r : []);
        setResources(Array.isArray(res) ? res : (res?.resources || []));
        setDocker(
          Array.isArray(dockerRows)
            ? summarizeDocker(dockerRows, dockerStatus)
            : summarizeDocker([], dockerStatus || { configured: false, ok: false, hosts: [] }),
        );
        if (Array.isArray(namespaces)) setK8sNs({ total: namespaces.length, active: namespaces.filter((n) => /active/i.test(n.status || "")).length });
        else setK8sNs({ total: 0, active: 0, unavailable: true });
        setError("");
        const dockerDown = dockerStatus && dockerStatus.configured && !dockerStatus.ok;
        const down = (dash && dash.proxmoxOk === false) || dockerDown;
        if (scheduleNext && alive) {
          timer = setTimeout(() => load(true), down ? 5 * 60 * 1000 : 20000);
        }
      } catch (e) {
        if (alive) {
          setError(e.response?.data?.error || e.message);
          if (scheduleNext) timer = setTimeout(() => load(true), 5 * 60 * 1000);
        }
      } finally {
        if (alive) setLoading(false);
      }
    };
    load();
    getCostRates().then(setRates).catch(() => {});
    return () => { alive = false; clearTimeout(timer); };
  }, []);

  const mine = useMemo(() => {
    const uname = user?.username;
    if (!uname) return resources;
    return resources.filter(
      (r) => !r.owner || r.owner === uname || data?.scope === "owned",
    );
  }, [resources, user, data?.scope]);

  const myVms = useMemo(() => mine.filter((r) => r.type === "vm"), [mine]);
  const myLxc = useMemo(() => mine.filter((r) => r.type === "container"), [mine]);
  const vmRunning = myVms.filter((r) => r.status === "running").length;
  const lxcRunning = myLxc.filter((r) => r.status === "running").length;

  const myJobs = useMemo(() => {
    const uname = user?.username;
    return [...jobs]
      .filter((j) => !j.archivedAt && (!uname || j.requestedBy === uname || j.username === uname || reviewer))
      .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
  }, [jobs, user, reviewer]);

  const pending = useMemo(
    () => requests.filter((r) => r.status === "pending_approval" && !r.archivedAt && (
      !user?.username || r.requestedBy === user.username || r.username === user.username || reviewer
    )),
    [requests, user, reviewer],
  );

  const estCost = useMemo(() => mine.reduce((a, r) => {
    const cpu = Number(r.cpu) || 2;
    const mem = Number(r.memGB) || 4;
    const disk = Number(r.maxdiskGB) || 40;
    return a
      + cpu * (rates?.perCpu ?? 1800) * 0.02
      + mem * (rates?.perGbRam ?? 85) * 0.02
      + disk * (rates?.perGbStorage ?? 12) * 0.02;
  }, 0), [rates, mine]);

  const consumption = useMemo(() => {
    const rows = [];
    for (let i = 1; i <= 6; i++) {
      rows.push({
        m: `W${i}`,
        cost: Math.round(estCost * (0.5 + i * 0.08) * 100) / 100,
      });
    }
    return rows;
  }, [estCost]);

  const dockerSum = docker || { hosts: 0, projects: 0, containers: 0, running: 0, stopped: 0 };
  const k8sSum = k8sNs || { total: 0, active: 0 };

  return (
    <div className="fdash fdash-user">
      <header className="fdash-hero fdash-hero-user">
        <div>
          <p className="fdash-eyebrow">Your workspace</p>
          <h1>Hello, {firstName(user)}</h1>
          <p className="fdash-sub">VMs, LXC, Docker, and Kubernetes you can access — tap any card to open it.</p>
        </div>
        <div className="fdash-hero-cta">
          <Link className="btn btn-primary" to="/provision">Provision</Link>
        </div>
      </header>

      {error && <div className="login-error">{error}</div>}

      <section className="fdash-section">
        <div className="fdash-section-head">
          <h2>Virtual machines</h2>
          <span className="muted">Your Proxmox VMs</span>
        </div>
        <div className="fdash-kpi-grid fdash-kpi-grid-3">
          <KpiCard loading={loading} icon="🖥" label="My VMs" value={myVms.length} color="#3b82f6" to="/resources?type=vm" hint="Open VM inventory" />
          <KpiCard loading={loading} icon="▶" label="Running VMs" value={vmRunning} color="#16a34a" tone="ok" to="/resources?type=vm&status=running" hint="Running only" />
          <KpiCard loading={loading} icon="💳" label="Est. monthly" value={Math.round(estCost)} color="#8b5cf6" to="/usage" hint="Usage & cost" />
        </div>
      </section>

      <section className="fdash-section">
        <div className="fdash-section-head">
          <h2>Containers</h2>
          <span className="muted">LXC · Docker · Kubernetes</span>
        </div>
        <div className="fdash-platform-grid">
          <Link to="/resources?type=container" className="fdash-platform-card tone-lxc">
            <div className="fdash-platform-top">
              <span className="fdash-platform-badge">LXC</span>
              <StatusPill status={data?.proxmoxOk === false ? "unreachable" : "healthy"} />
            </div>
            <strong className="fdash-platform-title">Proxmox containers</strong>
            <div className="fdash-platform-stats">
              <div><em>{loading ? "—" : myLxc.length}</em><span>Total</span></div>
              <div><em>{loading ? "—" : lxcRunning}</em><span>Running</span></div>
              <div><em>{loading ? "—" : Math.max(0, myLxc.length - lxcRunning)}</em><span>Stopped</span></div>
            </div>
            <p className="fdash-platform-foot">Open LXC inventory</p>
          </Link>

          <Link to="/resources?tab=docker" className="fdash-platform-card tone-docker">
            <div className="fdash-platform-top">
              <span className="fdash-platform-badge">Docker</span>
              <StatusPill status={dockerPill(dockerSum.tone)} />
            </div>
            <strong className="fdash-platform-title">Compose projects</strong>
            <div className="fdash-platform-stats">
              <div><em>{loading ? "—" : dockerSum.containers}</em><span>Containers</span></div>
              <div><em>{loading ? "—" : dockerSum.running}</em><span>Running</span></div>
              <div><em>{loading ? "—" : dockerSum.hosts}</em><span>Hosts</span></div>
            </div>
            <p className="fdash-platform-foot">
              {(dockerSum.hostList || []).length
                ? `${(dockerSum.hostList || []).filter((h) => h.ok).length}/${dockerSum.hosts} hosts up`
                : "No hosts"}
              {" · Open Docker inventory"}
            </p>
          </Link>

          <Link to="/resources?tab=kubernetes" className="fdash-platform-card tone-k8s">
            <div className="fdash-platform-top">
              <span className="fdash-platform-badge">K8s</span>
              <StatusPill status={k8sSum.unavailable ? "unconfigured" : "healthy"} />
            </div>
            <strong className="fdash-platform-title">Namespaces</strong>
            <div className="fdash-platform-stats">
              <div><em>{loading ? "—" : k8sSum.total}</em><span>Total</span></div>
              <div><em>{loading ? "—" : k8sSum.active}</em><span>Active</span></div>
              <div><em>—</em><span>Pods</span></div>
            </div>
            <p className="fdash-platform-foot">Open Kubernetes inventory</p>
          </Link>
        </div>
        {(dockerSum.hostList || []).length > 0 && (
          <ul className="fdash-host-list fdash-host-list-inline">
            {(dockerSum.hostList || []).map((h) => (
              <li key={h.id || h.name} className={h.ok ? "ok" : "down"}>
                <span className={`fdash-host-dot ${h.ok ? "ok" : "down"}`} />
                <div className="fdash-host-body">
                  <strong>{h.name}</strong>
                  <em>{h.ok ? (h.version ? `Docker ${h.version}` : "Reachable") : (h.error || "Unreachable")}</em>
                </div>
                <span className="fdash-host-meta muted">
                  {h.containers != null ? `${h.containers} ctr` : ""}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="fdash-section">
        <div className="fdash-section-head">
          <h2>Activity</h2>
        </div>
        <div className="fdash-kpi-grid fdash-kpi-grid-3">
          <KpiCard loading={loading} icon="🚀" label="My deployments" value={myJobs.length} color={ACCENT} to="/deployments" hint="Track jobs" />
          <KpiCard loading={loading} icon="⏳" label="Pending requests" value={pending.length} color="#f59e0b" tone="warn" to="/deployments?tab=hold" hint="Approvals" />
          <KpiCard loading={loading} icon="📊" label="Usage & cost" value={Math.round(estCost)} color="#06b6d4" to="/usage" hint="Open usage" />
        </div>
      </section>

      <section className="fdash-row fdash-row-user-mid">
        <article className="fdash-card">
          <div className="fdash-card-head">
            <h2>Recent deployments</h2>
          </div>
          <div className="fdash-user-timeline">
            {loading && <DashSkeleton rows={4} />}
            {!loading && !myJobs.length && <p className="muted">No deployments yet.</p>}
            {myJobs.slice(0, 6).map((j, i) => (
              <Link
                className="fdash-utl fdash-tl-link"
                key={j.id}
                to={`/deployments?job=${encodeURIComponent(j.id)}`}
                style={{ animationDelay: `${i * 50}ms` }}
              >
                <div className={`fdash-utl-mark status-${String(j.status || "").split("_")[0]}`} />
                <div>
                  <div className="fdash-tl-title">{jobLabel(j)}</div>
                  <div className="fdash-tl-meta">{relativeTime(j.createdAt || j.startedAt)}</div>
                </div>
                <StatusPill status={j.status} />
              </Link>
            ))}
          </div>
        </article>

        {reviewer && (
          <article className="fdash-card">
            <div className="fdash-card-head">
              <h2>Needs your approval</h2>
              <span className="fdash-badge">{pending.length}</span>
            </div>
            <ul className="fdash-compact-list">
              {pending.slice(0, 5).map((r) => (
                <li key={r.id}>
                  <Link to={`/deployments?tab=hold&request=${encodeURIComponent(r.id)}`} className="fdash-inline-link">
                    <strong>{requestLabel(r)}</strong>
                    <span>{r.requestedBy || "user"} · {relativeTime(r.createdAt)}</span>
                  </Link>
                </li>
              ))}
              {!pending.length && <li className="muted">Queue is clear.</li>}
            </ul>
          </article>
        )}

        <article className="fdash-card">
          <div className="fdash-card-head">
            <h2>Cost trend</h2>
          </div>
          <Link to="/usage" className="fdash-chart-link">
            <ResponsiveContainer width="100%" height={180}>
              <AreaChart data={consumption}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--line)" vertical={false} />
                <XAxis dataKey="m" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} width={36} />
                <Tooltip />
                <Area type="monotone" dataKey="cost" stroke="#8b5cf6" fill="color-mix(in srgb, #8b5cf6 18%, transparent)" strokeWidth={2} />
              </AreaChart>
            </ResponsiveContainer>
            <span className="fdash-platform-foot">Open usage</span>
          </Link>
        </article>
      </section>

      <section className="fdash-card">
        <div className="fdash-card-head">
          <h2>My compute</h2>
        </div>
        {loading ? <DashSkeleton rows={3} /> : (
          <div className="fdash-infra-grid">
            {mine.slice(0, 8).map((r) => (
              <Link
                className="fdash-infra-card"
                key={`${r.type}-${r.vmid}`}
                to={`/resources?type=${r.type === "vm" ? "vm" : "container"}`}
              >
                <div className="fdash-infra-top">
                  <span className="fdash-infra-type">{r.type === "vm" ? "VM" : "LXC"}</span>
                  <StatusPill status={r.status} />
                </div>
                <strong className="fdash-infra-name">{r.name || `vm-${r.vmid}`}</strong>
                <div className="fdash-infra-specs">
                  <span>{r.cpu || "—"} CPU</span>
                  <span>{r.memGB != null ? `${r.memGB} GB` : "—"} RAM</span>
                </div>
                <div className="fdash-infra-foot">
                  <code>{r.ip || "No IP"}</code>
                </div>
              </Link>
            ))}
            {!mine.length && (
              <Link className="fdash-empty-soft" to="/provision">
                <p>No compute resources yet — provision one.</p>
              </Link>
            )}
          </div>
        )}
      </section>

      <button type="button" className="fdash-copilot-fab" onClick={openSupportChat}>
        Ask Copilot
      </button>
    </div>
  );
}
