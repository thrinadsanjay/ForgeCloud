import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  ResponsiveContainer, PieChart, Pie, Cell, Tooltip, Legend,
  RadialBarChart, RadialBar, PolarAngleAxis,
  BarChart, Bar, XAxis, YAxis, CartesianGrid,
} from "recharts";
import { getDashboard, getJobs, getProvisionRequests } from "../api/client.js";
import { useAuth } from "../context/AuthContext.jsx";
import { canReviewDeployments } from "../lib/roles.js";

function fmtBytes(b) {
  if (!b) return "0";
  const gb = b / 1024 ** 3;
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${(b / 1024 ** 2).toFixed(0)} MB`;
}

function fmtUptime(s) {
  if (s == null || Number(s) < 0 || !Number.isFinite(Number(s))) return "—";
  const sec = Math.floor(Number(s));
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return sec > 0 ? "<1m" : "—";
}

function jobLabel(job) {
  return job.resources?.[0]?.hostname
    || job.payload?.hostname
    || job.payload?.hostnamePrefix
    || `Job ${job.id}`;
}

function requestLabel(r) {
  return r.payload?.hostname || r.payload?.hostnamePrefix || `Request ${r.id}`;
}

function relativeTime(iso) {
  if (!iso) return "";
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "";
  const m = Math.floor(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

/** Prefer chips when a pie would be a single solid circle. */
function isOneSided(parts) {
  const nonzero = parts.filter((p) => Number(p.value) > 0);
  return nonzero.length <= 1;
}

function StatChips({ items }) {
  return (
    <div className="dash-chip-stack">
      {items.map((item) => (
        <div className="dash-stat-chip" key={item.name}>
          <span className="dash-stat-chip-label">
            <span className="dash-stat-dot" style={{ background: item.fill }} />
            {item.name}
          </span>
          <span className="dash-stat-chip-value">{item.value}</span>
        </div>
      ))}
    </div>
  );
}

function useThemeColors() {
  const read = () => {
    const s = getComputedStyle(document.documentElement);
    const v = (name, fallback) => (s.getPropertyValue(name) || fallback).trim();
    return {
      brand: v("--brand", "#3f3f3f"),
      accent: v("--accent", "#1f6feb"),
      ok: v("--ok", "#15a34a"),
      warn: v("--warn", "#d97706"),
      danger: v("--danger", "#dc2626"),
      line: v("--line", "#e4e7ec"),
      ink3: v("--ink-3", "#8b94a0"),
    };
  };
  const [colors, setColors] = useState(read);
  useEffect(() => {
    const obs = new MutationObserver(() => setColors(read()));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => obs.disconnect();
  }, []);
  return colors;
}

function Gauge({ value, label, color, sub }) {
  const data = [{ value }];
  return (
    <div className="gauge-wrap">
      <ResponsiveContainer width="100%" height={160}>
        <RadialBarChart
          innerRadius="72%" outerRadius="100%" data={data}
          startAngle={220} endAngle={-40}
        >
          <PolarAngleAxis type="number" domain={[0, 100]} tick={false} />
          <RadialBar background={{ fill: "var(--line-2)" }} dataKey="value" cornerRadius={20} fill={color} />
        </RadialBarChart>
      </ResponsiveContainer>
      <div className="gauge-center">
        <strong>{value}%</strong>
        <span>{label}</span>
      </div>
      {sub && <div className="muted gauge-sub">{sub}</div>}
    </div>
  );
}

export default function Dashboard() {
  const { user } = useAuth();
  const c = useThemeColors();
  const [data, setData] = useState(null);
  const [jobs, setJobs] = useState([]);
  const [requests, setRequests] = useState([]);
  const [error, setError] = useState("");
  const reviewer = canReviewDeployments(user?.role);

  useEffect(() => {
    const load = () => {
      getDashboard().then(setData).catch((e) => setError(e.response?.data?.error || e.message));
      getJobs().then((rows) => setJobs(Array.isArray(rows) ? rows : [])).catch(() => {});
      getProvisionRequests().then((rows) => setRequests(Array.isArray(rows) ? rows : [])).catch(() => {});
    };
    load();
    const t = setInterval(load, 10000);
    return () => clearInterval(t);
  }, []);

  const memPct = data?.node?.memoryTotal
    ? Math.round((data.node.memoryUsed / data.node.memoryTotal) * 100)
    : 0;
  const cpuPct = data?.node?.cpu ? Math.round(data.node.cpu * 100) : 0;

  const vms = data?.counts?.vms ?? 0;
  const containers = data?.counts?.containers ?? 0;
  const running = data?.counts?.running ?? 0;
  const stopped = data?.counts?.stopped ?? 0;
  const totalResources = vms + containers;

  const compositionData = [
    { name: "VMs", value: vms, fill: c.accent },
    { name: "Containers", value: containers, fill: c.brand },
  ];
  const powerData = [
    { name: "Running", value: running, fill: c.ok },
    { name: "Stopped", value: stopped, fill: c.ink3 },
  ];
  const barData = [
    { name: "VMs", count: vms, fill: c.accent },
    { name: "Containers", count: containers, fill: c.brand },
  ];

  const kpis = [
    { label: "Total resources", value: totalResources, accent: c.brand },
    { label: "Running", value: running, accent: c.ok },
    { label: "VMs", value: vms, accent: c.accent },
    { label: "Containers", value: containers, accent: c.warn },
  ];

  const pendingApprovals = useMemo(
    () => requests.filter((r) => r.status === "pending_approval" && !r.archivedAt),
    [requests]
  );

  const recentJobs = useMemo(() => {
    return [...jobs]
      .filter((j) => !j.archivedAt)
      .sort((a, b) => new Date(b.createdAt || b.startedAt || 0) - new Date(a.createdAt || a.startedAt || 0))
      .slice(0, 6);
  }, [jobs]);

  return (
    <div className="page">
      <div className="page-head">
        <div className="eyebrow">Overview</div>
        <h1>Welcome back, {(user?.displayName || user?.username || "").split(/[\s.]/)[0]}</h1>
        <p>
          {data?.scope === "owned"
            ? "Your virtual machines and containers, and their current status."
            : "Live status of all resources on your private cloud infrastructure."}
        </p>
      </div>

      {error && <div className="login-error">{error}</div>}

      <div className="kpi-row">
        {kpis.map((k) => (
          <div className="kpi-tile card" key={k.label}>
            <span className="kpi-accent" style={{ background: k.accent }} />
            <div className="kpi-value">{k.value}</div>
            <div className="kpi-label">{k.label}</div>
          </div>
        ))}
      </div>

      <div className="dash-grid">
        <div className="card card-pad">
          <div className="chart-title">Resource composition</div>
          {isOneSided(compositionData) ? (
            <StatChips items={compositionData} />
          ) : (
            <div className="donut-hold">
              <ResponsiveContainer width="100%" height={220}>
                <PieChart>
                  <Pie
                    data={compositionData} dataKey="value" nameKey="name"
                    innerRadius={62} outerRadius={90} paddingAngle={2} strokeWidth={0}
                  >
                    {compositionData.map((e) => <Cell key={e.name} fill={e.fill} />)}
                  </Pie>
                  <Tooltip />
                  <Legend />
                </PieChart>
              </ResponsiveContainer>
              <div className="donut-hold-center">
                <strong>{totalResources}</strong>
                <span>Total</span>
              </div>
            </div>
          )}
        </div>

        <div className="card card-pad">
          <div className="chart-title">Power state</div>
          {isOneSided(powerData) ? (
            <StatChips items={powerData} />
          ) : (
            <ResponsiveContainer width="100%" height={220}>
              <PieChart>
                <Pie data={powerData} dataKey="value" nameKey="name" outerRadius={90} strokeWidth={0}>
                  {powerData.map((e) => <Cell key={e.name} fill={e.fill} />)}
                </Pie>
                <Tooltip />
                <Legend />
              </PieChart>
            </ResponsiveContainer>
          )}
        </div>

        <div className="card card-pad">
          <div className="chart-title">Resources by type</div>
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={barData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={c.line} vertical={false} />
              <XAxis dataKey="name" tickLine={false} axisLine={{ stroke: c.line }} />
              <YAxis allowDecimals={false} tickLine={false} axisLine={false} />
              <Tooltip cursor={{ fill: "var(--line-2)" }} />
              <Bar dataKey="count" radius={[6, 6, 0, 0]}>
                {barData.map((e) => <Cell key={e.name} fill={e.fill} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="dash-lower">
        <div className="card card-pad">
          <div className="dash-panel-head">
            <div className="chart-title">Recent deployments</div>
            <Link className="btn btn-ghost btn-sm" to="/deployments?tab=all">View all</Link>
          </div>
          {recentJobs.length === 0 ? (
            <p className="muted" style={{ margin: 0, fontSize: 13 }}>No deployments yet. Provision a VM to get started.</p>
          ) : (
            <ul className="dash-list">
              {recentJobs.map((j) => (
                <li className="dash-list-item" key={j.id}>
                  <div className="dash-list-main">
                    <div className="dash-list-title">{jobLabel(j)}</div>
                    <div className="dash-list-meta">
                      {(j.status || "unknown").replace(/_/g, " ")}
                      {j.requestedBy ? ` · ${j.requestedBy}` : ""}
                      {j.createdAt || j.startedAt ? ` · ${relativeTime(j.createdAt || j.startedAt)}` : ""}
                    </div>
                  </div>
                  <div className="dash-list-actions">
                    <Link className="btn btn-ghost btn-sm" to={`/deployments?job=${encodeURIComponent(j.id)}`}>Open</Link>
                  </div>
                </li>
              ))}
            </ul>
          )}
          <div className="dash-quick-actions">
            <Link className="btn btn-primary btn-sm" to="/provision">Provision</Link>
            <Link className="btn btn-ghost btn-sm" to="/resources">Resources</Link>
          </div>
        </div>

        <div className="card card-pad">
          <div className="dash-panel-head">
            <div className="chart-title">
              {reviewer ? "Awaiting approval" : "Your pending requests"}
            </div>
            <Link className="btn btn-ghost btn-sm" to="/deployments?tab=hold">
              {pendingApprovals.length || 0}
            </Link>
          </div>
          {pendingApprovals.length === 0 ? (
            <p className="muted" style={{ margin: 0, fontSize: 13 }}>
              {reviewer ? "Nothing waiting for approval." : "You have no requests on hold."}
            </p>
          ) : (
            <ul className="dash-list">
              {pendingApprovals.slice(0, 6).map((r) => (
                <li className="dash-list-item" key={r.id}>
                  <div className="dash-list-main">
                    <div className="dash-list-title">{requestLabel(r)}</div>
                    <div className="dash-list-meta">
                      {r.requestedBy || r.username || "user"}
                      {r.createdAt ? ` · ${relativeTime(r.createdAt)}` : ""}
                    </div>
                  </div>
                  <div className="dash-list-actions">
                    <Link
                      className="btn btn-primary btn-sm"
                      to={`/deployments?tab=hold&request=${encodeURIComponent(r.id)}`}
                    >
                      {reviewer ? "Review" : "View"}
                    </Link>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {data?.node && (
        <>
          <div className="section-title">Node health</div>
          <div className="dash-grid">
            <div className="card card-pad">
              <div className="chart-title">CPU load</div>
              <Gauge value={cpuPct} label="CPU" color={cpuPct >= 85 ? c.danger : cpuPct >= 60 ? c.warn : c.ok} />
            </div>
            <div className="card card-pad">
              <div className="chart-title">Memory usage</div>
              <Gauge
                value={memPct}
                label="Memory"
                color={memPct >= 85 ? c.danger : memPct >= 60 ? c.warn : c.ok}
                sub={`${fmtBytes(data.node.memoryUsed)} / ${fmtBytes(data.node.memoryTotal)}`}
              />
            </div>
            <div className="card card-pad uptime-card">
              <div className="chart-title">Uptime</div>
              <div className="uptime-chart-value">{fmtUptime(data.node.uptime)}</div>
              <div className="muted" style={{ fontSize: 12 }}>since last boot</div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
