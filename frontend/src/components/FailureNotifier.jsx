import { useEffect, useRef, useState } from "react";
import { getJobs } from "../api/client.js";

// Watches deployments and raises a toast when one newly fails, surfacing the
// ServiceNow incident number that the backend auto-created for it.
export default function FailureNotifier() {
  const [toasts, setToasts] = useState([]);
  const seen = useRef(null); // Set of jobIds already handled (null until first poll)

  const dismiss = (id) => setToasts((t) => t.filter((x) => x.id !== id));

  useEffect(() => {
    let cancelled = false;
    let timer;

    const poll = async () => {
      try {
        const jobs = await getJobs();
        if (!cancelled) {
          const failed = jobs.filter((j) => j.status === "failed");
          if (seen.current === null) {
            // First run: remember existing failures so we don't toast history.
            seen.current = new Set(failed.map((j) => j.id));
          } else {
            for (const j of failed) {
              if (seen.current.has(j.id)) continue;
              seen.current.add(j.id);
              const host = j.resources?.[0]?.hostname || j.payload?.hostname || j.payload?.hostnamePrefix || `job ${j.id}`;
              setToasts((t) => [
                ...t,
                {
                  id: j.id,
                  host,
                  ritm: j.servicenow?.ritmNumber || null,
                  ritmUrl: j.servicenow?.ritmUrl || null,
                  incident: j.incident?.number || j.servicenow?.incidentNumber || null,
                  url: j.incident?.url || j.servicenow?.incidentUrl || null,
                  error: j.error || j.message,
                },
              ]);
            }
          }
        }
      } catch {
        /* transient — keep polling */
      }
      timer = setTimeout(poll, 5000);
    };

    poll();
    return () => { cancelled = true; clearTimeout(timer); };
  }, []);

  // Auto-dismiss each toast after 15s.
  useEffect(() => {
    if (toasts.length === 0) return;
    const timers = toasts.map((t) => setTimeout(() => dismiss(t.id), 15000));
    return () => timers.forEach(clearTimeout);
  }, [toasts]);

  if (toasts.length === 0) return null;

  return (
    <div className="toast-stack" role="region" aria-label="Notifications">
      {toasts.map((t) => (
        <div key={t.id} className="toast toast-error" role="alert">
          <div className="toast-icon" aria-hidden="true">⚠</div>
          <div className="toast-body">
            <div className="toast-title">Deployment failed — {t.host}</div>
            {t.ritm && (
              <div className="toast-msg">
                ServiceNow RITM: <span className="toast-incident">{t.ritm}</span>
              </div>
            )}
            {t.incident ? (
              <div className="toast-msg">
                A ServiceNow incident has been raised:{" "}
                <span className="toast-incident">{t.incident}</span>
              </div>
            ) : (
              <div className="toast-msg">{t.error || "Provisioning failed."}</div>
            )}
            {(t.incident || t.ritm) && (
              <div className="toast-actions">
                {t.ritmUrl && (
                  <a className="toast-link" href={t.ritmUrl} target="_blank" rel="noreferrer">View RITM</a>
                )}
                {t.incident && t.url && (
                  <a className="toast-link" href={t.url} target="_blank" rel="noreferrer">View incident</a>
                )}
                {t.incident && (
                  <button className="toast-link" onClick={() => navigator.clipboard?.writeText(t.incident)}>Copy INC</button>
                )}
              </div>
            )}
          </div>
          <button className="toast-close" onClick={() => dismiss(t.id)} aria-label="Dismiss">×</button>
        </div>
      ))}
    </div>
  );
}
