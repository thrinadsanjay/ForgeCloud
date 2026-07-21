import * as pve from "./proxmoxService.js";
import { peekJob, updateJob, isTerminalJob, resetJobForRetry, archiveSiblingFailedJobs } from "./jobStore.js";
import { removeOwner } from "./ownershipStore.js";
import { removeExpiry } from "./expiryStore.js";
import { onProvisioningCancelled, onProvisioningRolledBack } from "./snowLifecycle.js";
import { bumpRequestForJobRetry } from "./requestStore.js";
import { runVmJob, runContainerJob, runStackJob, runInternalJob } from "./provisioner.js";
import { VM_STEP_DEFS, vmStepIndex } from "./deploymentSteps.js";

const JOB_PAYLOAD_META = new Set([
  "requestedBy",
  "requestId",
  "autoApproved",
  "approvedBy",
  "_resume",
]);

function provisionPayloadFromJob(job) {
  const raw = job?.payload || {};
  const out = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!JOB_PAYLOAD_META.has(key)) out[key] = value;
  }
  return out;
}

/** First failed VM pipeline step, or null. */
export function findFailedVmStep(job) {
  const steps = Array.isArray(job?.steps) ? job.steps : [];
  const failed = steps.find((s) => s.state === "failed");
  if (failed?.key && vmStepIndex(failed.key) >= 0) return failed.key;
  // Fall back: first step that was active when the job died (left as failed/active).
  const active = steps.find((s) => s.state === "active");
  if (active?.key && vmStepIndex(active.key) >= 0) return active.key;
  return null;
}

/**
 * Whether a failed VM job can resume on the existing guest instead of recloning.
 * Requires a registered VMID and a failed step at or after provision_vm.
 */
export function getVmResumeContext(job) {
  if (!job || job.type !== "vm") return null;
  const resource = (job.resources || []).find((r) => Number.isFinite(Number(r.vmid)));
  if (!resource) return null;
  const fromStep = findFailedVmStep(job);
  if (!fromStep) return null;
  // If clone never finished, nothing to resume on.
  if (fromStep === "provision_vm" && !resource.vmid) return null;
  const idx = vmStepIndex(fromStep);
  if (idx < vmStepIndex("provision_vm")) return null;
  const label = VM_STEP_DEFS.find((d) => d.key === fromStep)?.label || fromStep;
  return {
    canResume: true,
    vmid: Number(resource.vmid),
    fromStep,
    fromLabel: label,
    ip: resource.ip || null,
    hostname: resource.hostname || job.payload?.hostname || null,
    generatedPassword: job.result?.generatedPassword || null,
  };
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
    const type = r.type === "container" ? "container" : "vm";
    try {
      if (type === "container") await pve.deleteContainer({ vmid });
      else await pve.deleteVm({ vmid });
      removeOwner(vmid);
      removeExpiry(vmid);
      results.push({ vmid, type, ok: true });
    } catch (err) {
      results.push({ vmid, type, ok: false, error: err.message });
    }
  }
  return results;
}

export async function rollbackFailedJob(jobId, { actor, reason } = {}) {
  const job = peekJob(jobId);
  if (!job) return null;

  if (job.status === "rolled_back") {
    return { job, alreadyRolledBack: true, destroyResults: [] };
  }

  if (job.status !== "failed") {
    const err = new Error("Rollback is only available for failed deployments");
    err.status = 400;
    throw err;
  }

  const resources = Array.isArray(job.resources) ? job.resources.filter((r) => Number.isFinite(Number(r.vmid))) : [];
  if (!resources.length) {
    const err = new Error("No leftover guests to roll back");
    err.status = 400;
    throw err;
  }

  const destroyResults = await destroyJobResources(job);
  const orphans = destroyResults.filter((r) => !r.ok);
  const destroyed = destroyResults.filter((r) => r.ok).map((r) => r.vmid);
  const rollbackReason = reason
    || `Rolled back by ${actor || "user"}`;

  updateJob(jobId, {
    status: "rolled_back",
    message: orphans.length
      ? `${rollbackReason}. Destroyed: ${destroyed.join(", ") || "none"}. Failed cleanup: ${orphans.map((r) => r.vmid).join(", ")}.`
      : `${rollbackReason}. Destroyed VMID(s): ${destroyed.join(", ")}.`,
    rolledBackBy: actor || null,
    rolledBackAt: new Date().toISOString(),
    rollbackCleanup: destroyResults,
  });

  try {
    await onProvisioningRolledBack(peekJob(jobId) || job, {
      reason: rollbackReason,
      destroyResults,
    });
  } catch (err) {
    console.warn(`[rollback] SNOW hook failed: ${err.message}`);
  }

  return {
    job: peekJob(jobId),
    alreadyRolledBack: false,
    destroyResults,
  };
}

function startRunnerForJob(job) {
  const payload = { ...(job.payload || {}) };
  delete payload._resume;
  if (job.type === "internal") {
    runInternalJob(job.id, payload);
  } else if (job.type === "vm") {
    runVmJob(job.id, payload);
  } else if (job.type === "container") {
    runContainerJob(job.id, payload);
  } else {
    runStackJob(job.id, payload);
  }
}

/**
 * Retry a failed deployment.
 * Prefer resuming from the failed step when the guest still exists (VM jobs).
 * Otherwise clean up leftovers and re-run the same job id (no duplicate Deployments row).
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
  const resume = getVmResumeContext(job);

  // --- Resume path: keep guest, continue from failed step ---
  if (resume?.canResume) {
    // Confirm the guest still exists on Proxmox.
    const st = await pve.getVmStatus({ vmid: resume.vmid }).catch(() => null);
    if (st) {
      const payload = {
        ...job.payload,
        _resume: {
          vmid: resume.vmid,
          fromStep: resume.fromStep,
          ip: resume.ip,
          hostname: resume.hostname,
          generatedPassword: resume.generatedPassword,
        },
      };
      const retryCount = Number(job.retryCount || 0) + 1;
      updateJob(jobId, {
        status: "provisioning",
        message: `Resuming from "${resume.fromLabel}" on VM #${resume.vmid}…`,
        error: null,
        errorUserMessage: null,
        errorDetail: null,
        proxmoxUpid: null,
        payload,
        retryCount,
        retriedBy: actor || null,
        retriedAt: new Date().toISOString(),
        retryNote: retryReason,
        resumedFromStep: resume.fromStep,
      });
      archiveSiblingFailedJobs(peekJob(jobId));
      if (job.payload?.requestId) bumpRequestForJobRetry(job.payload.requestId);
      setImmediate(() => {
        runVmJob(jobId, payload).catch((err) => {
          console.error(`[retry] resume job ${jobId} crashed: ${err.message}`);
        });
      });
      return {
        sourceJob: peekJob(jobId),
        request: null,
        job: peekJob(jobId),
        resumed: true,
        sameJob: true,
        resumeFrom: resume.fromStep,
        resumeLabel: resume.fromLabel,
        vmid: resume.vmid,
        cleanup: { attempted: false, rolledBack: false, destroyResults: [], skipped: "resumed existing guest" },
        heldForApproval: false,
      };
    }
    console.warn(`[retry] VM ${resume.vmid} gone from Proxmox — falling back to full re-provision`);
  }

  // --- Full retry on the same job id: destroy leftovers, then re-run ---
  let cleanup = { attempted: false, rolledBack: false, destroyResults: [], skipped: null };

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
    } else if (err.status === 400 && /only available for failed/i.test(err.message || "")) {
      // Already cleaned / status odd — continue with re-run.
      cleanup.skipped = err.message;
    } else {
      throw err;
    }
  }

  // rollbackFailedJob marks the job rolled_back — put it back to failed briefly is wrong;
  // resetJobForRetry expects failed. Allow reset from rolled_back after cleanup.
  const current = peekJob(jobId);
  if (current && current.status === "rolled_back") {
    current.status = "failed";
  }

  resetJobForRetry(jobId, {
    actor,
    reason: `${retryReason} — rebuilding from the start`,
    keepResources: false,
  });
  updateJob(jobId, {
    status: "provisioning",
    message: "Retrying from the beginning…",
  });
  archiveSiblingFailedJobs(peekJob(jobId));

  const refreshed = peekJob(jobId);
  if (refreshed?.payload?.requestId) {
    bumpRequestForJobRetry(refreshed.payload.requestId);
  }

  setImmediate(() => {
    try {
      startRunnerForJob(peekJob(jobId));
    } catch (err) {
      console.error(`[retry] full re-run job ${jobId} crashed: ${err.message}`);
      updateJob(jobId, {
        status: "failed",
        message: "Retry failed to start",
        error: err.message,
      });
    }
  });

  return {
    sourceJob: peekJob(jobId),
    request: null,
    job: peekJob(jobId),
    resumed: false,
    sameJob: true,
    cleanup,
    heldForApproval: false,
  };
}
