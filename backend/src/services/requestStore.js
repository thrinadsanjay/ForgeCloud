import { nanoid } from "nanoid";
import { prisma, fireAndForget } from "../db/client.js";
import { createJob, getJob } from "./jobStore.js";
import { runVmJob, runContainerJob, runStackJob, runInternalJob } from "./provisioner.js";
import * as pve from "./proxmoxService.js";
import { notifyReviewers, notifyUser } from "./notificationStore.js";
import { onRequestSubmitted, onProvisioningStarted, enrichRequest, onRequestApproved, onRequestRejected } from "./snowLifecycle.js";
import { extendExpiry } from "./expiryStore.js";

function targetOf(request) {
  const p = request?.payload || {};
  return p.hostname || p.hostnamePrefix || p.templateId || p.stackId
    || (p.vmid ? `VMID ${p.vmid}` : null) || request?.id;
}

const requests = new Map();

function rowToRequest(row) {
  const data = row.data || {};
  return {
    ...data,
    id: row.id,
    kind: row.kind,
    status: row.status,
    requestedBy: row.requestedBy,
    createdAt: data.createdAt || row.createdAt.toISOString(),
    updatedAt: data.updatedAt || row.updatedAt.toISOString(),
  };
}

export async function hydrateRequests() {
  const rows = await prisma.provisionRequest.findMany();
  for (const row of rows) {
    requests.set(row.id, rowToRequest(row));
  }
}

function persistRequest(request) {
  fireAndForget(
    prisma.provisionRequest.upsert({
      where: { id: request.id },
      create: {
        id: request.id,
        kind: request.kind,
        status: request.status,
        requestedBy: request.requestedBy,
        data: request,
        createdAt: new Date(request.createdAt),
        updatedAt: new Date(request.updatedAt),
      },
      update: {
        kind: request.kind,
        status: request.status,
        requestedBy: request.requestedBy,
        data: request,
        updatedAt: new Date(request.updatedAt),
      },
    }),
    "request"
  );
}

function persist() {
  for (const req of requests.values()) persistRequest(req);
}

/** Read live from process.env — settings apply via applyToEnv(); never freeze at import. */
function approvalPolicy() {
  return {
    cpu: Number(process.env.APPROVAL_CPU_THRESHOLD || 2),
    memoryGB: Number(process.env.APPROVAL_MEMORY_GB_THRESHOLD || 4),
    diskGB: Number(process.env.APPROVAL_DISK_GB_THRESHOLD || 50),
  };
}

function autoApproveEnabled() {
  // Default ON only when unset; explicit "false" enables size-policy holds.
  return process.env.AUTO_APPROVE_DEPLOYMENTS !== "false";
}

function requiresApproval(payload = {}) {
  if (autoApproveEnabled()) return false;
  const policy = approvalPolicy();
  const cpu = Number(payload.cpu || 0);
  const memoryGB = Number(payload.memoryGB || 0);
  // Prefer explicit diskGB; fall back to additional data disk size from the form.
  const diskGB = Number(payload.diskGB || payload.additionalDiskGB || 0);
  return cpu > policy.cpu || memoryGB > policy.memoryGB || diskGB > policy.diskGB;
}

export function resizeNeedsApproval(target = {}) {
  return requiresApproval(target);
}

function buildRequest({ kind, payload, requestedBy, source = "portal", forceApproval = false }) {
  const now = new Date().toISOString();
  // Renew always needs a human reviewer (admin/approver), even when auto-approve
  // is on for size-policy holds.
  const needsApproval = forceApproval || kind === "renew" || requiresApproval(payload);
  const id = nanoid(12);

  const request = {
    id,
    kind,
    payload,
    requestedBy,
    source,
    status: needsApproval ? "pending_approval" : "approved",
    requiresApproval: needsApproval,
    policy: approvalPolicy(),
    approvedBy: null,
    approvedAt: null,
    rejectedBy: null,
    rejectedAt: null,
    rejectionReason: null,
    jobId: null,
    createdAt: now,
    updatedAt: now,
  };

  requests.set(id, request);
  persistRequest(request);
  return request;
}

function runProvisioningForRequest(request) {
  const job = createJob(request.kind, {
    ...request.payload,
    requestedBy: request.requestedBy,
    requestId: request.id,
    autoApproved: !request.requiresApproval,
    approvedBy: request.approvedBy || null,
  });

  onProvisioningStarted(request, job).catch((err) => {
    console.warn(`[snow] provisioning start hook failed: ${err.message}`);
  });

  if (request.kind === "internal") {
    runInternalJob(job.id, job.payload);
  } else if (request.kind === "vm") {
    runVmJob(job.id, job.payload);
  } else if (request.kind === "container") {
    runContainerJob(job.id, job.payload);
  } else {
    runStackJob(job.id, job.payload);
  }

  request.jobId = job.id;
  request.status = "provisioning";
  request.updatedAt = new Date().toISOString();
  persistRequest(request);
  return job;
}

function syncRequestStatus(request) {
  if (!request || !request.jobId) return request;
  const job = getJob(request.jobId);
  if (!job) return request;

  let next;
  if (job.status === "ready") next = "completed";
  else if (job.status === "failed") next = "failed";
  else next = "provisioning";

  if (next !== request.status) {
    request.status = next;
    request.updatedAt = new Date().toISOString();
    persistRequest(request);
  }
  return request;
}

export async function submitProvisionRequest({ kind, payload, requestedBy, source = "portal", forceApproval = false }) {
  const request = buildRequest({ kind, payload, requestedBy, source, forceApproval });

  try {
    await onRequestSubmitted(request);
  } catch (err) {
    console.warn(`[snow] catalog request creation failed: ${err.message}`);
  }

  let job = null;
  if (!request.requiresApproval) {
    job = runProvisioningForRequest(request);
  } else {
    const verb = kind === "resize" ? "resize" : kind === "renew" ? "renew" : "provision";
    const daysNote = kind === "renew" && payload?.days
      ? ` (+${payload.days} days)`
      : "";
    notifyReviewers({
      type: "approval",
      title: `Approval needed — ${targetOf(request)}`,
      message: `${requestedBy} requested to ${verb} ${targetOf(request)}${daysNote}. Review and approve or reject.`,
      link: `/deployments?tab=hold&request=${request.id}`,
      meta: { requestId: request.id, kind },
    });
  }
  return { request: enrichRequest(syncRequestStatus(request)), job };
}

export function listProvisionRequests(user) {
  const all = Array.from(requests.values()).map((r) => enrichRequest(syncRequestStatus(r)));
  // Admins and Deployment Approvers see the full queue; users see only their own.
  const visible = user?.role === "admin" || user?.role === "approver"
    ? all
    : all.filter((r) => r.requestedBy === user.username);
  return visible.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export function getProvisionRequest(id) {
  const req = requests.get(id);
  return enrichRequest(syncRequestStatus(req));
}

/** Mark the linked request as provisioning again after an in-place job retry. */
export function bumpRequestForJobRetry(requestId) {
  if (!requestId) return null;
  const request = requests.get(requestId);
  if (!request) return null;
  request.status = "provisioning";
  request.updatedAt = new Date().toISOString();
  request.error = null;
  persistRequest(request);
  return enrichRequest(request);
}

export async function approveProvisionRequest({ id, approver, source = "portal" } = {}) {
  const request = requests.get(id);
  if (!request) return null;
  if (!request.requiresApproval || request.status !== "pending_approval") {
    return {
      request: enrichRequest(syncRequestStatus(request)),
      job: null,
      alreadyDecided: true,
    };
  }

  request.status = "approved";
  request.approvedBy = approver;
  request.approvedAt = new Date().toISOString();
  request.approvalSource = source;
  request.updatedAt = new Date().toISOString();
  request.rejectedBy = null;
  request.rejectedAt = null;
  request.rejectionReason = null;
  persistRequest(request);

  if (request.kind === "resize") {
    await applyResizeRequest(request);
    return { request: enrichRequest(syncRequestStatus(request)), job: null, alreadyDecided: false };
  }

  if (request.kind === "renew") {
    await applyRenewRequest(request);
    return { request: enrichRequest(syncRequestStatus(request)), job: null, alreadyDecided: false };
  }

  const job = runProvisioningForRequest(request);
  notifyUser(request.requestedBy, {
    type: "approved",
    title: `Request approved — ${targetOf(request)}`,
    message: `Your ${request.kind} request was approved and is now provisioning.`,
    link: job?.id
      ? `/deployments?tab=running&job=${encodeURIComponent(job.id)}`
      : `/deployments?tab=running&request=${encodeURIComponent(request.id)}`,
    meta: { requestId: request.id, jobId: job?.id || null },
  });
  onRequestApproved(request, job);
  return { request: enrichRequest(syncRequestStatus(request)), job, alreadyDecided: false };
}

async function applyRenewRequest(request) {
  const p = request.payload || {};
  try {
    const days = Number(p.days) > 0 ? Number(p.days) : undefined;
    const record = extendExpiry(p.vmid, { days, setBy: request.approvedBy || "approver" });
    request.status = "completed";
    request.expiresAt = record.expiresAt;
    request.updatedAt = new Date().toISOString();
    persistRequest(request);

    notifyUser(request.requestedBy, {
      type: "renew_approved",
      title: `Renewal approved — ${targetOf(request)}`,
      message: `Expiry extended to ${new Date(record.expiresAt).toLocaleDateString()}. You can power the resource on from Resources.`,
      link: "/resources",
      meta: { requestId: request.id, vmid: p.vmid, expiresAt: record.expiresAt },
    });
    onRequestApproved(request, null);
  } catch (err) {
    request.status = "failed";
    request.error = err.message;
    request.updatedAt = new Date().toISOString();
    persistRequest(request);
    notifyUser(request.requestedBy, {
      type: "renew_failed",
      title: `Renewal failed — ${targetOf(request)}`,
      message: err.message,
      link: `/deployments?tab=failed&request=${request.id}`,
      meta: { requestId: request.id },
    });
    throw err;
  }
}

async function applyResizeRequest(request) {
  const p = request.payload || {};
  try {
    const edit = p.type === "container" ? pve.editContainer : pve.editVm;
    const specs = { vmid: p.vmid };
    if (p.cpu != null) specs.cores = Number(p.cpu);
    if (p.memoryGB != null) specs.memory = Number(p.memoryGB) * 1024;
    if (p.diskGB != null && (!p.current?.diskGB || Number(p.diskGB) > Number(p.current.diskGB))) {
      specs.diskGB = Number(p.diskGB);
    }
    await edit(specs);

    request.status = "awaiting_reboot";
    request.updatedAt = new Date().toISOString();
    persistRequest(request);

    notifyUser(request.requestedBy, {
      type: "resize_approved",
      title: `Resize approved — ${targetOf(request)}`,
      message: `Your resize was applied. Reboot ${targetOf(request)} now to bring the new resources online.`,
      link: `/resources?reboot=${p.vmid}&request=${request.id}`,
      meta: { requestId: request.id, vmid: p.vmid },
    });
  } catch (err) {
    request.status = "failed";
    request.error = err.message;
    request.updatedAt = new Date().toISOString();
    persistRequest(request);
    notifyUser(request.requestedBy, {
      type: "resize_failed",
      title: `Resize failed — ${targetOf(request)}`,
      message: err.message,
      link: `/deployments?tab=failed&request=${request.id}`,
      meta: { requestId: request.id },
    });
    throw err;
  }
}

export async function confirmResizeReboot({ id, actor }) {
  const request = requests.get(id);
  if (!request || request.kind !== "resize") return null;
  if (request.status !== "awaiting_reboot") return { request: syncRequestStatus(request) };

  const p = request.payload || {};
  const reboot = p.type === "container" ? pve.rebootContainer : pve.rebootVm;
  await reboot({ vmid: p.vmid });

  request.status = "completed";
  request.rebootedBy = actor;
  request.updatedAt = new Date().toISOString();
  persistRequest(request);
  return { request: syncRequestStatus(request) };
}

export function rejectProvisionRequest({ id, reviewer, reason = "Rejected by admin", source = "portal" } = {}) {
  const request = requests.get(id);
  if (!request) return null;
  if (request.status !== "pending_approval") {
    return enrichRequest(syncRequestStatus(request));
  }

  request.status = "rejected";
  request.rejectedBy = reviewer;
  request.rejectedAt = new Date().toISOString();
  request.rejectionReason = reason;
  request.approvalSource = source;
  request.updatedAt = new Date().toISOString();
  persistRequest(request);

  notifyUser(request.requestedBy, {
    type: "rejected",
    title: `Request rejected — ${targetOf(request)}`,
    message: reason,
    link: `/deployments?tab=failed&request=${encodeURIComponent(request.id)}`,
    meta: { requestId: request.id },
  });
  onRequestRejected(request, reason);
  return enrichRequest(syncRequestStatus(request));
}

export function markRequestCancelled(id, { actor, reason } = {}) {
  const request = requests.get(id);
  if (!request) return null;
  if (["completed", "rejected", "cancelled"].includes(request.status)) {
    return enrichRequest(syncRequestStatus(request));
  }
  request.status = "cancelled";
  request.cancelledBy = actor || null;
  request.cancelledAt = new Date().toISOString();
  request.cancellationReason = reason || null;
  request.updatedAt = new Date().toISOString();
  persistRequest(request);
  return enrichRequest(syncRequestStatus(request));
}

const TERMINAL_REQUEST_STATUSES = new Set([
  "completed", "failed", "rejected", "cancelled",
]);

export function isTerminalRequest(req) {
  return TERMINAL_REQUEST_STATUSES.has(req?.status);
}

export function listRequestsRaw() {
  return Array.from(requests.values());
}

export function archiveRequest(id) {
  const request = requests.get(id);
  if (!request || request.archivedAt) return request || null;
  request.archivedAt = new Date().toISOString();
  request.updatedAt = request.archivedAt;
  persistRequest(request);
  return request;
}

export async function purgeRequest(id) {
  requests.delete(id);
  try {
    await prisma.provisionRequest.delete({ where: { id } });
  } catch {
    /* already gone */
  }
}
