import { useState } from "react";
import ServiceNowPanel from "./ServiceNowPanel.jsx";

// Small inline icons (stroke-based, inherit currentColor).
function Icon({ name }) {
  const paths = {
    eye: <><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" /><circle cx="12" cy="12" r="3" /></>,
    eyeOff: <><path d="M3 3l18 18" /><path d="M10.6 10.6a3 3 0 0 0 4.2 4.2" /><path d="M9.9 5.2A9.5 9.5 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.2 4M6.1 6.1A17 17 0 0 0 2 12s3.5 7 10 7a9.5 9.5 0 0 0 2.1-.2" /></>,
    copy: <><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h10" /></>,
    check: <path d="M5 12l4 4L19 7" />,
  };
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor"
      strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>
  );
}

function CopyButton({ value, title = "Copy" }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked — ignore */
    }
  };
  return (
    <button type="button" className="ds-icon-btn" onClick={copy} title={copied ? "Copied!" : title} aria-label={title}>
      <Icon name={copied ? "check" : "copy"} />
    </button>
  );
}

function CredRow({ label, value, secret = false }) {
  const [revealed, setRevealed] = useState(false);
  const shown = secret && !revealed ? "••••••••••" : value;
  return (
    <div className="ds-cred">
      <span className="ds-cred-label">{label}</span>
      <span className="ds-cred-value mono">{shown}</span>
      <div className="ds-cred-actions">
        {secret && (
          <button
            type="button"
            className="ds-icon-btn"
            onClick={() => setRevealed((v) => !v)}
            title={revealed ? "Hide" : "Show"}
            aria-label={revealed ? "Hide password" : "Show password"}
          >
            <Icon name={revealed ? "eyeOff" : "eye"} />
          </button>
        )}
        <CopyButton value={value} title={`Copy ${label.toLowerCase()}`} />
      </div>
    </div>
  );
}

function fmtWhen(ts) {
  if (!ts) return null;
  try { return new Date(ts).toLocaleString(); } catch { return String(ts); }
}

function SpecChips({ payload = {} }) {
  const chips = [];
  if (payload.cpu) chips.push({ label: "CPU", value: `${payload.cpu} vCPU` });
  if (payload.memoryGB) chips.push({ label: "RAM", value: `${payload.memoryGB} GB` });
  if (payload.diskGB) chips.push({ label: "Storage", value: `${payload.diskGB} GB` });
  if (!chips.length) return null;
  return (
    <div className="ds-spec-chips">
      {chips.map((c) => (
        <div className="req-chip" key={c.label}><span>{c.label}</span><strong>{c.value}</strong></div>
      ))}
    </div>
  );
}

function Field({ label, children, mono = false, wide = false }) {
  if (children == null || children === "") return null;
  return (
    <div className={`ds-field${wide ? " ds-field-wide" : ""}`}>
      <span>{label}</span>
      <b className={mono ? "mono" : undefined}>{children}</b>
    </div>
  );
}

/** Shared request metadata block used by summary modal and job monitor. */
export function RequestDetailsBlock({ job, compact = false }) {
  if (!job) return null;
  const p = job.payload || {};
  const target = p.hostname || p.hostnamePrefix || job.resources?.[0]?.hostname || "—";
  const packages = Array.isArray(p.packages) ? p.packages.filter(Boolean) : [];
  const when = fmtWhen(job.createdAt);

  if (compact) {
    return (
      <div className="job-request-meta">
        <div className="job-request-meta-row">
          <span>Requested by</span>
          <strong>{p.requestedBy || "—"}</strong>
        </div>
        {(p.requestId || job.requestId) && (
          <div className="job-request-meta-row">
            <span>Request ID</span>
            <strong className="mono">{p.requestId || job.requestId}</strong>
          </div>
        )}
        <div className="job-request-meta-row">
          <span>Target</span>
          <strong>{target}</strong>
        </div>
        <div className="job-request-meta-specs">
          {p.cpu != null && <span>{p.cpu} vCPU</span>}
          {p.memoryGB != null && <span>{p.memoryGB} GB RAM</span>}
          {p.diskGB ? <span>+{p.diskGB} GB data disk</span> : null}
          {p.environment && <span>{p.environment}</span>}
        </div>
      </div>
    );
  }

  return (
    <div className="ds-section">
      <div className="ds-section-title">Request details</div>
      <div className="ds-field-grid">
        <Field label="Job ID" mono>{job.id}</Field>
        {(p.requestId || job.requestId) && (
          <Field label="Request ID" mono>{p.requestId || job.requestId}</Field>
        )}
        <Field label="Requested by">{p.requestedBy || "—"}</Field>
        <Field label="Type">{(job.type || p.kind || "—").toString().toUpperCase()}</Field>
        <Field label="Target host">{target}</Field>
        {(p.templateId || p.stackId) && (
          <Field label={p.stackId ? "Stack" : "Template"} mono>{p.stackId || p.templateId}</Field>
        )}
        {p.environment && <Field label="Environment">{p.environment}</Field>}
        {p.username && <Field label="Account" mono>{p.username}</Field>}
        {when && <Field label="Submitted" wide>{when}</Field>}
      </div>
      <SpecChips payload={p} />
      {packages.length > 0 && (
        <div className="ds-packages">
          <span className="ds-packages-label">Packages</span>
          <div className="ds-package-list">
            {packages.map((pkg) => (
              <span className="ds-package-chip" key={pkg}>{pkg}</span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default function DeploymentSummary({ job, onClose }) {
  if (!job) return null;

  const resources = job.resources || [];
  const result = job.result || {};
  const failed = job.status === "failed";
  const hasLogin = !!(result.username && result.generatedPassword);
  const workflow = Array.isArray(result.workflow) ? result.workflow : [];
  const hasSnow = !!(
    job.servicenow?.ritmNumber
    || job.servicenow?.requestNumber
    || job.incident
    || job.servicenow?.incidentNumber
    || (Array.isArray(job.servicenow?.cmdbItems) && job.servicenow.cmdbItems.length)
  );

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card ds-card" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Deployment summary">
        <div className="modal-header">
          <h3>Deployment summary</h3>
          <button className="ds-close" onClick={onClose} aria-label="Close">×</button>
        </div>

        <div className="modal-body ds-body">
          <p className={`ds-status ${failed ? "err" : "ok"}`}>{job.message}</p>

          <div className="ds-layout">
            <div className="ds-col">
              <RequestDetailsBlock job={job} />

              {resources.length > 0 && (
                <div className="ds-section">
                  <div className="ds-section-title">{resources.length > 1 ? "Machines" : "Machine details"}</div>
                  {resources.map((r) => (
                    <div className="ds-detail-grid" key={r.vmid || r.hostname}>
                      <div><span>Name</span><b>{r.hostname}</b></div>
                      <div><span>ID</span><b className="mono">{r.vmid || "—"}</b></div>
                      <div><span>Type</span><b>{(r.type || "vm").toUpperCase()}</b></div>
                      <div><span>IP address</span><b className="mono">{r.ip || "—"}</b></div>
                      {r.environment && <div><span>Network</span><b>{r.environment}</b></div>}
                      {r.role && <div><span>Role</span><b>{r.role}</b></div>}
                    </div>
                  ))}
                </div>
              )}

              {workflow.length > 0 && (
                <div className="ds-section">
                  <div className="ds-section-title">Internal provisioning workflow</div>
                  <div className="ds-detail-grid">
                    {workflow.map((w, i) => (
                      <div key={i}>
                        <span>{w.system}</span>
                        <b className="mono">{w.reference}</b>
                        {w.detail && <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>{w.detail}</div>}
                      </div>
                    ))}
                  </div>
                  <p className="ds-note">Each step in the internal provisioning workflow completed. This workflow does not create a Proxmox VM.</p>
                </div>
              )}
            </div>

            <div className="ds-col">
              {hasSnow && <ServiceNowPanel servicenow={job.servicenow} incident={job.incident} />}

              {hasLogin && (
                <div className="ds-section">
                  <div className="ds-section-title">Login credentials</div>
                  <div className="ds-creds">
                    <CredRow label="Username" value={result.username} />
                    <CredRow label="Password" value={result.generatedPassword} secret />
                  </div>
                  {result.sudo && <p className="ds-note">This user has administrator (sudo) access.</p>}
                  <p className="ds-note">Keep these safe — the password is shown here for the first time. We recommend changing it after your first login.</p>
                </div>
              )}

              {!hasLogin && !failed && workflow.length === 0 && (
                <p className="ds-note">No login account was created for this deployment.</p>
              )}

              {failed && (job.errorUserMessage || job.error) && (
                <div className="ds-section">
                  <div className="ds-section-title">What went wrong</div>
                  <p className="ds-error-user">{job.errorUserMessage || job.message}</p>
                  {(job.errorDetail || job.error) && (
                    <pre className="ds-error">{job.errorDetail || job.error}</pre>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
