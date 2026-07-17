import { useEffect, useState } from "react";
import { getJob } from "../api/client.js";
import TerminalModal from "./TerminalModal.jsx";
import DeploymentSummary, { RequestDetailsBlock } from "./DeploymentSummary.jsx";
import ServiceNowPanel from "./ServiceNowPanel.jsx";

function fmtTime(ts) {
  try { return new Date(ts).toLocaleTimeString([], { hour12: false }); } catch { return ""; }
}
function stepDotClass(status) {
  if (status === "ready") return "log-dot-ok";
  if (status === "failed") return "log-dot-danger";
  if (status === "pending") return "log-dot-muted";
  return "log-dot-active";
}

// Group workflow steps into their stages (preserving order) and stamp each
// step with a global step number for the dot.
function groupByStage(steps) {
  const groups = [];
  steps.forEach((s, i) => {
    const step = { ...s, n: i + 1 };
    const last = groups[groups.length - 1];
    if (last && last.stage === (s.stage || "")) last.steps.push(step);
    else groups.push({ stage: s.stage || "", steps: [step] });
  });
  return groups;
}

export default function JobStatus({ jobId, onClose }) {
  const [job, setJob] = useState(null);
  const [connectTarget, setConnectTarget] = useState(null);
  const [showSummary, setShowSummary] = useState(false);

  useEffect(() => {
    let timer;
    let cancelled = false;
    async function poll() {
      try {
        const data = await getJob(jobId);
        if (cancelled) return;
        setJob(data);
        if (!["ready", "failed", "cancelled", "rolled_back"].includes(data.status)) {
          timer = setTimeout(poll, 2000);
        }
      } catch (e) {
        if (!cancelled) timer = setTimeout(poll, 3000);
      }
    }
    poll();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [jobId]);

  if (!job) return <div className="card card-pad"><span className="spinner" /> Loading job…</div>;

  const badgeClass =
    job.status === "ready" ? "badge-ready" :
    job.status === "failed" ? "badge-failed" :
    job.status === "cancelled" || job.status === "rolled_back" ? "badge-stopped" :
    job.status === "booting" ? "badge-booting" : "badge-provisioning";

  return (
    <>
      <div className="card card-pad">
        <div className="row-between" style={{ marginBottom: 10 }}>
          <span className={`badge ${badgeClass}`}>{job.status}</span>
          <span className="mono muted">#{job.id}</span>
        </div>
        <p style={{ margin: "0 0 12px", color: "var(--ink-2)" }}>{job.message}</p>
        {job.status === "failed" && (job.errorUserMessage || job.error) && (
          <div className="deploy-fail-box">
            <div className="deploy-fail-title">What went wrong</div>
            <p className="deploy-fail-user">{job.errorUserMessage || job.message}</p>
            {(job.errorDetail || (job.error && job.error !== job.errorUserMessage)) && (
              <details className="deploy-fail-detail">
                <summary>Technical details</summary>
                <pre>{job.errorDetail || job.error}</pre>
              </details>
            )}
            {job.proxmoxUpid && (
              <p className="muted mono" style={{ fontSize: 12, margin: "8px 0 0" }}>
                Proxmox task UPID: {job.proxmoxUpid}
              </p>
            )}
          </div>
        )}
        <RequestDetailsBlock job={job} compact />
        <ServiceNowPanel servicenow={job.servicenow} incident={job.incident} compact />

        {job.steps?.length > 0 ? (
          <div className="wf-stages" style={{ marginBottom: 12 }}>
            {groupByStage(job.steps).map((group, gi) => {
              const total = group.steps.length;
              const doneCount = group.steps.filter((s) => s.state === "done").length;
              const anyActive = group.steps.some((s) => s.state === "active" || s.state === "error");
              const stageState = doneCount === total ? "done" : (anyActive || doneCount > 0) ? "active" : "pending";
              return (
                <div key={group.stage || gi} className={`wf-stage wf-stage-${stageState}`}>
                  <div className="wf-stage-head">
                    <span className="wf-stage-name">{group.stage || `Stage ${gi + 1}`}</span>
                    <span className="wf-stage-count mono">{doneCount}/{total}</span>
                  </div>
                  <ol className="wf-track">
                    {group.steps.map((s) => {
                      const state = job.status === "failed" && s.state === "active" ? "failed" : s.state;
                      return (
                        <li key={s.key} className={`wf-track-step wf-track-${state}`}>
                          <span className="wf-track-dot">
                            {state === "done" ? "✓"
                              : state === "failed" || state === "error" ? "✕"
                              : s.n}
                          </span>
                          <span className="wf-track-body">
                            <span className="wf-track-label">{s.label}</span>
                            {s.via && (
                              <span className="wf-track-via">
                                {state === "active" ? `Calling ${s.via}…`
                                  : state === "done" ? `Success · ${s.via}`
                                  : state === "failed" || state === "error" ? `Failed · ${s.via}`
                                  : s.via}
                              </span>
                            )}
                            {s.reference && <span className="wf-track-ref mono">{s.reference}</span>}
                          </span>
                        </li>
                      );
                    })}
                  </ol>
                </div>
              );
            })}
          </div>
        ) : job.logs?.length > 0 ? (
          <ol className="log-steps" style={{ marginBottom: 12 }}>
            {job.logs.map((s, i) => (
              <li key={i} className={s.error ? "log-step log-step-error" : "log-step"}>
                <span className={`log-dot ${stepDotClass(s.status)}`} />
                <span className="log-step-time mono">{fmtTime(s.ts)}</span>
                <span className="log-step-msg">{s.message}</span>
              </li>
            ))}
          </ol>
        ) : null}

        {(job.status === "ready" || job.status === "failed") && (
          <button className="dep-summary-btn" style={{ marginBottom: 12 }} onClick={() => setShowSummary(true)}>
            View summary
          </button>
        )}

        {job.resources?.length > 0 && (
          <table className="table">
            <thead>
              <tr>
                <th>Hostname</th><th>VMID</th><th>Type</th><th>IP Address</th>
                {job.resources[0].role && <th>Role</th>}
                {job.status === "ready" && <th></th>}
              </tr>
            </thead>
            <tbody>
              {job.resources.map((r) => (
                <tr key={r.vmid || r.hostname}>
                  <td>{r.hostname}</td>
                  <td className="mono">{r.vmid || "—"}</td>
                  <td>{r.type}</td>
                  <td className="mono">{r.ip || "—"}</td>
                  {r.role && <td>{r.role}</td>}
                  {job.status === "ready" && (
                    <td>
                      {r.ip && job.type !== "internal" ? (
                        <button className="btn btn-primary btn-sm" onClick={() => setConnectTarget({ vmid: r.vmid, ip: r.ip, hostname: r.hostname })}>
                          Connect
                        </button>
                      ) : "—"}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {connectTarget && (
        <TerminalModal
          vmid={connectTarget.vmid}
          ip={connectTarget.ip}
          hostname={connectTarget.hostname}
          onClose={() => setConnectTarget(null)}
        />
      )}

      {showSummary && <DeploymentSummary job={job} onClose={() => setShowSummary(false)} />}
    </>
  );
}
