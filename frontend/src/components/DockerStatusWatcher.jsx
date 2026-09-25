import { useEffect, useRef } from "react";
import { listDockerProjects } from "../api/client.js";
import { useToast } from "./ToastProvider.jsx";
import { enqueueToastDigest } from "../lib/toastDigest.js";

const POLL_MS = 20000;
const SUPPRESS_MS = 90_000;

function flatContainers(rows) {
  const map = new Map();
  for (const row of rows || []) {
    const hostId = row.host?.id;
    const hostName = row.host?.name || hostId || "Docker";
    for (const p of row.projects || []) {
      for (const c of p.containers || []) {
        const key = `${hostId}:${c.id}`;
        map.set(key, {
          hostId,
          hostName,
          project: p.name,
          id: c.id,
          name: c.name || c.id?.slice?.(0, 12) || "container",
          state: (c.state || "").toLowerCase(),
        });
      }
    }
  }
  return map;
}

/**
 * Watch Compose containers for crash (running→exited/dead) or removal.
 * Suppresses noise after `forge:docker-action` events.
 * Status flaps are batched into a digest toast.
 */
export default function DockerStatusWatcher() {
  const { toast } = useToast();
  const prev = useRef(null);
  const suppressUntil = useRef(new Map());

  useEffect(() => {
    const onAction = (ev) => {
      const key = ev.detail?.key;
      if (!key) return;
      suppressUntil.current.set(key, Date.now() + SUPPRESS_MS);
    };
    window.addEventListener("forge:docker-action", onAction);
    return () => window.removeEventListener("forge:docker-action", onAction);
  }, []);

  useEffect(() => {
    let cancelled = false;
    let timer;

    const digest = (tone, title, message) => {
      enqueueToastDigest(toast, {
        key: "docker-status",
        tone,
        title,
        message,
        href: "/resources?tab=docker",
        flushMs: 10_000,
      });
    };

    const poll = async () => {
      try {
        const rows = await listDockerProjects();
        if (cancelled) return;
        const next = flatContainers(rows);

        if (prev.current === null) {
          prev.current = next;
        } else {
          for (const [key, cur] of next) {
            const before = prev.current.get(key);
            if (!before) continue;
            if (before.state === cur.state) continue;
            if (Date.now() < (suppressUntil.current.get(key) || 0)) continue;

            const label = `${cur.name} @ ${cur.hostName}`;
            if (before.state === "running" && (cur.state === "exited" || cur.state === "dead" || cur.state === "oomkilled")) {
              digest("error", `Container crashed — ${cur.name}`, `${label} (${cur.project}) is ${cur.state}.`);
            } else if (before.state === "running" && cur.state !== "running") {
              digest("warn", `Container stopped — ${cur.name}`, `${label} is now ${cur.state}.`);
            }
          }

          for (const [key, before] of prev.current) {
            if (next.has(key)) continue;
            if (Date.now() < (suppressUntil.current.get(key) || 0)) continue;
            digest("warn", `Container removed — ${before.name}`, `${before.name} @ ${before.hostName} (${before.project}) is no longer present.`);
          }

          prev.current = next;
        }
      } catch {
        /* host unreachable / no docker — skip quietly */
      }
      timer = setTimeout(poll, POLL_MS);
    };

    poll();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [toast]);

  return null;
}
