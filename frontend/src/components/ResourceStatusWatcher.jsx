import { useEffect, useRef } from "react";
import { getResources } from "../api/client.js";
import { useToast } from "./ToastProvider.jsx";
import { enqueueToastDigest } from "../lib/toastDigest.js";

const POLL_MS = 12000;
const SUPPRESS_MS = 90_000;

/**
 * Detect unexpected VM / LXC status changes.
 * Status flaps are batched into a single digest toast.
 */
export default function ResourceStatusWatcher() {
  const { toast } = useToast();
  const prev = useRef(null);
  const suppressUntil = useRef(new Map());
  const pauseUntil = useRef(0);
  const degradeStreak = useRef(0);

  useEffect(() => {
    const onAction = (ev) => {
      const vmid = Number(ev.detail?.vmid);
      if (!vmid) return;
      suppressUntil.current.set(vmid, Date.now() + SUPPRESS_MS);
    };
    const onPause = (ev) => {
      const ms = Number(ev.detail?.ms);
      pauseUntil.current = Date.now() + (Number.isFinite(ms) && ms > 0 ? ms : 90_000);
    };
    window.addEventListener("forge:resource-action", onAction);
    window.addEventListener("forge:pause-resource-watch", onPause);
    return () => {
      window.removeEventListener("forge:resource-action", onAction);
      window.removeEventListener("forge:pause-resource-watch", onPause);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    let timer;

    const digest = (tone, title, message) => {
      enqueueToastDigest(toast, {
        key: "resource-status",
        tone,
        title,
        message,
        href: "/resources?tab=compute",
        flushMs: 10_000,
      });
    };

    const poll = async () => {
      try {
        if (Date.now() < pauseUntil.current) {
          timer = setTimeout(poll, POLL_MS);
          return;
        }

        const rows = await getResources();
        if (cancelled || !Array.isArray(rows)) return;

        const next = new Map();
        for (const r of rows) {
          next.set(r.vmid, {
            status: (r.status || "").toLowerCase(),
            name: r.name || `VMID ${r.vmid}`,
            type: r.type === "container" ? "Container" : "VM",
          });
        }

        if (prev.current === null) {
          prev.current = next;
          degradeStreak.current = 0;
        } else {
          const prevSize = prev.current.size;
          const looksDegraded = prevSize > 0 && (
            next.size === 0
            || (prevSize >= 2 && next.size < Math.ceil(prevSize * 0.5))
          );
          if (looksDegraded) {
            degradeStreak.current += 1;
            if (degradeStreak.current < 2) {
              timer = setTimeout(poll, POLL_MS);
              return;
            }
          } else {
            degradeStreak.current = 0;
          }

          for (const [vmid, cur] of next) {
            const before = prev.current.get(vmid);
            if (!before) continue;
            if (before.status === cur.status) continue;
            const until = suppressUntil.current.get(vmid) || 0;
            if (Date.now() < until) continue;

            const label = `${cur.type} ${cur.name}`;
            if (before.status === "running" && cur.status === "stopped") {
              digest("warn", `${label} stopped`, `${label} is no longer running.`);
            } else if (before.status === "running" && !["running", "stopped"].includes(cur.status)) {
              digest("error", `${label} status changed`, `${label} went from running to "${cur.status}".`);
            } else if (before.status === "stopped" && cur.status === "running") {
              digest("info", `${label} started`, `${label} is running again.`);
            } else if (before.status === "running" && cur.status !== "running") {
              digest("warn", `${label} status: ${cur.status}`, `${label} changed from ${before.status} → ${cur.status}.`);
            }
          }

          if (!looksDegraded) {
            for (const [vmid, before] of prev.current) {
              if (next.has(vmid)) continue;
              const until = suppressUntil.current.get(vmid) || 0;
              if (Date.now() < until) continue;
              digest("warn", `${before.type} ${before.name} removed`, `${before.type} ${before.name} (VMID ${vmid}) is no longer in inventory.`);
            }
            prev.current = next;
          }
        }
      } catch {
        /* transient */
      }
      timer = setTimeout(poll, POLL_MS);
    };

    poll();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [toast]);

  return null;
}
