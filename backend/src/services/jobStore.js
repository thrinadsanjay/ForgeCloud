import { nanoid } from "nanoid";
import { prisma, fireAndForget } from "../db/client.js";
import { setOwner } from "./ownershipStore.js";
import { setDefaultExpiry } from "./expiryStore.js";
import { onProvisioningComplete, onProvisioningFailed, enrichJob } from "./snowLifecycle.js";

const MAX_JOBS = Number(process.env.MAX_JOBS_HISTORY || 1000);
const jobs = new Map();

function rowToJob(row) {
  const data = row.data || {};
  return {
    ...data,
    id: row.id,
    type: row.type,
    status: row.status,
    // Stash JSON status so hydrate can recover rolled_back if the column was overwritten.
    dataStatus: data.status || null,
    createdAt: data.createdAt || row.createdAt?.toISOString?.() || row.createdAt,
    updatedAt: data.updatedAt || row.updatedAt?.toISOString?.() || row.updatedAt,
  };
}

/** Statuses that must survive process restart (not rewritten as Interrupted). */
const TERMINAL_ON_HYDRATE = new Set(["ready", "failed", "cancelled", "rolled_back"]);

export async function hydrateJobs() {
  const rows = await prisma.deploymentJob.findMany();
  let changed = false;
  for (const row of rows) {
    const j = rowToJob(row);
    // Prefer status embedded in JSON if the column was out of sync (legacy rows).
    if (j.dataStatus && TERMINAL_ON_HYDRATE.has(j.dataStatus) && j.status !== j.dataStatus) {
      j.status = j.dataStatus;
      changed = true;
    }
    delete j.dataStatus;
    // Heal jobs previously corrupted by hydrate rewriting rolled_back → failed.
    if (j.status === "failed" && j.rolledBackAt) {
      j.status = "rolled_back";
      if (j.error && /Interrupted by a server restart/i.test(j.error)) {
        j.error = null;
        j.message = j.message && !/Interrupted/i.test(j.message)
          ? j.message
          : `Rolled back${j.rolledBackBy ? ` by ${j.rolledBackBy}` : ""}`;
      }
      changed = true;
    }
    if (!TERMINAL_ON_HYDRATE.has(j.status)) {
      const ts = new Date().toISOString();
      j.status = "failed";
      j.message = "Interrupted";
      j.error = "Interrupted by a server restart before completion";
      j.updatedAt = ts;
      if (!Array.isArray(j.logs)) j.logs = [];
      j.logs.push({ ts, status: "failed", message: j.error, error: j.error });
      changed = true;
    }
    jobs.set(j.id, j);
  }
  if (changed) await persistAll();
}

async function persistJob(job) {
  await prisma.deploymentJob.upsert({
    where: { id: job.id },
    create: {
      id: job.id,
      type: job.type,
      status: job.status,
      data: job,
      createdAt: new Date(job.createdAt),
      updatedAt: new Date(job.updatedAt),
    },
    update: {
      type: job.type,
      status: job.status,
      data: job,
      updatedAt: new Date(job.updatedAt),
    },
  });
}

function persist() {
  if (jobs.size > MAX_JOBS) {
    const ordered = Array.from(jobs.values()).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    for (const stale of ordered.slice(MAX_JOBS)) jobs.delete(stale.id);
  }
  fireAndForget(Promise.all(Array.from(jobs.values()).map(persistJob)), "jobs");
}

async function persistAll() {
  if (jobs.size > MAX_JOBS) {
    const ordered = Array.from(jobs.values()).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    for (const stale of ordered.slice(MAX_JOBS)) jobs.delete(stale.id);
  }
  await Promise.all(Array.from(jobs.values()).map(persistJob));
}

export function createJob(type, payload) {
  const id = nanoid(10);
  const now = new Date().toISOString();
  const job = {
    id,
    type,
    payload,
    status: "pending",
    message: "Queued",
    resources: [],
    error: null,
    logs: [{ ts: now, status: "pending", message: "Queued" }],
    createdAt: now,
    updatedAt: now,
  };
  jobs.set(id, job);
  persist();
  return job;
}

export function peekJob(id) {
  return jobs.get(id) || null;
}

export function updateJob(id, patch) {
  const job = jobs.get(id);
  if (!job) return null;

  const prevStatus = job.status;
  const prevMessage = job.message;
  Object.assign(job, patch, { updatedAt: new Date().toISOString() });

  const statusChanged = patch.status !== undefined && patch.status !== prevStatus;
  const messageChanged = patch.message !== undefined && patch.message !== prevMessage;
  if (statusChanged || messageChanged || patch.error) {
    if (!Array.isArray(job.logs)) job.logs = [];
    job.logs.push({
      ts: new Date().toISOString(),
      status: job.status,
      message: patch.message || job.message,
      ...(patch.error ? { error: patch.error } : {}),
    });
  }

  if (patch.status === "failed" && prevStatus !== "failed") {
    job.failureCount = Number(job.failureCount || 0) + 1;
  }

  if (patch.status === "failed" && prevStatus !== "failed" && !job.incident) {
    Promise.resolve(onProvisioningFailed(job)).then((incident) => {
      if (!incident) return;
      job.incident = incident;
      if (!Array.isArray(job.logs)) job.logs = [];
      job.logs.push({
        ts: new Date().toISOString(),
        status: "failed",
        message: `ServiceNow incident ${incident.number} raised for this failure.`,
      });
      persist();
    }).catch((err) => console.warn(`[snow] failure hook error: ${err.message}`));
  }

  if (patch.status === "ready" && prevStatus !== "ready") {
    Promise.resolve(onProvisioningComplete(job)).catch((err) => {
      console.warn(`[snow] complete hook error: ${err.message}`);
    });
    // Collapse earlier failed attempts for the same hostname into Archived.
    archiveSiblingFailedJobs(job);
  }

  const owner = job.payload?.requestedBy;
  if (owner && Array.isArray(job.resources)) {
    for (const r of job.resources) {
      if (r.vmid) {
        setOwner(r.vmid, { username: owner, hostname: r.hostname });
        if (!job.payload?.permanent) {
          setDefaultExpiry(r.vmid, { setBy: owner, ttlDays: job.payload?.ttlDays, type: r.type });
        }
      }
    }
  }

  persist();
  return job;
}

const STUCK_TIMEOUT_MS = Number(process.env.JOB_STUCK_TIMEOUT_MS || 30 * 60 * 1000);

function isAccessible(job) {
  const res = job.resources || [];
  return res.length > 0 && res.every((r) => r.sshReady);
}

export function categoryOf(job) {
  if (job.archivedAt) return "archived";
  if (job.status === "failed") return "failed";
  if (job.status === "cancelled" || job.status === "rolled_back") return "cancelled";
  if (job.status === "ready") return isAccessible(job) ? "successful" : "pending";
  return "running";
}

export function isTerminalJob(job) {
  return ["ready", "failed", "cancelled", "rolled_back"].includes(job?.status);
}

/** Throw if the job was cancelled mid-flight (cooperative abort). */
export function assertJobNotCancelled(jobId) {
  const job = jobs.get(jobId);
  if (job?.status === "cancelled") {
    const err = new Error("Deployment cancelled");
    err.cancelled = true;
    throw err;
  }
}

/** In-memory jobs without enrich/timeout side effects (for enforcers). */
export function listJobsRaw() {
  return Array.from(jobs.values());
}

export function archiveJob(id) {
  const job = jobs.get(id);
  if (!job || job.archivedAt) return job || null;
  job.archivedAt = new Date().toISOString();
  job.updatedAt = job.archivedAt;
  persist();
  return job;
}

/** Archive older failed/cancelled jobs that share hostname (+ owner) with `job`. */
export function archiveSiblingFailedJobs(job) {
  if (!job) return 0;
  const hostname = job.payload?.hostname || job.resources?.[0]?.hostname;
  if (!hostname) return 0;
  const owner = job.payload?.requestedBy || null;
  let n = 0;
  for (const other of jobs.values()) {
    if (other.id === job.id || other.archivedAt) continue;
    if (other.status !== "failed" && other.status !== "cancelled" && other.status !== "rolled_back") continue;
    const otherHost = other.payload?.hostname || other.resources?.[0]?.hostname;
    if (otherHost !== hostname) continue;
    if (owner && other.payload?.requestedBy && other.payload.requestedBy !== owner) continue;
    other.archivedAt = new Date().toISOString();
    other.updatedAt = other.archivedAt;
    other.supersededByJobId = job.id;
    n += 1;
  }
  if (n) persist();
  return n;
}

/**
 * Reset a failed job so the same deployment id can be retried in place
 * (no duplicate row in Deployments).
 */
export function resetJobForRetry(id, { actor, reason, keepResources = false } = {}) {
  const job = jobs.get(id);
  if (!job) return null;
  const now = new Date().toISOString();
  const retryCount = Number(job.retryCount || 0) + 1;
  const nextPayload = { ...(job.payload || {}) };
  delete nextPayload._resume;

  Object.assign(job, {
    status: "pending",
    message: reason || `Retry #${retryCount} queued`,
    error: null,
    errorUserMessage: null,
    errorDetail: null,
    proxmoxUpid: null,
    incident: keepResources ? job.incident : null,
    steps: [],
    resources: keepResources ? (job.resources || []) : [],
    result: keepResources ? job.result : null,
    payload: nextPayload,
    retryCount,
    failureCount: Number(job.failureCount || 0),
    retriedBy: actor || null,
    retriedAt: now,
    retryNote: reason || null,
    resumedFromStep: null,
    retriedToJobId: null,
    retriedToRequestId: null,
    updatedAt: now,
  });
  if (!Array.isArray(job.logs)) job.logs = [];
  job.logs.push({
    ts: now,
    status: "pending",
    message: reason || `Retry #${retryCount} queued`,
  });
  persist();
  return job;
}

export async function purgeJob(id) {
  jobs.delete(id);
  try {
    await prisma.deploymentJob.delete({ where: { id } });
  } catch {
    /* already gone */
  }
}

function enforceTimeout(job) {
  if (job.status === "ready" || job.status === "failed" || job.status === "cancelled" || job.status === "rolled_back" || job.archivedAt) return;
  const stale = Date.now() - new Date(job.updatedAt).getTime();
  if (stale > STUCK_TIMEOUT_MS) {
    updateJob(job.id, {
      status: "failed",
      message: "Timed out",
      error: `Timed out — stuck at "${job.message}" for over ${Math.round(STUCK_TIMEOUT_MS / 60000)} minutes`,
    });
  }
}

function annotate(job) {
  return { ...job, category: categoryOf(job) };
}

export function getJob(id) {
  const job = jobs.get(id);
  if (!job) return undefined;
  enforceTimeout(job);
  return enrichJob(annotate(job));
}

/** Prefer one live row per hostname: archive older failed/cancelled siblings. */
function collapseDuplicateFailedHostnames() {
  const groups = new Map();
  for (const j of jobs.values()) {
    if (j.archivedAt || j.retriedToJobId) continue;
    const host = j.payload?.hostname || j.resources?.[0]?.hostname;
    if (!host) continue;
    const key = `${j.type || ""}|${j.payload?.requestedBy || ""}|${host}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(j);
  }
  let changed = false;
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    list.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    const ready = list.find((j) => j.status === "ready");
    const running = list.find((j) => !["ready", "failed", "cancelled", "rolled_back"].includes(j.status));
    const winner = ready || running || list[0];
    let extraFails = 0;
    for (const j of list) {
      if (j.id === winner.id) continue;
      if (!["failed", "cancelled", "rolled_back"].includes(j.status)) continue;
      extraFails += Math.max(1, Number(j.failureCount || 0));
      j.archivedAt = new Date().toISOString();
      j.updatedAt = j.archivedAt;
      j.supersededByJobId = winner.id;
      changed = true;
    }
    if (extraFails) {
      winner.failureCount = Number(winner.failureCount || 0) + extraFails;
      if (winner.status === "failed" && !winner.failureCount) winner.failureCount = 1;
      changed = true;
    }
  }
  return changed;
}

export function listJobs() {
  if (collapseDuplicateFailedHostnames()) persist();
  const arr = Array.from(jobs.values());
  arr.forEach(enforceTimeout);
  return arr
    .filter((j) => !j.retriedToJobId)
    .map((j) => {
      const annotated = enrichJob(annotate(j));
      // Legacy failed jobs may lack failureCount — treat as at least one failure.
      if (annotated.status === "failed" && !annotated.failureCount) {
        annotated.failureCount = 1;
      }
      return annotated;
    })
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}
