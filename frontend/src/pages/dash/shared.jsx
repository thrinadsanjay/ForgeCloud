import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";

export const ACCENT = "#E67E22";

export function fmtBytes(b) {
  if (!b) return "0";
  const gb = b / 1024 ** 3;
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${(b / 1024 ** 2).toFixed(0)} MB`;
}

export function relativeTime(iso) {
  if (!iso) return "";
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "";
  const m = Math.floor(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function jobLabel(job) {
  return (
    job.resources?.[0]?.hostname ||
    job.payload?.hostname ||
    job.payload?.hostnamePrefix ||
    `Job ${job.id}`
  );
}

export function requestLabel(r) {
  return r.payload?.hostname || r.payload?.hostnamePrefix || `Request ${r.id}`;
}

export function firstName(user) {
  const raw = user?.displayName || user?.username || "there";
  return String(raw).split(/[\s.@]/)[0] || "there";
}

/** Stable pseudo delta % from a seed so cards feel live without history API. */
export function softDelta(seed, value) {
  const n = String(seed).split("").reduce((a, c) => a + c.charCodeAt(0), 0) + (value || 0);
  const pct = ((n % 17) - 3);
  return pct;
}

export function sparkPoints(seed, value, n = 12) {
  const base = Math.max(1, Number(value) || 1);
  const pts = [];
  let v = base * 0.7;
  for (let i = 0; i < n; i++) {
    const wave = Math.sin((i + seed.length) * 0.9) * 0.12;
    const jitter = (((seed.charCodeAt(i % seed.length) || 7) % 5) - 2) * 0.04;
    v = Math.max(0.15, v + wave + jitter);
    pts.push(v);
  }
  pts[pts.length - 1] = 1;
  return pts.map((p) => p * base);
}

export function AnimatedNumber({ value, decimals = 0, duration = 900, suffix = "" }) {
  const [display, setDisplay] = useState(0);
  const fromRef = useRef(0);
  const target = Number(value);
  const safe = Number.isFinite(target) ? target : 0;

  useEffect(() => {
    const from = fromRef.current;
    const start = performance.now();
    let raf;
    const tick = (now) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - (1 - t) ** 3;
      const next = from + (safe - from) * eased;
      setDisplay(next);
      if (t < 1) raf = requestAnimationFrame(tick);
      else fromRef.current = safe;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [safe, duration]);

  const text =
    decimals > 0
      ? display.toFixed(decimals)
      : Math.round(display).toLocaleString();
  return (
    <span className="fdash-num">
      {text}
      {suffix}
    </span>
  );
}

export function MiniSpark({ points, color = ACCENT }) {
  const w = 72;
  const h = 28;
  if (!points?.length) return null;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;
  const d = points
    .map((p, i) => {
      const x = (i / (points.length - 1)) * w;
      const y = h - ((p - min) / span) * (h - 4) - 2;
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg className="fdash-spark" width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden>
      <path d={d} fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function KpiCard({
  icon,
  label,
  value,
  decimals = 0,
  suffix = "",
  delta,
  color = ACCENT,
  tone = "neutral",
  to,
  hint,
  loading,
  children,
}) {
  const pts = sparkPoints(label, typeof value === "number" ? value : 0);
  const deltaNum = typeof delta === "number" ? delta : softDelta(label, value);
  const up = deltaNum >= 0;

  if (loading) {
    return (
      <div className={`fdash-kpi fdash-kpi-${tone} fdash-skel`}>
        <div className="fdash-skel-bar" style={{ width: "40%" }} />
        <div className="fdash-skel-bar fdash-skel-lg" style={{ width: "55%" }} />
        <div className="fdash-skel-bar" style={{ width: "70%" }} />
      </div>
    );
  }

  const body = (
    <>
      <div className="fdash-kpi-top">
        <span className="fdash-kpi-icon" style={{ color, background: `color-mix(in srgb, ${color} 14%, transparent)` }}>
          {icon}
        </span>
        <MiniSpark points={pts} color={color} />
      </div>
      <div className="fdash-kpi-value">
        <AnimatedNumber value={value} decimals={decimals} suffix={suffix} />
      </div>
      <div className="fdash-kpi-label">{label}</div>
      {(hint || children) && (
        <div className="fdash-kpi-hint">
          {hint}
          {children}
        </div>
      )}
      {delta != null && (
        <div className="fdash-kpi-foot">
          <span className={`fdash-delta ${up ? "up" : "down"}`}>
            {up ? "+" : ""}
            {deltaNum}%
          </span>
        </div>
      )}
    </>
  );

  if (to) {
    return (
      <Link
        to={to}
        className={`fdash-kpi fdash-kpi-link fdash-kpi-${tone}`}
        style={{ "--kpi-tone": color }}
      >
        {body}
      </Link>
    );
  }

  return (
    <div className={`fdash-kpi fdash-kpi-${tone}`} style={{ "--kpi-tone": color }}>
      {body}
    </div>
  );
}

export function StatusPill({ status }) {
  const s = String(status || "unknown").toLowerCase().replace(/_/g, " ");
  let tone = "muted";
  if (/running|success|completed|healthy|ok|approved/.test(s)) tone = "ok";
  else if (/unconfigured|checking|configured/.test(s)) tone = "muted";
  else if (/pending|hold|waiting|paused|yellow|warn|degraded/.test(s)) tone = "warn";
  else if (/fail|error|reject|stopped|down|red|unreachable/.test(s)) tone = "danger";
  return <span className={`fdash-pill fdash-pill-${tone}`}>{s}</span>;
}

export function DashSkeleton({ rows = 3 }) {
  return (
    <div className="fdash-skel-block">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="fdash-skel-bar" style={{ width: `${88 - i * 12}%` }} />
      ))}
    </div>
  );
}

export function useLiveClock(ms = 10000) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}
