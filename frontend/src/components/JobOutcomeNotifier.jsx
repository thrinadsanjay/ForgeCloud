import { useEffect, useRef } from "react";
import { getJobs } from "../api/client.js";
import { useToast } from "./ToastProvider.jsx";

function jobHost(j) {
  return j.resources?.[0]?.hostname
    || j.payload?.hostname
    || j.payload?.hostnamePrefix
    || `job ${j.id}`;
}

/**
 * Watches deployments and raises success/error toasts when a job newly
 * reaches ready or failed (first poll seeds history so reloads stay quiet).
 */
export default function JobOutcomeNotifier() {
  const { toast } = useToast();
  const seen = useRef(null); // Map jobId -> status

  useEffect(() => {
    let cancelled = false;
    let timer;

    const poll = async () => {
      try {
        const jobs = await getJobs();
        if (cancelled) return;
        const terminal = jobs.filter((j) => j.status === "failed" || j.status === "ready");

        if (seen.current === null) {
          seen.current = new Map(terminal.map((j) => [j.id, j.status]));
        } else {
          for (const j of terminal) {
            const prev = seen.current.get(j.id);
            if (prev === j.status) continue;
            seen.current.set(j.id, j.status);
            // Only toast transitions into terminal (or first sight of a new terminal job).
            if (prev && prev === j.status) continue;

            const host = jobHost(j);
            if (j.status === "ready") {
              const ip = j.result?.ip || j.resources?.[0]?.ip;
              toast({
                tone: "success",
                id: `job-ready-${j.id}`,
                title: `Provisioning complete — ${host}`,
                message: ip
                  ? `"${host}" is ready at ${ip}.`
                  : `"${host}" finished provisioning successfully.`,
                actions: [
                  {
                    key: "view",
                    label: "View deployment",
                    href: `/deployments?tab=completed&job=${encodeURIComponent(j.id)}`,
                  },
                ],
              });
            } else if (j.status === "failed") {
              const ritm = j.servicenow?.ritmNumber || null;
              const ritmUrl = j.servicenow?.ritmUrl || null;
              const incident = j.incident?.number || j.servicenow?.incidentNumber || null;
              const url = j.incident?.url || j.servicenow?.incidentUrl || null;
              const actions = [
                {
                  key: "view",
                  label: "View deployment",
                  href: `/deployments?tab=failed&job=${encodeURIComponent(j.id)}`,
                },
              ];
              if (ritmUrl) actions.push({ key: "ritm", label: "View RITM", href: ritmUrl, external: true });
              if (incident && url) actions.push({ key: "inc", label: "View incident", href: url, external: true });

              toast({
                tone: "error",
                id: `job-fail-${j.id}`,
                title: `Deployment failed — ${host}`,
                message: [
                  ritm ? `ServiceNow RITM: ${ritm}` : null,
                  incident ? `Incident: ${incident}` : null,
                  !ritm && !incident ? (j.error || j.message || "Provisioning failed.") : null,
                ].filter(Boolean).join(" · "),
                actions,
              });
            }
          }
        }
      } catch {
        /* transient */
      }
      timer = setTimeout(poll, 5000);
    };

    poll();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [toast]);

  return null;
}
