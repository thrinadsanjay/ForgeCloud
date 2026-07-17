import {
  createCatalogRequest,
  addWorkNote,
  closeRitm,
  createIncident,
  isConfigured,
  resolveUserSysId,
} from "./servicenowService.js";
import {
  createTicket,
  getTicketByRequestId,
  getTicketByJobId,
  linkTicketToJob,
  appendLocalWorkNote,
  updateTicket,
  ticketSummary,
} from "./servicenowTicketStore.js";
import { findByUsername } from "./userStore.js";
import { notifyUser } from "./notificationStore.js";
import { fireWebhook } from "./n8nWebhookService.js";
import { logAudit } from "./auditService.js";
import { createCmdbForJob } from "./cmdbService.js";
import { getTemplateMappings } from "./mappingStore.js";

function targetLabel(request) {
  const p = request?.payload || {};
  return p.hostname || p.hostnamePrefix || p.templateId || request?.kind || request?.id;
}

function buildDescription(request) {
  const p = request?.payload || {};
  const lines = [
    `Kind: ${request.kind}`,
    `Requested by: ${request.requestedBy}`,
    `Hostname: ${p.hostname || p.hostnamePrefix || "—"}`,
    `CPU: ${p.cpu ?? "—"} · RAM: ${p.memoryGB ?? "—"} GB · Disk: ${p.diskGB ?? "—"} GB`,
    `Template: ${p.templateId || "—"}`,
    `Environment: ${p.environment || "—"}`,
    `Packages: ${(p.packages || []).join(", ") || "defaults only"}`,
    `Forge Request ID: ${request.id}`,
  ];
  return lines.join("\n");
}

async function resolvePortalUser(requestedBy) {
  const portalUser = findByUsername(requestedBy);
  const snowUser = await resolveUserSysId({
    email: portalUser?.email,
    username: requestedBy,
  });
  return { portalUser, snowUser };
}

function webhookPayload(request, job = null, extra = {}) {
  return {
    request: request ? enrichRequest(request) : null,
    job: job ? enrichJob(job) : null,
    ...extra,
  };
}

/** Create REQ/RITM when a provision request is submitted. */
export async function onRequestSubmitted(request) {
  if (!request?.id || request.kind === "resize") return null;

  const existing = getTicketByRequestId(request.id);
  if (existing) return existing;

  const { snowUser } = await resolvePortalUser(request.requestedBy);
  const shortDescription = `Forge ${request.kind} request: ${targetLabel(request)}`;
  const catalogResult = await createCatalogRequest({
    shortDescription,
    description: buildDescription(request),
    requestId: request.id,
    kind: request.kind,
    requestedForSysId: snowUser?.sysId || null,
    openedBySysId: process.env.SERVICENOW_OPENED_BY_SYS_ID || null,
  });

  const ticket = createTicket({ requestId: request.id, catalogResult });

  await addWorkNote({
    table: "sc_req_item",
    sysId: ticket.ritmSysId,
    message: `Request submitted via Forge (request ${request.id})${snowUser ? ` by ${snowUser.name || snowUser.userName}` : ""}.`,
    mock: ticket.mock,
  }).catch((err) => console.warn(`[snow] work note on submit failed: ${err.message}`));

  appendLocalWorkNote(request.id, "Request submitted");

  logAudit({
    actor: { username: request.requestedBy, role: "user" },
    action: "request.servicenow.created",
    target: ticket.ritmNumber || request.id,
    detail: {
      requestId: request.id,
      ritmNumber: ticket.ritmNumber,
      mock: ticket.mock,
      snowUser: snowUser?.sysId || null,
    },
  });

  fireWebhook("request.submitted", webhookPayload(request, null, {
    servicenow: ticketSummary(ticket),
    snowUser,
  }));

  return ticket;
}

/** Link job and note provisioning start. */
export async function onProvisioningStarted(request, job) {
  if (!request?.id || !job?.id) return;

  let ticket = getTicketByRequestId(request.id);
  if (!ticket) {
    ticket = await onRequestSubmitted(request);
  }
  if (!ticket) return;

  linkTicketToJob(request.id, job.id);
  updateTicket(request.id, { state: "provisioning" });

  await addWorkNote({
    table: "sc_req_item",
    sysId: ticket.ritmSysId,
    message: `Provisioning started (job ${job.id}).`,
    mock: ticket.mock,
  }).catch((err) => console.warn(`[snow] work note on start failed: ${err.message}`));

  appendLocalWorkNote(request.id, "Provisioning started");

  fireWebhook("provisioning.started", webhookPayload(request, job));
}

/** Post work note on each deployment step transition. */
export async function onStepChange({ requestId, jobId, stepKey, label, message, state }) {
  const ticket = requestId
    ? getTicketByRequestId(requestId)
    : getTicketByJobId(jobId);
  if (!ticket?.ritmSysId) return;

  const text = message || label || stepKey;
  const prefix = state === "failed" ? "FAILED — " : state === "active" ? "In progress — " : "";
  const note = `${prefix}${text}`;

  await addWorkNote({
    table: "sc_req_item",
    sysId: ticket.ritmSysId,
    message: note,
    mock: ticket.mock,
  }).catch((err) => console.warn(`[snow] step work note failed: ${err.message}`));

  if (requestId) appendLocalWorkNote(requestId, note);

  fireWebhook("provisioning.step", {
    request: requestId ? enrichRequest({ id: requestId }) : null,
    job: jobId ? enrichJob({ id: jobId, payload: { requestId } }) : null,
    step: { stepKey, label, message: note, state },
    servicenow: ticketSummary(ticket),
  });
}

/** Close RITM on successful provisioning. */
export async function onProvisioningComplete(job) {
  const requestId = job?.payload?.requestId;
  const ticket = requestId ? getTicketByRequestId(requestId) : getTicketByJobId(job?.id);
  if (!ticket) return;

  const result = job?.result || {};
  const host = result.hostname || job.payload?.hostname || "server";
  const ip = result.ip || (job.resources?.[0]?.ip) || "—";
  const vmid = result.vmid || job.resources?.[0]?.vmid || "—";

  const { snowUser } = await resolvePortalUser(job.payload?.requestedBy || "");
  const tpl = job.payload?.templateId;
  let osName = null;
  if (tpl && /^tpl-\d+$/.test(tpl)) {
    const vmidTpl = String(tpl.slice(4));
    osName = getTemplateMappings()[vmidTpl]?.osName || null;
  }

  const cmdbItems = await createCmdbForJob(job, { ticket, snowUser, osName });
  if (cmdbItems.length && ticket.requestId) {
    const primary = cmdbItems[0];
    updateTicket(ticket.requestId, {
      ciNumber: primary.ciNumber,
      ciSysId: primary.ciSysId,
      ciClass: primary.ciClass,
      cmdbItems,
    });
    ticket.ciNumber = primary.ciNumber;
    ticket.ciSysId = primary.ciSysId;

    const ciNote = cmdbItems.length === 1
      ? `CMDB CI created: ${primary.ciNumber} (${primary.name})`
      : `CMDB CIs created: ${cmdbItems.map((c) => c.ciNumber).join(", ")}`;

    await addWorkNote({
      table: "sc_req_item",
      sysId: ticket.ritmSysId,
      message: ciNote,
      mock: ticket.mock,
    }).catch(() => {});

    appendLocalWorkNote(ticket.requestId, ciNote);

    fireWebhook("cmdb.ci.created", {
      request: enrichRequest({ id: ticket.requestId, payload: job.payload, requestedBy: job.payload?.requestedBy, kind: job.type }),
      job: enrichJob(job),
      cmdb: cmdbItems,
      servicenow: ticketSummary({ ...ticket, cmdbItems }),
    });
  }

  const closeNotes = [
    `Provisioning completed successfully.`,
    `Hostname: ${host}`,
    `VMID: ${vmid}`,
    `IP: ${ip}`,
    cmdbItems.length ? `CMDB: ${cmdbItems.map((c) => `${c.ciNumber} (${c.name})`).join(", ")}` : "",
    job.result?.allOk === false ? "Note: some setup steps reported warnings." : "",
  ].filter(Boolean).join(" ");

  await addWorkNote({
    table: "sc_req_item",
    sysId: ticket.ritmSysId,
    message: closeNotes,
    mock: ticket.mock,
  }).catch(() => {});

  await closeRitm({
    ritmSysId: ticket.ritmSysId,
    success: true,
    closeNotes,
    mock: ticket.mock,
  }).catch((err) => console.warn(`[snow] close RITM failed: ${err.message}`));

  updateTicket(ticket.requestId, { state: "closed_complete" });
  appendLocalWorkNote(ticket.requestId, "Request closed — provisioning successful");

  logAudit({
    actor: { username: "system", role: "system" },
    action: "request.servicenow.closed",
    target: ticket.ritmNumber || ticket.requestId,
    detail: { requestId: ticket.requestId, jobId: job.id, success: true },
  });

  const owner = job.payload?.requestedBy;
  if (owner) {
    notifyUser(owner, {
      type: "provision_complete",
      title: `Server ready — ${host}`,
      message: job.result?.allOk === false
        ? `Your server "${host}" is up at ${ip}, but some setup steps had warnings. Open Deployments for details.`
        : `Your server "${host}" is ready at ${ip}.`,
      link: "/deployments",
      meta: { requestId: ticket.requestId, jobId: job.id, ritmNumber: ticket.ritmNumber, ciNumber: cmdbItems[0]?.ciNumber },
    });
  }

  fireWebhook("provisioning.completed", webhookPayload(
    requestId ? { id: requestId, payload: job.payload, requestedBy: owner, kind: job.type } : null,
    job,
    { servicenow: ticketSummary(ticket), result: { hostname: host, ip, vmid }, cmdb: cmdbItems },
  ));
}

/** Close RITM incomplete + optional incident on failure. */
export async function onProvisioningFailed(job) {
  const requestId = job?.payload?.requestId;
  const ticket = requestId ? getTicketByRequestId(requestId) : getTicketByJobId(job?.id);
  const errorText = job?.errorUserMessage || job?.message || job?.error || "Provisioning failed";
  const detail = job?.errorDetail
    || (job?.error && job.error !== errorText ? job.error : "");
  const snowMessage = detail
    ? `Provisioning failed: ${errorText}\n\nTechnical detail:\n${detail}`
    : `Provisioning failed: ${errorText}`;
  const host = job.payload?.hostname || job.payload?.hostnamePrefix || `job ${job.id}`;

  if (ticket?.ritmSysId) {
    await addWorkNote({
      table: "sc_req_item",
      sysId: ticket.ritmSysId,
      message: snowMessage,
      mock: ticket.mock,
    }).catch(() => {});

    await closeRitm({
      ritmSysId: ticket.ritmSysId,
      success: false,
      closeNotes: snowMessage.slice(0, 4000),
      mock: ticket.mock,
    }).catch((err) => console.warn(`[snow] close RITM on failure failed: ${err.message}`));

    updateTicket(ticket.requestId, { state: "closed_incomplete" });
    appendLocalWorkNote(ticket.requestId, snowMessage);
  }

  const { snowUser } = await resolvePortalUser(job.payload?.requestedBy || "");

  const incident = await createIncident({
    shortDescription: `Forge provisioning failed: ${host}`,
    description: snowMessage,
    callerId: job.payload?.requestedBy || "forge-portal",
    callerSysId: snowUser?.sysId || null,
    jobId: job.id,
    ritmSysId: ticket?.ritmSysId || null,
    mock: ticket?.mock ?? !isConfigured(),
  }).catch((err) => {
    console.warn(`[snow] incident create failed: ${err.message}`);
    return null;
  });

  if (incident && ticket) {
    updateTicket(ticket.requestId, {
      incidentNumber: incident.number,
      incidentSysId: incident.sysId,
    });
  }

  const owner = job.payload?.requestedBy;
  if (owner) {
    notifyUser(owner, {
      type: "provision_failed",
      title: `Provisioning failed — ${host}`,
      message: errorText,
      link: "/deployments",
      meta: {
        requestId: ticket?.requestId || requestId,
        jobId: job.id,
        incidentNumber: incident?.number,
        ritmNumber: ticket?.ritmNumber,
      },
    });
  }

  fireWebhook("provisioning.failed", webhookPayload(
    requestId ? { id: requestId, payload: job.payload, requestedBy: owner, kind: job.type } : null,
    job,
    { servicenow: ticket ? ticketSummary(ticket) : null, incident, error: errorText },
  ));

  return incident;
}

/** Sync approval to ServiceNow work notes + outbound n8n webhook. */
export function onRequestApproved(request, job) {
  const ticket = getTicketByRequestId(request?.id);
  const source = request?.approvalSource || "portal";
  const note = `Approved via ${source} by ${request?.approvedBy || "unknown"}.`;
  if (ticket?.ritmSysId) {
    addWorkNote({
      table: "sc_req_item",
      sysId: ticket.ritmSysId,
      message: note,
      mock: ticket.mock,
    }).catch((err) => console.warn(`[snow] approve work note failed: ${err.message}`));
    appendLocalWorkNote(request.id, note);
    updateTicket(request.id, { state: "approved" });
  }
  fireWebhook("request.approved", webhookPayload(request, job, {
    approvalSource: source,
    servicenow: ticketSummary(ticket),
  }));
}

/** Sync rejection to ServiceNow work notes + outbound n8n webhook. */
export function onRequestRejected(request, reason) {
  const ticket = getTicketByRequestId(request?.id);
  const source = request?.approvalSource || "portal";
  const note = `Rejected via ${source} by ${request?.rejectedBy || "unknown"}: ${reason || "No reason given"}`;
  if (ticket?.ritmSysId) {
    addWorkNote({
      table: "sc_req_item",
      sysId: ticket.ritmSysId,
      message: note,
      mock: ticket.mock,
    }).catch((err) => console.warn(`[snow] reject work note failed: ${err.message}`));
    closeRitm({
      ritmSysId: ticket.ritmSysId,
      success: false,
      closeNotes: note.slice(0, 4000),
      mock: ticket.mock,
    }).catch((err) => console.warn(`[snow] close RITM on reject failed: ${err.message}`));
    appendLocalWorkNote(request.id, note);
    updateTicket(request.id, { state: "rejected" });
  }
  fireWebhook("request.rejected", webhookPayload(request, null, {
    reason,
    approvalSource: source,
    servicenow: ticketSummary(ticket),
  }));
}

/** Note cancel + incomplete destroy on the RITM. */
export async function onProvisioningCancelled(job, { reason, destroyResults } = {}) {
  const requestId = job?.payload?.requestId;
  const ticket = requestId ? getTicketByRequestId(requestId) : getTicketByJobId(job?.id);
  const destroyed = (destroyResults || []).filter((r) => r.ok).map((r) => r.vmid);
  const failed = (destroyResults || []).filter((r) => !r.ok);
  const note = [
    `Provisioning cancelled: ${reason || "Stopped by user"}.`,
    destroyed.length ? `Destroyed incomplete VMID(s): ${destroyed.join(", ")}.` : "",
    failed.length ? `Cleanup failed for VMID(s): ${failed.map((r) => `${r.vmid} (${r.error})`).join("; ")}.` : "",
  ].filter(Boolean).join(" ");

  if (ticket?.ritmSysId) {
    await addWorkNote({
      table: "sc_req_item",
      sysId: ticket.ritmSysId,
      message: note,
      mock: ticket.mock,
    }).catch((err) => console.warn(`[snow] cancel work note failed: ${err.message}`));

    await closeRitm({
      ritmSysId: ticket.ritmSysId,
      success: false,
      closeNotes: note.slice(0, 4000),
      mock: ticket.mock,
    }).catch((err) => console.warn(`[snow] close RITM on cancel failed: ${err.message}`));

    if (ticket.requestId) {
      updateTicket(ticket.requestId, { state: "cancelled" });
      appendLocalWorkNote(ticket.requestId, note);
    }
  }

  fireWebhook("provisioning.cancelled", webhookPayload(
    requestId ? { id: requestId, payload: job.payload, requestedBy: job.payload?.requestedBy, kind: job.type } : null,
    job,
    { reason, destroyResults, servicenow: ticket ? ticketSummary(ticket) : null },
  ));
}

/** Note rollback of leftover guests after a failed provision. */
export async function onProvisioningRolledBack(job, { reason, destroyResults, targets } = {}) {
  const requestId = job?.payload?.requestId;
  const ticket = requestId ? getTicketByRequestId(requestId) : getTicketByJobId(job?.id);
  const destroyed = (destroyResults || []).filter((r) => r.ok).map((r) => r.vmid);
  const failed = (destroyResults || []).filter((r) => !r.ok);
  const targetList = (targets || [])
    .map((t) => (t.hostname ? `${t.vmid} (${t.hostname})` : String(t.vmid)))
    .join(", ");
  const note = [
    `Failed deployment rolled back: ${reason || "Leftover resources destroyed"}.`,
    targetList ? `Targets: ${targetList}.` : "",
    destroyed.length ? `Destroyed VMID(s): ${destroyed.join(", ")}.` : "",
    failed.length ? `Cleanup failed for VMID(s): ${failed.map((r) => `${r.vmid} (${r.error})`).join("; ")}.` : "",
  ].filter(Boolean).join(" ");

  if (ticket?.ritmSysId) {
    await addWorkNote({
      table: "sc_req_item",
      sysId: ticket.ritmSysId,
      message: note,
      mock: ticket.mock,
    }).catch((err) => console.warn(`[snow] rollback work note failed: ${err.message}`));

    if (ticket.requestId) {
      updateTicket(ticket.requestId, { state: "rolled_back" });
      appendLocalWorkNote(ticket.requestId, note);
    }
  }

  fireWebhook("provisioning.rolled_back", webhookPayload(
    requestId ? { id: requestId, payload: job.payload, requestedBy: job.payload?.requestedBy, kind: job.type } : null,
    job,
    { reason, destroyResults, targets, servicenow: ticket ? ticketSummary(ticket) : null },
  ));
}

export function enrichRequest(request) {
  if (!request) return request;
  const ticket = getTicketByRequestId(request.id);
  return { ...request, servicenow: ticketSummary(ticket) };
}

export function enrichJob(job) {
  if (!job) return job;
  const ticket = job.payload?.requestId
    ? getTicketByRequestId(job.payload.requestId)
    : getTicketByJobId(job.id);
  const servicenow = ticketSummary(ticket);
  const incident = job.incident || (servicenow?.incidentNumber ? {
    number: servicenow.incidentNumber,
    sysId: servicenow.incidentSysId,
    url: servicenow.incidentUrl,
  } : null);
  return { ...job, servicenow, incident: incident || job.incident };
}
