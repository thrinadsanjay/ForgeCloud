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
    createdAt: data.createdAt || row.createdAt.toISOString(),
    updatedAt: data.updatedAt || row.updatedAt.toISOString(),
  };
}

export async function hydrateJobs() {
  const rows = await prisma.deploymentJob.findMany();
  let changed = false;
  for (const row of rows) {
    const j = rowToJob(row);
    if (j.status !== "ready" && j.status !== "failed" && j.status !== "cancelled") {
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

export function listJobs() {
  const arr = Array.from(jobs.values());
  arr.forEach(enforceTimeout);
  return arr
    .map((j) => enrichJob(annotate(j)))
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}
