import { useEffect, useState } from "react";
import { getJobs, getProvisionRequests } from "../api/client.js";
import DeploymentSummary from "./DeploymentSummary.jsx";
import { useFloatingPanel } from "../hooks/useFloatingPanel.js";

// A deployment is finished (and can show a summary) once it's ready or failed.
const isDone = (job) => job.status === "ready" || job.status === "failed";

function fmtTime(ts) {
  try { return new Date(ts).toLocaleTimeString([], { hour12: false }); } catch { return ""; }
}

// Human duration: "45s", "2m 10s", "3m".
function fmtDur(sec) {
  if (sec == null || Number.isNaN(sec)) return "";
  const s = Math.max(0, Math.round(sec));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem ? `${m}m ${rem}s` : `${m}m`;
}

function catDotClass(category) {
  if (category === "successful") return "log-dot-ok";
  if (category === "failed") return "log-dot-danger";
  if (category === "pending") return "log-dot-pending";
  if (category === "awaiting") return "log-dot-pending";
  return "log-dot-active"; // running
}

// Turn pending-approval requests (which have no job yet) into monitor entries so
// a high-config deployment shows up on hold until an admin approves it.
function requestsToHoldEntries(requests) {
  return (requests || [])
    .filter((r) => r.status === "pending_approval")
    .map((r) => ({
      id: r.id,
      type: r.kind || "vm",
      category: "awaiting",
      status: "awaiting_approval",
      payload: r.payload,
      createdAt: r.createdAt,
      awaitingApproval: true,
    }));
}
function stepDotClass(status) {
  if (status === "ready") return "log-dot-ok";
  if (status === "failed") return "log-dot-danger";
  if (status === "pending") return "log-dot-muted";
  return "log-dot-active";
}

function jobTitle(job) {
  return job.resources?.[0]?.hostname
    || job.payload?.hostname
    || job.payload?.hostnamePrefix
    || `job ${job.id}`;
}

// Runtime line for a workflow step — names the team/API being called and its
// outcome. `via` is the team/API/playbook (e.g. "Linux team API").
function viaStatus(state, via) {
  if (state === "active") return `Calling ${via}…`;
  if (state === "done") return `Success · ${via}`;
  if (state === "failed" || state === "error") return `Failed · ${via}`;
  return via;
}

function StepList({ job }) {
  // Awaiting approval — no job/steps yet. Show a paused state instead.
  if (job.awaitingApproval) {
    return (
      <div className="dep-hold">
        <span className="dep-hold-badge">⏸ On hold — awaiting approval</span>
        <p className="dep-hold-text">
          This request exceeds the size policy, so provisioning is paused until an
          admin approves it on Deployments. It starts automatically once approved.
        </p>
      </div>
    );
  }

  // Workflow jobs carry a structured, per-step tracker — render each step with
  // its impactful statement, an ETA (pending/active) and time taken (done).
  if (job.steps?.length) {
    const hasEta = job.steps.some((s) => s.etaSec != null || s.tookSec != null);
    const totalEta = job.steps.reduce((a, s) => a + (s.etaSec || 0), 0);
    const doneElapsed = job.steps.reduce((a, s) => a + (s.state === "done" ? (s.tookSec || 0) : 0), 0);

    return (
      <div className="wf">
        {hasEta && totalEta > 0 && (
          <div className="wf-eta-bar">
            <span>Est. total <strong>~{fmtDur(totalEta)}</strong></span>
            <span className="muted">elapsed {fmtDur(doneElapsed)}</span>
          </div>
        )}
        <ol className="wf-track">
          {job.steps.map((s, i) => {
            const state = job.status === "failed" && s.state === "active" ? "failed" : s.state;
            const statement =
              state === "done" ? s.done
              : state === "active" ? s.active
              : state === "failed" ? (s.active || s.label)
              : state === "skipped" ? (s.done || s.label)
              : s.label; // pending
            const timing =
              state === "done" && s.tookSec != null ? `took ${fmtDur(s.tookSec)}`
              : state === "active" && s.etaSec ? `~${fmtDur(s.etaSec)}`
              : state === "pending" && s.etaSec ? `ETA ${fmtDur(s.etaSec)}`
              : state === "skipped" ? "skipped"
              : "";
            return (
              <li key={s.key || i} className={`wf-track-step wf-track-${state}`}>
                <span className="wf-track-dot">
                  {state === "done" ? "✓" : state === "failed" ? "✕" : state === "skipped" ? "–" : i + 1}
                </span>
                <span className="wf-track-body">
                  <span className="wf-track-label">{statement || s.label}</span>
                  {s.via && <span className="wf-track-via">{viaStatus(state, s.via)}</span>}
                  {s.reference && <span className="wf-track-ref mono">{s.reference}</span>}
                </span>
                {timing && <span className="wf-track-time mono">{timing}</span>}
              </li>
            );
          })}
        </ol>
      </div>
    );
  }

  const steps = job.logs || [];
  return (
    <ol className="log-steps">
      {steps.map((s, i) => (
        <li key={i} className={s.error ? "log-step log-step-error" : "log-step"}>
          <span className={`log-dot ${stepDotClass(s.status)}`} />
          <span className="log-step-time mono">{fmtTime(s.ts)}</span>
          <span className="log-step-msg">{s.message}</span>
        </li>
      ))}
      {steps.length === 0 && <li className="log-step muted">No steps recorded.</li>}
    </ol>
  );
}

// One expandable deployment row (used by the category lists and the
// running-only filter). Expanding reveals the step tracker + summary button.
function JobRow({ job, expanded, onToggle, onSummary }) {
  return (
    <div className="log-job">
      <button className="log-job-head" onClick={onToggle} aria-expanded={expanded}>
        <span className={`log-dot ${catDotClass(job.category)}`} />
        <span className="log-job-title">{(job.type || "vm").toUpperCase()} · {jobTitle(job)}</span>
        {job.servicenow?.ritmNumber && (
          <span className="log-job-meta mono" title="ServiceNow RITM">{job.servicenow.ritmNumber}</span>
        )}
        <span className="log-job-meta mono">#{job.id}</span>
        <span className="log-caret">{expanded ? "▾" : "▸"}</span>
      </button>
      {expanded && (
        <>
          <StepList job={job} />
          {isDone(job) && (
            <button className="dep-summary-btn" onClick={onSummary}>
              View summary
            </button>
          )}
        </>
      )}
    </div>
  );
}

export default function LogPanel() {
  const {
    mounted,
    phase,
    panelRef,
    openPanel,
    closePanel,
  } = useFloatingPanel({
    ignoreSelectors: [".log-launcher"],
  });
  const [jobs, setJobs] = useState([]);
  const [requests, setRequests] = useState([]);
  const [error, setError] = useState("");
  const [openJob, setOpenJob] = useState(null);
  const [summaryJob, setSummaryJob] = useState(null);

  useEffect(() => {
    let cancelled = false;
    let timer;
    const poll = async () => {
      try {
        const [jobData, reqData] = await Promise.all([
          getJobs(),
          getProvisionRequests().catch(() => []),
        ]);
        if (cancelled) return;
        setJobs(Array.isArray(jobData) ? jobData : []);
        setRequests(Array.isArray(reqData) ? reqData : []);
        setError("");
      } catch (e) {
        if (!cancelled) setError(e.response?.data?.error || e.message);
      }
      timer = setTimeout(poll, 3500);
    };
    poll();
    return () => { cancelled = true; clearTimeout(timer); };
  }, []);

  // Provision / chat just started something — open the bubble panel on active view.
  useEffect(() => {
    const onOpen = (e) => {
      openPanel();
      const jobId = e?.detail?.jobId;
      if (jobId) setOpenJob(jobId);
      getJobs().then((d) => setJobs(Array.isArray(d) ? d : [])).catch(() => {});
      getProvisionRequests().then((d) => setRequests(Array.isArray(d) ? d : [])).catch(() => {});
    };
    window.addEventListener("forge:open-deployment-monitor", onOpen);
    window.addEventListener("ssp:open-deployment-monitor", onOpen);
    return () => {
      window.removeEventListener("forge:open-deployment-monitor", onOpen);
      window.removeEventListener("ssp:open-deployment-monitor", onOpen);
    };
  }, [openPanel]);

  // Active only: in-flight jobs + pending-approval holds (history lives on Deployments).
  const runningJobs = jobs.filter((j) => j.category === "running" && !j.archivedAt);
  const holdEntries = requestsToHoldEntries(requests);
  const activeEntries = [...holdEntries, ...runningJobs]
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  const pendingCount = activeEntries.length;
  const current = activeEntries[0] || null;

  return (
    <>
      {!mounted && (
        <button
          className="log-launcher"
          onClick={openPanel}
          aria-label="Open deployment monitor"
          title={pendingCount > 0 ? `${pendingCount} active deployment(s)` : "Deployment monitor"}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
            strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M4 6h16M4 12h10M4 18h7" />
            <path d="M15.5 17l2 2 3.5-4" />
          </svg>
          {pendingCount > 0 && (
            <span className="log-launcher-count" aria-hidden="true">{pendingCount > 9 ? "9+" : pendingCount}</span>
          )}
        </button>
      )}

      {mounted && (
        <div
          ref={panelRef}
          className={`logpanel logpanel-normal ${phase === "leaving" ? "logpanel-leave" : "logpanel-enter"}`}
        >
          <div className="logpanel-header">
            <span className="logpanel-title">
              <span className="logpanel-title-dot" />
              Deployment monitor
              {pendingCount > 0 && (
                <span className="logpanel-count logpanel-count-active">
                  {pendingCount} active
                </span>
              )}
            </span>
            <div className="logpanel-controls">
              <button className="logpanel-btn" onClick={closePanel} title="Minimize" aria-label="Minimize to bubble">—</button>
            </div>
          </div>

          <div className="logpanel-body">
            {error && <div className="log-error">{error}</div>}
            {!error && activeEntries.length === 0 && (
              <div className="log-empty">No active deployments. History is on the Deployments page.</div>
            )}

            {current && (
              <div className={`dep-current ${current.category === "running" ? "dep-current-running" : ""} ${current.awaitingApproval ? "dep-current-hold" : ""}`}>
                <div className="dep-current-head">
                  <span className="dep-current-label">
                    {current.awaitingApproval ? "Awaiting approval" : "Running now"}
                  </span>
                  <span className={`log-status-chip ${catDotClass(current.category)}`}>
                    {current.awaitingApproval ? "on hold" : current.category}
                  </span>
                </div>
                <div className="dep-current-title">
                  {(current.type || "vm").toUpperCase()} · {jobTitle(current)}
                  <span className="log-job-meta mono"> #{current.id}</span>
                </div>
                <StepList job={current} />
              </div>
            )}

            {activeEntries.length > 1 && (
              <div className="dep-cat-list">
                <div className="dep-current-head" style={{ marginBottom: 6 }}>
                  <span className="dep-current-label">Other active</span>
                </div>
                {activeEntries.slice(1).map((job) => (
                  <JobRow
                    key={job.id}
                    job={job}
                    expanded={openJob === job.id}
                    onToggle={() => setOpenJob(openJob === job.id ? null : job.id)}
                    onSummary={() => setSummaryJob(job)}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {summaryJob && <DeploymentSummary job={summaryJob} onClose={() => setSummaryJob(null)} />}
    </>
  );
}
