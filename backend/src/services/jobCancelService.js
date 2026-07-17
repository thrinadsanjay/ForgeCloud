import * as pve from "./proxmoxService.js";
import { peekJob, updateJob, isTerminalJob } from "./jobStore.js";
import { removeOwner } from "./ownershipStore.js";
import { removeExpiry } from "./expiryStore.js";
import { onProvisioningCancelled, onProvisioningRolledBack } from "./snowLifecycle.js";
import { submitProvisionRequest } from "./requestStore.js";

const JOB_PAYLOAD_META = new Set([
  "requestedBy",
  "requestId",
  "autoApproved",
  "approvedBy",
]);

function provisionPayloadFromJob(job) {
  const raw = job?.payload || {};
  const out = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!JOB_PAYLOAD_META.has(key)) out[key] = value;
  }
  return out;
}

/**
 * Stop an in-flight deployment: mark cancelled, destroy incomplete guests,
 * clear ownership/expiry, and notify ServiceNow.
 * Caller should also mark the linked provision request cancelled when applicable.
 */
export async function cancelDeploymentJob(jobId, { actor, reason } = {}) {
  const job = peekJob(jobId);
  if (!job) return null;

  if (isTerminalJob(job)) {
    return {
      job,
      alreadyTerminal: true,
      destroyResults: [],
    };
  }

  const cancelReason = reason || `Stopped by ${actor || "user"}`;
  updateJob(jobId, {
    status: "cancelled",
    message: cancelReason,
    cancelledBy: actor || null,
    cancelledAt: new Date().toISOString(),
  });

  const destroyResults = await destroyJobResources(job);
  const orphans = destroyResults.filter((r) => !r.ok);
  if (orphans.length) {
    updateJob(jobId, {
      message: `${cancelReason} — ${orphans.length} resource(s) could not be destroyed (admin cleanup may be needed).`,
      cancelCleanup: destroyResults,
    });
  } else if (destroyResults.length) {
    updateJob(jobId, {
      message: `${cancelReason} — incomplete resource(s) destroyed.`,
      cancelCleanup: destroyResults,
    });
  }

  try {
    await onProvisioningCancelled(peekJob(jobId) || job, {
      reason: cancelReason,
      destroyResults,
    });
  } catch (err) {
    console.warn(`[cancel] SNOW hook failed: ${err.message}`);
  }

  return {
    job: peekJob(jobId),
    alreadyTerminal: false,
    destroyResults,
  };
}

export async function destroyJobResources(job) {
  const results = [];
  const resources = Array.isArray(job?.resources) ? job.resources : [];
  for (const r of resources) {
    const vmid = Number(r.vmid);
    if (!Number.isFinite(vmid)) continue;
    try {
      if (r.type === "container") await pve.deleteContainer({ vmid });
      else await pve.deleteVm({ vmid });
      removeOwner(vmid);
      removeExpiry(vmid);
      results.push({ vmid, type: r.type || "vm", ok: true });
    } catch (err) {
      results.push({ vmid, type: r.type || "vm", ok: false, error: err.message });
    }
  }
  return results;
}

function guestTargets(job) {
  return (Array.isArray(job?.resources) ? job.resources : [])
    .filter((r) => Number.isFinite(Number(r.vmid)))
    .map((r) => ({
      vmid: Number(r.vmid),
      type: r.type || "vm",
      hostname: r.hostname || null,
    }));
}

/**
 * Undo a failed deployment: destroy leftover guests on job.resources.
 * Only allowed when status === "failed" (not successful / cancelled).
 */
export async function rollbackFailedJob(jobId, { actor, reason } = {}) {
  const job = peekJob(jobId);
  if (!job) return null;

  if (job.status === "rolled_back") {
    return { job, alreadyRolledBack: true, destroyResults: [], targets: [] };
  }

  if (job.status !== "failed") {
    const err = new Error("Rollback is only available for failed deployments");
    err.status = 400;
    throw err;
  }

  const targets = guestTargets(job);
  if (!targets.length) {
    const err = new Error("No leftover VMs or containers to roll back on this job");
    err.status = 400;
    throw err;
  }

  const rollbackReason = reason
    || `Rolled back by ${actor || "user"} — destroyed leftover resource(s) after failure`;

  const destroyResults = await destroyJobResources(job);
  const orphans = destroyResults.filter((r) => !r.ok);
  const destroyed = destroyResults.filter((r) => r.ok).map((r) => r.vmid);
  const remaining = (Array.isArray(job.resources) ? job.resources : []).filter((r) =>
    orphans.some((o) => o.vmid === Number(r.vmid))
  );

  updateJob(jobId, {
    status: "rolled_back",
    message: orphans.length
      ? `${rollbackReason}. Destroyed: ${destroyed.join(", ") || "none"}. Failed cleanup: ${orphans.map((r) => r.vmid).join(", ")}.`
      : `${rollbackReason}. Destroyed VMID(s): ${destroyed.join(", ")}.`,
    rolledBackBy: actor || null,
    rolledBackAt: new Date().toISOString(),
    rollbackCleanup: destroyResults,
    resources: remaining,
  });

  try {
    await onProvisioningRolledBack(peekJob(jobId) || job, {
      reason: rollbackReason,
      destroyResults,
      targets,
    });
  } catch (err) {
    console.warn(`[rollback] SNOW hook failed: ${err.message}`);
  }

  return {
    job: peekJob(jobId),
    alreadyRolledBack: false,
    destroyResults,
    targets,
  };
}

/**
 * Retry a failed deployment: clean up leftover guests (best-effort rollback),
 * then submit a fresh provision request with the same payload.
 */
export async function retryFailedJob(jobId, { actor, reason } = {}) {
  const job = peekJob(jobId);
  if (!job) return null;

  if (job.archivedAt) {
    const err = new Error("Cannot retry an archived deployment");
    err.status = 400;
    throw err;
  }

  if (job.status !== "failed") {
    const err = new Error("Retry is only available for failed deployments");
    err.status = 400;
    throw err;
  }

  const retryReason = reason || `Retried by ${actor || "user"}`;
  let cleanup = { attempted: false, rolledBack: false, destroyResults: [], skipped: null };

  // Best-effort cleanup — ignore "no leftovers" when nothing was created.
  try {
    cleanup.attempted = true;
    const rollback = await rollbackFailedJob(jobId, {
      actor,
      reason: `${retryReason} — cleaning up before retry`,
    });
    cleanup.rolledBack = !rollback?.alreadyRolledBack;
    cleanup.destroyResults = rollback?.destroyResults || [];
  } catch (err) {
    if (err.status === 400 && /no leftover/i.test(err.message || "")) {
      cleanup.skipped = err.message;
    } else {
      throw err;
    }
  }

  const payload = provisionPayloadFromJob(job);
  const requestedBy = job.payload?.requestedBy || actor || "user";
  const result = await submitProvisionRequest({
    kind: job.type,
    payload,
    requestedBy,
    source: "retry",
  });

  updateJob(jobId, {
    retriedBy: actor || null,
    retriedAt: new Date().toISOString(),
    retriedToRequestId: result.request?.id || null,
    retriedToJobId: result.job?.id || null,
    retryNote: retryReason,
  });

  return {
    sourceJob: peekJob(jobId),
    request: result.request,
    job: result.job,
    cleanup,
    heldForApproval: !!result.request?.requiresApproval && result.request?.status === "pending_approval",
  };
}
