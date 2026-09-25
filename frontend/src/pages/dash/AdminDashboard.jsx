import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  ResponsiveContainer, AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip,
} from "recharts";
import {
  getDashboard, getJobs, getProvisionRequests, getSettings,
  getPackages, getApplicationRoles, getUsers, getGroups, getMappings,
  listDockerProjects, getK8sNamespaces, getDockerStatus,
  testProxmoxConnection, testK3sConnection, testServiceNowConnection,
  testIpamConnection, testN8nWebhook, testAiConnection,
} from "../../api/client.js";
import { useAuth } from "../../context/AuthContext.jsx";
import {
  ACCENT, AnimatedNumber, DashSkeleton, KpiCard, StatusPill,
  firstName, fmtBytes, jobLabel, relativeTime, useLiveClock,
} from "./shared.jsx";

const HEALTH_LABEL = {
  ok: "Healthy",
  off: "Unconfigured",
  danger: "Unreachable",
  warn: "Degraded",
  checking: "Checking…",
  configured: "Configured",
};

const HEALTH_PROBES = [
  { id: "proxmox", label: "Proxmox", tab: "proxmox", needs: ["PROXMOX_HOST"], test: () => testProxmoxConnection({ light: true }) },
  { id: "docker", label: "Docker", tab: "docker", dockerProbe: true },
  { id: "k8s", label: "Kubernetes", tab: "k3s", needs: ["K3S_API_URL"], test: testK3sConnection },
  { id: "snow", label: "ServiceNow", tab: "servicenow", needs: ["SERVICENOW_INSTANCE_URL"], test: testServiceNowConnection },
  { id: "ipam", label: "IPAM", tab: "ipam", needs: ["IPAM_URL"], test: testIpamConnection },
  { id: "n8n", label: "n8n", tab: "n8n", needs: ["N8N_WEBHOOK_URL"], test: testN8nWebhook },
  {
    id: "ai",
    label: "AI Assistant",
    tab: "ai",
    needs: ["GEMINI_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "OPENROUTER_API_KEY", "OLLAMA_BASE_URL"],
    needAny: true,
    test: testAiConnection,
  },
  { id: "oidc", label: "OIDC", tab: "oidc", needs: ["OIDC_ISSUER", "OIDC_CLIENT_ID"], needAny: true, test: null },
];

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

  // Prefer live probe host status when available
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
    message: status?.message || (hosts ? `${hosts} host(s)` : "No Docker hosts"),
    unavailable: !configured || hosts === 0,
  };
}

export default function AdminDashboard() {
  const { user } = useAuth();
  const now = useLiveClock(15000);
  const [data, setData] = useState(null);
  const [jobs, setJobs] = useState([]);
  const [requests, setRequests] = useState([]);
  const [settings, setSettings] = useState(null);
  const [docker, setDocker] = useState(null);
  const [k8sNs, setK8sNs] = useState(null);
  const [catalog, setCatalog] = useState({ packages: 0, roles: 0, users: 0, groups: 0, mappings: 0 });
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  /** @type {Record<string, 'ok'|'off'|'danger'|'warn'|'checking'|'configured'>} */
  const [health, setHealth] = useState({});
  const healthRef = useRef(health);
  healthRef.current = health;

  const loadFleet = async () => {
    try {
      const [dash, dockerRows, dockerStatus, namespaces] = await Promise.all([
        getDashboard(),
        listDockerProjects().catch(() => null),
        getDockerStatus().catch(() => null),
        getK8sNamespaces().catch(() => null),
      ]);
      setData(dash);
      const summary = Array.isArray(dockerRows)
        ? summarizeDocker(dockerRows, dockerStatus)
        : summarizeDocker([], dockerStatus || { configured: false, ok: false, hosts: [] });
      setDocker(summary);
      setHealth((h) => ({ ...h, docker: summary.tone }));
      if (Array.isArray(namespaces)) setK8sNs({ total: namespaces.length, active: namespaces.filter((n) => /active/i.test(n.status || "")).length });
      else setK8sNs({ total: 0, active: 0, unavailable: true });
      setError("");
      return dash;
    } catch (e) {
      setError(e.response?.data?.error || e.message);
      setData((prev) => prev || {
        scope: "all",
        counts: {
          vms: 0, containers: 0, running: 0, stopped: 0,
          vm: { total: 0, running: 0, stopped: 0 },
          lxc: { total: 0, running: 0, stopped: 0 },
        },
        node: null,
        proxmoxOk: false,
      });
      return null;
    }
  };

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [j, r, s] = await Promise.all([
          getJobs().catch(() => []),
          getProvisionRequests().catch(() => []),
          getSettings().catch(() => null),
        ]);
        if (!alive) return;
        setJobs(Array.isArray(j) ? j : []);
        setRequests(Array.isArray(r) ? r : []);
        setSettings(s);
      } catch (e) {
        if (alive) setError(e.response?.data?.error || e.message);
      } finally {
        if (alive) setLoading(false);
      }
      if (alive) await loadFleet();
    })();
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    if (health.proxmox !== "ok" && health.docker !== "ok") return undefined;
    const t = setInterval(() => { loadFleet(); }, 20000);
    return () => clearInterval(t);
  }, [health.proxmox, health.docker]);

  useEffect(() => {
    Promise.all([
      getPackages().catch(() => []),
      getApplicationRoles().catch(() => []),
      getUsers().catch(() => []),
      getGroups().catch(() => []),
      getMappings().catch(() => ({})),
    ]).then(([pkgs, roles, users, groups, maps]) => {
      const templates = maps?.templates;
      const networks = maps?.networks;
      const mapCount = (Array.isArray(templates) ? templates.length : Object.keys(templates || {}).length)
        + (Array.isArray(networks) ? networks.length : Object.keys(networks || {}).length);
      setCatalog({
        packages: Array.isArray(pkgs) ? pkgs.length : 0,
        roles: Array.isArray(roles) ? roles.length : 0,
        users: Array.isArray(users) ? users.length : 0,
        groups: Array.isArray(groups) ? groups.length : 0,
        mappings: mapCount,
      });
    });
  }, []);

  const vm = data?.counts?.vm || {
    total: data?.counts?.vms ?? 0,
    running: 0,
    stopped: 0,
  };
  const lxc = data?.counts?.lxc || {
    total: data?.counts?.containers ?? 0,
    running: 0,
    stopped: 0,
  };
  // Fill running/stopped for legacy payloads
  if (!data?.counts?.vm && data?.counts) {
    const ratio = (data.counts.vms || 0) + (data.counts.containers || 0);
    const runShare = ratio ? (data.counts.running || 0) / ratio : 0;
    vm.running = Math.round((data.counts.vms || 0) * runShare);
    vm.stopped = Math.max(0, (data.counts.vms || 0) - vm.running);
    lxc.running = Math.round((data.counts.containers || 0) * runShare);
    lxc.stopped = Math.max(0, (data.counts.containers || 0) - lxc.running);
  }

  const memPct = data?.node?.memoryTotal
    ? Math.round((data.node.memoryUsed / data.node.memoryTotal) * 100)
    : 0;
  const cpuPct = data?.node?.cpu != null ? Math.round(data.node.cpu * 100) : 0;
  const loadAvg = Array.isArray(data?.node?.loadavg) ? data.node.loadavg[0] : null;
  const nodeName = data?.node?.name || "Proxmox";

  const pending = useMemo(
    () => requests.filter((r) => r.status === "pending_approval" && !r.archivedAt),
    [requests],
  );
  const failedJobs = useMemo(
    () => jobs.filter((j) => /fail/i.test(j.status || "") && !j.archivedAt),
    [jobs],
  );
  const todaysJobs = useMemo(() => {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const startMs = start.getTime();
    return [...jobs]
      .filter((j) => {
        if (j.archivedAt) return false;
        const t = new Date(j.createdAt || j.startedAt || 0).getTime();
        return Number.isFinite(t) && t >= startMs;
      })
      .sort((a, b) => new Date(b.createdAt || b.startedAt || 0) - new Date(a.createdAt || a.startedAt || 0));
  }, [jobs]);

  const fields = useMemo(() => {
    const map = {};
    for (const g of settings?.groups || []) {
      for (const f of g.fields || []) {
        if (f?.key) map[f.key] = f;
      }
    }
    return map;
  }, [settings]);

  const fieldOk = (key) => {
    const f = fields[key];
    if (!f) return false;
    if (f.secret) return !!f.isSet;
    if (typeof f.value === "boolean") return f.value === true;
    const v = f.value;
    if (v == null) return false;
    const s = String(v).trim();
    return s !== "" && s !== "CHANGE_ME";
  };
  const anyOk = (...keys) => keys.some((k) => fieldOk(k));

  useEffect(() => {
    if (!settings) return undefined;
    let cancelled = false;

    const isConfigured = (svc) => {
      if (svc.dockerProbe) return true; // resolved via getDockerStatus in loadFleet
      return svc.needAny ? anyOk(...svc.needs) : fieldOk(svc.needs[0]);
    };

    const probeOne = async (svc) => {
      if (svc.dockerProbe) {
        // Docker tone is owned by loadFleet / getDockerStatus.
        return healthRef.current.docker || "checking";
      }
      if (!isConfigured(svc)) {
        if (!cancelled) setHealth((h) => ({ ...h, [svc.id]: "off" }));
        return "off";
      }
      if (!svc.test) {
        if (!cancelled) setHealth((h) => ({ ...h, [svc.id]: "configured" }));
        return "configured";
      }
      if (!cancelled) setHealth((h) => ({ ...h, [svc.id]: "checking" }));
      try {
        await svc.test();
        if (!cancelled) setHealth((h) => ({ ...h, [svc.id]: "ok" }));
        return "ok";
      } catch {
        if (!cancelled) setHealth((h) => ({ ...h, [svc.id]: "danger" }));
        return "danger";
      }
    };

    const initial = {};
    for (const svc of HEALTH_PROBES) {
      if (svc.dockerProbe) initial[svc.id] = healthRef.current.docker || "checking";
      else initial[svc.id] = !isConfigured(svc) ? "off" : (svc.test ? "checking" : "configured");
    }
    setHealth((h) => ({ ...initial, docker: h.docker || initial.docker }));

    (async () => {
      const results = {};
      await Promise.all(HEALTH_PROBES.map(async (svc) => {
        results[svc.id] = await probeOne(svc);
      }));
      if (cancelled) return;
      // Always refresh fleet so Docker status is populated even if Proxmox is down.
      await loadFleet();
    })();

    const t = setInterval(async () => {
      const current = healthRef.current || {};
      const down = HEALTH_PROBES.filter((svc) => current[svc.id] === "danger" && (svc.test || svc.dockerProbe));
      if (!down.length) return;
      let recovered = false;
      await Promise.all(down.map(async (svc) => {
        if (svc.dockerProbe) {
          await loadFleet();
          if (healthRef.current.docker === "ok") recovered = true;
          return;
        }
        const tone = await probeOne(svc);
        if (svc.id === "proxmox" && tone === "ok") recovered = true;
      }));
      if (recovered && !cancelled) await loadFleet();
    }, 5 * 60 * 1000);

    return () => { cancelled = true; clearInterval(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings]);

  const dockerPill = (tone) => {
    if (tone === "ok") return "healthy";
    if (tone === "warn") return "degraded";
    if (tone === "danger") return "unreachable";
    if (tone === "checking") return "checking";
    return "unconfigured";
  };

  const proxmoxTone = health.proxmox || "off";
  const clusterOk = proxmoxTone === "ok";
  const clusterLabel = proxmoxTone === "ok"
    ? `${nodeName} · healthy`
    : proxmoxTone === "danger"
      ? `${nodeName} · unreachable`
      : proxmoxTone === "checking"
        ? "Checking Proxmox…"
        : "Proxmox unconfigured";

  const metricSeries = useMemo(() => {
    const pts = [];
    for (let i = 0; i < 12; i++) {
      pts.push({
        t: `${i}`,
        cpu: Math.max(8, Math.min(96, cpuPct + Math.sin(i / 2) * 8 + (i % 3) * 2)),
        ram: Math.max(10, Math.min(96, memPct + Math.cos(i / 2.5) * 6)),
      });
    }
    return pts;
  }, [cpuPct, memPct]);

  const syncLabel = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const dockerSum = docker || { hosts: 0, projects: 0, containers: 0, running: 0, stopped: 0 };
  const k8sSum = k8sNs || { total: 0, active: 0 };

  return (
    <div className="fdash fdash-admin">
      <header className="fdash-hero fdash-hero-admin">
        <div>
          <p className="fdash-eyebrow">System administration</p>
          <h1>Welcome back, {firstName(user)}</h1>
          <p className="fdash-sub">Fleet overview across Proxmox VMs, LXC, Docker, and Kubernetes.</p>
        </div>
        <div className="fdash-hero-meta">
          <Link
            to="/admin?tab=proxmox"
            className="fdash-meta-chip fdash-meta-link"
            title="Open Proxmox settings"
          >
            <span
              className={`fdash-pulse ${clusterOk ? "ok" : ""}`}
              style={!clusterOk ? { background: proxmoxTone === "danger" ? "var(--danger)" : "var(--ink-3)" } : undefined}
            />
            {clusterLabel}
          </Link>
          <div className="fdash-meta-chip muted">Synced {syncLabel}</div>
        </div>
      </header>

      {error && <div className="login-error">{error}</div>}

      <section className="fdash-section">
        <div className="fdash-section-head">
          <h2>Virtual machines</h2>
          <span className="muted">Proxmox QEMU</span>
        </div>
        <div className="fdash-kpi-grid fdash-kpi-grid-3">
          <KpiCard loading={loading} icon="🖥" label="Total VMs" value={vm.total} color="#3b82f6" to="/resources?type=vm" hint="Open compute inventory" />
          <KpiCard loading={loading} icon="▶" label="Running VMs" value={vm.running} color="#16a34a" tone="ok" to="/resources?type=vm&status=running" hint="Filter running" />
          <KpiCard loading={loading} icon="⏹" label="Stopped VMs" value={vm.stopped} color="#64748b" to="/resources?type=vm&status=stopped" hint="Filter stopped" />
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
              <StatusPill status={data?.proxmoxOk ? "healthy" : "unreachable"} />
            </div>
            <strong className="fdash-platform-title">Proxmox containers</strong>
            <div className="fdash-platform-stats">
              <div><em>{loading ? "—" : lxc.total}</em><span>Total</span></div>
              <div><em>{loading ? "—" : lxc.running}</em><span>Running</span></div>
              <div><em>{loading ? "—" : lxc.stopped}</em><span>Stopped</span></div>
            </div>
            <p className="fdash-platform-foot">Open LXC inventory</p>
          </Link>

          <Link to="/resources?tab=docker" className="fdash-platform-card tone-docker">
            <div className="fdash-platform-top">
              <span className="fdash-platform-badge">Docker</span>
              <StatusPill status={dockerPill(dockerSum.tone || health.docker)} />
            </div>
            <strong className="fdash-platform-title">Compose engines</strong>
            <div className="fdash-platform-stats">
              <div><em>{loading ? "—" : dockerSum.containers}</em><span>Containers</span></div>
              <div><em>{loading ? "—" : dockerSum.running}</em><span>Running</span></div>
              <div><em>{loading ? "—" : dockerSum.hosts}</em><span>Hosts</span></div>
            </div>
            <p className="fdash-platform-foot">
              {HEALTH_LABEL[dockerSum.tone || health.docker] || "—"}
              {dockerSum.hostErrors ? ` · ${dockerSum.hostErrors} down` : ""}
              {" · Open Docker inventory"}
            </p>
          </Link>

          <Link to="/resources?tab=kubernetes" className="fdash-platform-card tone-k8s">
            <div className="fdash-platform-top">
              <span className="fdash-platform-badge">K8s</span>
              <StatusPill status={k8sSum.unavailable ? (health.k8s === "off" ? "unconfigured" : "unreachable") : "healthy"} />
            </div>
            <strong className="fdash-platform-title">Kubernetes</strong>
            <div className="fdash-platform-stats">
              <div><em>{loading ? "—" : k8sSum.total}</em><span>Namespaces</span></div>
              <div><em>{loading ? "—" : k8sSum.active}</em><span>Active</span></div>
              <div><em>{HEALTH_LABEL[health.k8s] || "—"}</em><span>Cluster</span></div>
            </div>
            <p className="fdash-platform-foot">Open Kubernetes inventory</p>
          </Link>
        </div>
      </section>

      <section className="fdash-section">
        <div className="fdash-section-head">
          <h2>Operations</h2>
          <span className="muted">Deployments & approvals</span>
        </div>
        <div className="fdash-kpi-grid fdash-kpi-grid-4">
          <KpiCard loading={loading} icon="⚠" label="Failed deployments" value={failedJobs.length} color="#dc2626" tone="danger" to="/deployments?tab=failed" hint="Open failed jobs" />
          <KpiCard loading={loading} icon="⏳" label="Pending approvals" value={pending.length} color={ACCENT} tone="warn" to="/deployments?tab=hold" hint="Review queue" />
          <KpiCard loading={loading} icon="🚀" label="Deployments today" value={todaysJobs.length} color="#0ea5e9" to="/deployments?tab=all" hint="Activity feed" />
          <KpiCard loading={loading} icon="⚡" label="Node CPU" value={cpuPct} suffix="%" color={cpuPct >= 85 ? "#dc2626" : "#06b6d4"} to="/admin?tab=proxmox" hint={nodeName} />
        </div>
      </section>

      <section className="fdash-row fdash-row-3">
        <article className="fdash-card">
          <Link to="/admin?tab=proxmox" className="fdash-card-as-link">
            <div className="fdash-card-head">
              <h2>Proxmox node</h2>
              <span className="muted">{nodeName}</span>
            </div>
            {loading ? <DashSkeleton /> : (
              <>
                <div className="fdash-consume-stats">
                  <div><span>CPU</span><strong>{cpuPct}%</strong></div>
                  <div><span>Memory</span><strong>{memPct}%</strong></div>
                  <div><span>Load</span><strong>{loadAvg != null ? Number(loadAvg).toFixed(2) : "—"}</strong></div>
                  <div><span>Mem used</span><strong>{data?.node ? fmtBytes(data.node.memoryUsed) : "—"}</strong></div>
                </div>
                <ResponsiveContainer width="100%" height={160}>
                  <AreaChart data={metricSeries}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--line)" vertical={false} />
                    <XAxis dataKey="t" hide />
                    <YAxis domain={[0, 100]} tick={{ fontSize: 11 }} width={28} />
                    <Tooltip />
                    <Area type="monotone" dataKey="cpu" stroke="#06b6d4" fill="color-mix(in srgb, #06b6d4 22%, transparent)" strokeWidth={2} />
                    <Area type="monotone" dataKey="ram" stroke="#3b82f6" fill="color-mix(in srgb, #3b82f6 18%, transparent)" strokeWidth={2} />
                  </AreaChart>
                </ResponsiveContainer>
                <p className="fdash-platform-foot">Open Proxmox settings</p>
              </>
            )}
          </Link>
        </article>

        <article className="fdash-card">
          <Link to="/admin?tab=docker" className="fdash-card-as-link">
            <div className="fdash-card-head">
              <h2>Docker hosts</h2>
              <StatusPill status={dockerPill(dockerSum.tone || health.docker)} />
            </div>
            {loading ? <DashSkeleton /> : (
              <>
                {!(dockerSum.hostList || []).length ? (
                  <p className="muted">No Docker hosts configured.</p>
                ) : (
                  <ul className="fdash-host-list">
                    {(dockerSum.hostList || []).map((h) => (
                      <li key={h.id || h.name} className={h.ok ? "ok" : "down"}>
                        <span className={`fdash-host-dot ${h.ok ? "ok" : "down"}`} />
                        <div className="fdash-host-body">
                          <strong>{h.name}</strong>
                          <em>{h.ok ? (h.version ? `v${h.version}` : "Reachable") : (h.error || "Unreachable")}</em>
                        </div>
                        <span className="fdash-host-meta muted">
                          {h.containers != null ? `${h.containers} ctr` : ""}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
                <p className="fdash-platform-foot">Manage Docker hosts</p>
              </>
            )}
          </Link>
        </article>

        <article className="fdash-card">
          <div className="fdash-card-head">
            <h2>Integration health</h2>
          </div>
          <div className="fdash-svc-grid">
            {HEALTH_PROBES.map((s) => {
              const tone = health[s.id] || "off";
              return (
                <Link key={s.id} to={`/admin?tab=${s.tab}`} className={`fdash-svc-tile fdash-svc-${tone}`}>
                  <span className={`fdash-svc-dot fdash-svc-${tone}`} />
                  <strong>{s.label}</strong>
                  <em>{HEALTH_LABEL[tone] || "—"}</em>
                </Link>
              );
            })}
          </div>
        </article>
      </section>

      <section className="fdash-row fdash-row-activity">
        <article className="fdash-card fdash-span-2">
          <div className="fdash-card-head">
            <h2>Deployment activity</h2>
          </div>
          <div className="fdash-timeline">
            {loading && <DashSkeleton rows={5} />}
            {!loading && todaysJobs.length === 0 && <p className="muted">No deployments today.</p>}
            {todaysJobs.slice(0, 8).map((j, i) => (
              <Link
                className="fdash-tl-item fdash-tl-link"
                key={j.id}
                to={`/deployments?job=${encodeURIComponent(j.id)}`}
                style={{ animationDelay: `${i * 40}ms` }}
              >
                <span className="fdash-tl-rail" />
                <div className="fdash-tl-body">
                  <div className="fdash-tl-title">{jobLabel(j)}</div>
                  <div className="fdash-tl-meta">
                    {(j.payload?.os || j.payload?.template || "Workload").toString()}
                    {j.requestedBy ? ` · ${j.requestedBy}` : ""}
                    {" · "}
                    {relativeTime(j.createdAt || j.startedAt)}
                  </div>
                </div>
                <StatusPill status={j.status} />
              </Link>
            ))}
          </div>
        </article>
        <article className="fdash-card">
          <div className="fdash-card-head"><h2>Platform inventory</h2></div>
          <div className="fdash-inv-grid fdash-inv-grid-compact">
            {[
              { label: "Packages", value: catalog.packages, to: "/admin?tab=packages" },
              { label: "App roles", value: catalog.roles, to: "/admin?tab=app-roles" },
              { label: "Users", value: catalog.users, to: "/admin?tab=users" },
              { label: "Groups", value: catalog.groups, to: "/admin?tab=groups" },
              { label: "Mappings", value: catalog.mappings, to: "/admin?tab=mappings" },
              { label: "Docker hosts", value: dockerSum.hosts || 0, to: "/admin?tab=docker" },
            ].map((item) => (
              <Link key={item.label} to={item.to} className="fdash-inv-tile">
                <span>{item.label}</span>
                <strong><AnimatedNumber value={item.value} /></strong>
              </Link>
            ))}
          </div>
        </article>
      </section>
    </div>
  );
}
