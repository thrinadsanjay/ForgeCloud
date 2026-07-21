import { Router } from "express";
import {
  listContainerTemplates,
  listStackTemplates,
  internalVmTemplates,
  mappedVmTemplates,
  findInternalTemplate,
  findContainerTemplate,
  findStack,
  getTemplateDefaults,
  withTemplateDefaults,
  listCatalogPackages,
  listApplicationRoles,
  listBaselines,
  listInstanceSizes,
  getHostnameFormatInfo,
  formatHostname,
  resolveApplicationAppToken,
  findVmTemplate,
} from "../services/catalogService.js";
import { getJob, listJobs, peekJob } from "../services/jobStore.js";
import { cancelDeploymentJob, rollbackFailedJob, retryFailedJob } from "../services/jobCancelService.js";
import { logAudit } from "../services/auditService.js";
import { requireAuth } from "../middleware/auth.js";
import { canReviewDeployments, canSeeAllDeployments } from "../constants/roles.js";
import { getNetworkMappings } from "../services/mappingStore.js";
import { getCostRates } from "../services/settingsStore.js";
import {
  submitProvisionRequest,
  listProvisionRequests,
  getProvisionRequest,
  approveProvisionRequest,
  rejectProvisionRequest,
  confirmResizeReboot,
  markRequestCancelled,
} from "../services/requestStore.js";
import { computeRequestImpact } from "../services/capacityService.js";
import { checkTeamQuotas } from "../services/quotaService.js";
import { generateIac, IAC_TOOLS, isIacTool } from "../services/iacTemplates.js";

// Lifetime (in days) the requester asked for on the provisioning form. Coerce
// to a sane whole number; fall back to the system default when missing/invalid.
function normalizeTtlDays(days) {
  const n = Number(days);
  if (!Number.isFinite(n) || n <= 0) return undefined; // let expiryStore apply its default
  return Math.min(Math.round(n), 3650);
}

// Resolve a human-readable OS / template name for a request, so the admin
// review dialog can show what's being built without another lookup client-side.
function resolveRequestOs(request) {
  const p = request?.payload || {};
  if (request?.kind === "vm") {
    const tpl = [...mappedVmTemplates(), ...internalVmTemplates()].find((t) => t.id === p.templateId);
    return tpl?.osName || tpl?.name || p.templateId || null;
  }
  if (request?.kind === "internal") {
    const tpl = findInternalTemplate(p.templateId);
    return tpl?.osName || tpl?.name || p.templateId || null;
  }
  if (request?.kind === "container") {
    const tpl = findContainerTemplate(p.templateId);
    return tpl?.osName || tpl?.name || p.templateId || null;
  }
  if (request?.kind === "stack") {
    const st = findStack(p.stackId);
    return st?.name || p.stackId || null;
  }
  return null;
}

function unitsForKind(kind, payload = {}) {
  if (kind !== "stack") return 1;
  const nodes = payload.nodes || payload.services || payload.vms;
  if (Array.isArray(nodes) && nodes.length) return nodes.length;
  const st = findStack(payload.stackId);
  const catalogNodes = st?.nodes || st?.services || st?.vms;
  return Array.isArray(catalogNodes) && catalogNodes.length ? catalogNodes.length : 1;
}

async function gateTeamQuota(req, res, { kind, payload }) {
  const check = await checkTeamQuotas(req.user.username, {
    kind,
    cpu: payload.cpu,
    memoryGB: payload.memoryGB,
    units: unitsForKind(kind, payload),
  });
  if (!check.ok) {
    res.status(403).json({ error: check.reason, group: check.group });
    return false;
  }
  return true;
}

const router = Router();

// Everything here requires authentication.
router.use(requireAuth);

// --- Catalog ---
router.get("/catalog/vm-templates", (req, res) => res.json(withTemplateDefaults([...mappedVmTemplates(), ...internalVmTemplates()])));
router.get("/catalog/container-templates", (req, res) => res.json(withTemplateDefaults(listContainerTemplates())));
router.get("/catalog/stacks", (req, res) => res.json(withTemplateDefaults(listStackTemplates())));
router.get("/catalog/packages", (req, res) => res.json(listCatalogPackages()));
router.get("/catalog/application-roles", (req, res) => res.json(listApplicationRoles()));
router.get("/catalog/instance-sizes", (req, res) => res.json(listInstanceSizes()));
router.get("/catalog/baselines", (req, res) => res.json(listBaselines()));
router.get("/catalog/template-defaults", (req, res) => res.json(getTemplateDefaults()));
router.get("/catalog/hostname-format", (req, res) => res.json(getHostnameFormatInfo()));

/** Suggest a hostname from the admin format (consumes {n}/{rand} tokens). */
router.post("/catalog/hostname-suggest", async (req, res) => {
  const {
    kind = "vm",
    templateId,
    stackId,
    app,
    application,
    packages: selectedPackages,
    rolePackages,
    environment,
    os,
  } = req.body || {};
  const id = templateId || stackId;
  let template = null;
  if (kind === "container") template = findContainerTemplate(id);
  else if (kind === "stack") template = findStack(id);
  else template = findVmTemplate(id) || findInternalTemplate(id);

  // Warm AI/cache for long environment labels so {env} uses a smart 3-letter code.
  if (environment && String(environment).trim().length > 3) {
    try {
      const { shortEnvCodeWithAi } = await import("../services/envCode.js");
      await shortEnvCodeWithAi(environment);
    } catch {
      /* sync shortEnvCode still used inside formatHostname */
    }
  }

  const roleId = application || app || "";
  const rolePkgIds = Array.isArray(rolePackages)
    ? rolePackages
    : (Array.isArray(selectedPackages) ? selectedPackages : []);
  const resolvedApp = roleId
    ? resolveApplicationAppToken(roleId, rolePkgIds)
    : (app || application || "");

  const hostname = formatHostname({
    kind: kind === "container" ? "ct" : kind || "vm",
    os: os || template?.osName || template?.name || id || kind,
    templateId: id,
    templateName: template?.name,
    user: req.user?.username,
    env: environment,
    app: resolvedApp,
  });
  res.json({
    hostname,
    appToken: resolvedApp,
    ...getHostnameFormatInfo(),
  });
});

// --- Infrastructure-as-Code export ---
// The available tools, and a generator that returns a ready-to-use file for a
// given template so users can provision/manage from Terraform, Ansible, etc.
router.get("/catalog/iac/tools", (req, res) => res.json(IAC_TOOLS));

router.get("/catalog/iac", (req, res) => {
  const { kind, id, tool } = req.query;
  if (!kind || !id || !tool) {
    return res.status(400).json({ error: "kind, id and tool are required" });
  }
  if (!isIacTool(tool)) {
    return res.status(400).json({ error: `Unknown tool: ${tool}` });
  }

  let template = null;
  if (kind === "vm") template = [...mappedVmTemplates(), ...internalVmTemplates()].find((t) => t.id === id);
  else if (kind === "container") template = findContainerTemplate(id);
  else if (kind === "stack") template = findStack(id);
  if (!template) {
    return res.status(404).json({ error: `Template not found: ${kind}/${id}` });
  }

  const baseUrl = process.env.FORGE_PUBLIC_URL || process.env.SSP_PUBLIC_URL || `${req.protocol}://${req.get("host")}`;
  const file = generateIac({ tool, kind, template, baseUrl });
  res.json(file);
});

// Per-month unit prices used to estimate resource cost on the provisioning
// form. Admin-configured under Settings → Cost estimation; readable by any
// authenticated user so the live estimate can render.
router.get("/catalog/cost-rates", (req, res) => res.json(getCostRates()));

// Environments the user can deploy into = admin-labelled networks (Mappings).
router.get("/catalog/environments", (req, res) => {
  const nets = getNetworkMappings();
  const envs = Object.entries(nets)
    .filter(([, m]) => m.label && String(m.label).trim())
    .map(([iface, m]) => ({ iface, label: m.label, type: m.type || "bridge" }))
    .sort((a, b) => a.label.localeCompare(b.label));
  res.json(envs);
});

// --- Provisioning ---
router.post("/provision/vm", async (req, res) => {
  const { templateId, hostname, cpu, memoryGB, additionalDiskGB, ttlDays, permanent, packages, packageSelection, username, sudoAccess, environment, application } = req.body;
  if (!templateId || !hostname || !cpu || !memoryGB) {
    return res.status(400).json({ error: "templateId, hostname, cpu, memoryGB are required" });
  }
  if (!environment) {
    return res.status(400).json({ error: "environment (network) is required" });
  }
  if (!username || !String(username).trim()) {
    return res.status(400).json({ error: "username is required" });
  }
  // The OS disk is sized by the template; an optional additional data disk is attached.
  const extraDisk = Number(additionalDiskGB) > 0 ? Math.round(Number(additionalDiskGB)) : 0;
  const payload = {
    templateId, hostname, cpu, memoryGB, additionalDiskGB: extraDisk, diskGB: extraDisk,
    ttlDays: normalizeTtlDays(ttlDays), permanent: !!permanent, packages, packageSelection,
    username: String(username).trim(), sudoAccess: !!sudoAccess, environment,
    application: application ? String(application).trim().toLowerCase() : undefined,
  };
  if (!(await gateTeamQuota(req, res, { kind: "vm", payload }))) return;
  const result = await submitProvisionRequest({ kind: "vm", payload, requestedBy: req.user.username, source: "portal" });
  logAudit({
    actor: req.user,
    action: "vm.request",
    target: hostname,
    detail: {
      templateId,
      cpu,
      memoryGB,
      additionalDiskGB: extraDisk,
      packages,
      packageSelection,
      requestId: result.request.id,
      jobId: result.job?.id || null,
      status: result.request.status,
    },
  });
  res.status(202).json({ request: result.request, job: result.job || null });
});

// Internal workflow provisioning (never calls Proxmox). Unlike a real VM, no
// environment/username is required; the workflow allocates the network,
// storage, firewall and DNS itself via the configured internal system APIs.
router.post("/provision/internal", async (req, res) => {
  const { templateId, hostname, cpu, memoryGB, diskGB, additionalDiskGB, ttlDays, permanent, application } = req.body;
  if (!templateId || !hostname || !cpu || !memoryGB) {
    return res.status(400).json({ error: "templateId, hostname, cpu, memoryGB are required" });
  }
  if (!findInternalTemplate(templateId)) {
    return res.status(400).json({ error: `Unknown internal template: ${templateId}` });
  }
  // Internal systems allocate their own storage; use the requested data-disk size (or a default).
  const internalDisk = Number(diskGB) || Number(additionalDiskGB) || 50;
  const payload = {
    templateId, hostname, cpu, memoryGB, diskGB: internalDisk,
    ttlDays: normalizeTtlDays(ttlDays), permanent: !!permanent,
    application: application ? String(application).trim().toLowerCase() : undefined,
  };
  if (!(await gateTeamQuota(req, res, { kind: "internal", payload }))) return;
  const result = await submitProvisionRequest({ kind: "internal", payload, requestedBy: req.user.username, source: "portal" });
  logAudit({
    actor: req.user,
    action: "internal.request",
    target: hostname,
    detail: {
      templateId,
      cpu,
      memoryGB,
      diskGB,
      requestId: result.request.id,
      jobId: result.job?.id || null,
      status: result.request.status,
    },
  });
  res.status(202).json({ request: result.request, job: result.job || null });
});

router.post("/provision/container", async (req, res) => {
  const { templateId, hostname, cpu, memoryGB, ttlDays, permanent, packages, packageSelection, application } = req.body;
  if (!templateId || !hostname || !cpu || !memoryGB) {
    return res.status(400).json({ error: "templateId, hostname, cpu, memoryGB are required" });
  }
  const payload = {
    templateId, hostname, cpu, memoryGB, ttlDays: normalizeTtlDays(ttlDays), permanent: !!permanent,
    packages, packageSelection,
    application: application ? String(application).trim().toLowerCase() : undefined,
  };
  if (!(await gateTeamQuota(req, res, { kind: "container", payload }))) return;
  const result = await submitProvisionRequest({ kind: "container", payload, requestedBy: req.user.username, source: "portal" });
  logAudit({
    actor: req.user,
    action: "container.request",
    target: hostname,
    detail: {
      templateId,
      cpu,
      memoryGB,
      packages,
      packageSelection,
      requestId: result.request.id,
      jobId: result.job?.id || null,
      status: result.request.status,
    },
  });
  res.status(202).json({ request: result.request, job: result.job || null });
});

router.post("/provision/stack", async (req, res) => {
  const { stackId, hostnamePrefix, cpu, memoryGB, additionalDiskGB, ttlDays, permanent, packages, packageSelection, application } = req.body;
  if (!stackId || !hostnamePrefix || !cpu || !memoryGB) {
    return res.status(400).json({ error: "stackId, hostnamePrefix, cpu, memoryGB are required" });
  }
  const extraDisk = Number(additionalDiskGB) > 0 ? Math.round(Number(additionalDiskGB)) : 0;
  const payload = {
    stackId, hostnamePrefix, cpu, memoryGB, additionalDiskGB: extraDisk, diskGB: extraDisk,
    ttlDays: normalizeTtlDays(ttlDays), permanent: !!permanent, packages, packageSelection,
    application: application ? String(application).trim().toLowerCase() : undefined,
  };
  if (!(await gateTeamQuota(req, res, { kind: "stack", payload }))) return;
  const result = await submitProvisionRequest({ kind: "stack", payload, requestedBy: req.user.username, source: "portal" });
  logAudit({
    actor: req.user,
    action: "stack.request",
    target: hostnamePrefix,
    detail: {
      stackId,
      packages,
      packageSelection,
      requestId: result.request.id,
      jobId: result.job?.id || null,
      status: result.request.status,
    },
  });
  res.status(202).json({ request: result.request, job: result.job || null });
});

// Live Proxmox capacity preview for the provision form (warn before oversized builds).
router.post("/capacity/preview", async (req, res) => {
  const cpu = Number(req.body?.cpu) || 0;
  const memoryGB = Number(req.body?.memoryGB) || 0;
  const diskGB = Number(req.body?.diskGB ?? req.body?.additionalDiskGB) || 0;
  const kind = req.body?.kind || "vm";
  const units = Math.max(1, Number(req.body?.units) || unitsForKind(kind, req.body || {}));
  try {
    const payload = {
      cpu,
      memoryGB,
      diskGB,
      ...(units > 1 ? { nodes: Array.from({ length: units }, (_, i) => ({ id: i })) } : {}),
    };
    const impact = await computeRequestImpact({
      kind: units > 1 ? "stack" : kind,
      payload,
    });
    res.json(impact);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// --- Provision requests / approvals ---
router.get("/requests", (req, res) => {
  res.json(listProvisionRequests(req.user));
});

// Capacity impact of a pending request — powers the review dialog.
router.get("/requests/:id/impact", async (req, res) => {
  if (!canReviewDeployments(req.user.role)) {
    return res.status(403).json({ error: "Deployment Approver or Admin access required" });
  }
  const request = getProvisionRequest(req.params.id);
  if (!request) return res.status(404).json({ error: "Request not found" });
  try {
    const p = request.payload || {};
    // Renewals don't change node footprint — skip Proxmox capacity calc.
    if (request.kind === "renew") {
      return res.json({
        canApprove: true,
        blocking: [],
        resources: {},
        details: {
          requestedBy: request.requestedBy || null,
          createdAt: request.createdAt || null,
          kind: "renew",
          hostname: p.hostname || (p.vmid ? `VMID ${p.vmid}` : null),
          os: null,
          environment: null,
          username: null,
          days: p.days || null,
          vmid: p.vmid || null,
          type: p.type || null,
        },
      });
    }
    const impact = await computeRequestImpact(request);
    // Requestor / target context for the review dialog.
    impact.details = {
      requestedBy: request.requestedBy || null,
      createdAt: request.createdAt || null,
      kind: request.kind,
      hostname: p.hostname || p.hostnamePrefix || null,
      os: resolveRequestOs(request),
      environment: p.environment || null,
      username: p.username || null,
    };
    res.json(impact);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

router.post("/requests/:id/approve", async (req, res) => {
  if (!canReviewDeployments(req.user.role)) {
    return res.status(403).json({ error: "Deployment Approver or Admin access required" });
  }

  let result;
  try {
    result = await approveProvisionRequest({
      id: req.params.id,
      approver: req.user.username,
      source: "portal",
    });
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }
  if (!result) return res.status(404).json({ error: "Request not found" });

  logAudit({
    actor: req.user,
    action: "request.approve",
    target: `Request ${req.params.id}`,
    detail: {
      requestId: req.params.id,
      jobId: result.job?.id || null,
      approvalSource: "portal",
      alreadyDecided: !!result.alreadyDecided,
    },
  });

  res.json({
    request: result.request,
    job: result.job || null,
    alreadyDecided: !!result.alreadyDecided,
  });
});

// Owner (or admin) confirms the reboot after an approved resize was applied.
router.post("/requests/:id/confirm-reboot", async (req, res) => {
  const request = getProvisionRequest(req.params.id);
  if (!request || request.kind !== "resize") {
    return res.status(404).json({ error: "Resize request not found" });
  }
  if (req.user.role !== "admin" && request.requestedBy !== req.user.username) {
    return res.status(403).json({ error: "You can only reboot your own resource" });
  }
  try {
    const result = await confirmResizeReboot({ id: req.params.id, actor: req.user.username });
    logAudit({
      actor: req.user,
      action: "resize.reboot",
      target: `VMID ${request.payload?.vmid}`,
      detail: { requestId: req.params.id },
    });
    res.json({ request: result.request });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

router.post("/requests/:id/reject", (req, res) => {
  if (!canReviewDeployments(req.user.role)) {
    return res.status(403).json({ error: "Deployment Approver or Admin access required" });
  }

  const reason = typeof req.body?.reason === "string" && req.body.reason.trim()
    ? req.body.reason.trim()
    : "Rejected by reviewer";

  const request = rejectProvisionRequest({
    id: req.params.id,
    reviewer: req.user.username,
    reason,
    source: "portal",
  });
  if (!request) return res.status(404).json({ error: "Request not found" });

  logAudit({
    actor: req.user,
    action: "request.reject",
    target: `Request ${req.params.id}`,
    detail: { requestId: req.params.id, reason, approvalSource: "portal" },
  });

  res.json({ request });
});

// --- Job status ---
router.get("/jobs", (req, res) => {
  const all = listJobs();
  const visible = canSeeAllDeployments(req.user.role)
    ? all
    : all.filter((j) => j.payload?.requestedBy === req.user.username);
  res.json(visible);
});
router.get("/jobs/:id", (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: "Job not found" });
  if (!canSeeAllDeployments(req.user.role) && job.payload?.requestedBy !== req.user.username) {
    return res.status(403).json({ error: "Not authorized to view this job" });
  }
  res.json(job);
});

/** Stop an in-flight deployment and destroy incomplete guests. */
router.post("/jobs/:id/cancel", async (req, res) => {
  const job = peekJob(req.params.id);
  if (!job) return res.status(404).json({ error: "Job not found" });

  const isOwner = job.payload?.requestedBy === req.user.username;
  if (!isOwner && !canReviewDeployments(req.user.role)) {
    return res.status(403).json({ error: "Not authorized to stop this deployment" });
  }

  const reason = String(req.body?.reason || "").trim()
    || `Stopped by ${req.user.username}`;

  try {
    const result = await cancelDeploymentJob(req.params.id, {
      actor: req.user.username,
      reason,
    });
    const requestId = result?.job?.payload?.requestId || job.payload?.requestId;
    if (requestId) {
      markRequestCancelled(requestId, { actor: req.user.username, reason });
    }
    logAudit({
      actor: req.user,
      action: "job.cancel",
      target: `Job ${req.params.id}`,
      detail: {
        jobId: req.params.id,
        alreadyTerminal: !!result?.alreadyTerminal,
        destroyResults: result?.destroyResults || [],
      },
    });
    res.json(result);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

/**
 * Rollback a failed deployment only — destroy leftover VMs/CTs on the job.
 * Not available for successful or in-flight jobs.
 */
router.post("/jobs/:id/rollback", async (req, res) => {
  const job = peekJob(req.params.id);
  if (!job) return res.status(404).json({ error: "Job not found" });

  const isOwner = job.payload?.requestedBy === req.user.username;
  if (!isOwner && !canReviewDeployments(req.user.role)) {
    return res.status(403).json({ error: "Not authorized to roll back this deployment" });
  }

  const reason = String(req.body?.reason || "").trim()
    || `Rolled back by ${req.user.username}`;

  try {
    const result = await rollbackFailedJob(req.params.id, {
      actor: req.user.username,
      reason,
    });
    logAudit({
      actor: req.user,
      action: "job.rollback",
      target: `Job ${req.params.id}`,
      detail: {
        jobId: req.params.id,
        alreadyRolledBack: !!result?.alreadyRolledBack,
        destroyResults: result?.destroyResults || [],
        targets: result?.targets || [],
      },
    });
    res.json(result);
  } catch (err) {
    const code = err.status === 400 ? 400 : 502;
    res.status(code).json({ error: err.message });
  }
});

/**
 * Retry a failed deployment — resume from the failed step when the guest still
 * exists; otherwise clean up leftovers and re-submit the same payload.
 */
router.post("/jobs/:id/retry", async (req, res) => {
  const job = peekJob(req.params.id);
  if (!job) return res.status(404).json({ error: "Job not found" });

  const isOwner = job.payload?.requestedBy === req.user.username;
  if (!isOwner && !canReviewDeployments(req.user.role)) {
    return res.status(403).json({ error: "Not authorized to retry this deployment" });
  }

  const reason = String(req.body?.reason || "").trim()
    || `Retried by ${req.user.username}`;

  try {
    const result = await retryFailedJob(req.params.id, {
      actor: req.user.username,
      reason,
    });
    logAudit({
      actor: req.user,
      action: "job.retry",
      target: `Job ${req.params.id}`,
      detail: {
        sourceJobId: req.params.id,
        resumed: !!result?.resumed,
        resumeFrom: result?.resumeFrom || null,
        vmid: result?.vmid || null,
        newRequestId: result?.request?.id || null,
        newJobId: result?.job?.id || null,
        heldForApproval: !!result?.heldForApproval,
        cleanup: result?.cleanup || null,
      },
    });
    res.status(result?.job || result?.resumed ? 202 : 200).json(result);
  } catch (err) {
    const code = err.status === 400 ? 400 : 502;
    res.status(code).json({ error: err.message });
  }
});

export default router;
