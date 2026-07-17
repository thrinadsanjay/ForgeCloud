import { listJobsRaw, archiveJob, purgeJob, isTerminalJob } from "./jobStore.js";
import {
  listRequestsRaw,
  archiveRequest,
  purgeRequest,
  isTerminalRequest,
} from "./requestStore.js";

const ARCHIVE_AFTER_MS = Number(process.env.DEPLOYMENT_ARCHIVE_AFTER_MS || 7 * 24 * 60 * 60 * 1000);
const PURGE_AFTER_MS = Number(process.env.DEPLOYMENT_PURGE_AFTER_MS || 365 * 24 * 60 * 60 * 1000);
const CHECK_INTERVAL_MS = Number(process.env.DEPLOYMENT_ARCHIVE_INTERVAL_MS || 15 * 60 * 1000);

function ageMs(iso) {
  if (!iso) return 0;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? Date.now() - t : 0;
}

/**
 * Soft-archive terminal deployments after 7 days; hard-delete archived ones after 1 year.
 */
export async function sweepDeployments() {
  let archived = 0;
  let purged = 0;

  for (const job of listJobsRaw()) {
    if (job.archivedAt) {
      if (ageMs(job.archivedAt) >= PURGE_AFTER_MS) {
        await purgeJob(job.id);
        purged += 1;
      }
      continue;
    }
    if (isTerminalJob(job) && ageMs(job.updatedAt || job.createdAt) >= ARCHIVE_AFTER_MS) {
      archiveJob(job.id);
      archived += 1;
    }
  }

  for (const req of listRequestsRaw()) {
    if (req.archivedAt) {
      if (ageMs(req.archivedAt) >= PURGE_AFTER_MS) {
        await purgeRequest(req.id);
        purged += 1;
      }
      continue;
    }
    if (isTerminalRequest(req) && ageMs(req.updatedAt || req.createdAt) >= ARCHIVE_AFTER_MS) {
      archiveRequest(req.id);
      archived += 1;
    }
  }

  if (archived || purged) {
    console.log(`[archiveEnforcer] archived=${archived} purged=${purged}`);
  }
}

export function startArchiveEnforcer() {
  setTimeout(() => sweepDeployments().catch((e) => console.error("[archiveEnforcer]", e.message)), 20_000);
  const timer = setInterval(
    () => sweepDeployments().catch((e) => console.error("[archiveEnforcer]", e.message)),
    CHECK_INTERVAL_MS
  );
  timer.unref?.();
  console.log(
    `Archive enforcer running (archive after ${Math.round(ARCHIVE_AFTER_MS / 86400000)}d, purge after ${Math.round(PURGE_AFTER_MS / 86400000)}d)`
  );
  return timer;
}
