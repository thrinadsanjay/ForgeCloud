import {
  createCmdbCi,
  linkCiToTask,
  cmdbEnabled,
  isConfigured,
} from "./servicenowService.js";
import { logAudit } from "./auditService.js";

/** Extract provisioned resources from a completed job for CMDB upsert. */
export function resourcesForCmdb(job) {
  const resources = Array.isArray(job?.resources) ? job.resources : [];
  if (resources.length) {
    return resources
      .filter((r) => r.vmid || r.hostname)
      .map((r) => ({
        hostname: r.hostname,
        vmid: r.vmid,
        ip: r.ip || null,
        type: r.type || job.type || "vm",
        environment: r.environment || job.payload?.environment || job.result?.environment || null,
      }));
  }

  const result = job?.result || {};
  const payload = job?.payload || {};
  const host = result.hostname || payload.hostname || payload.hostnamePrefix;
  if (!host && !result.vmid) return [];

  return [{
    hostname: host,
    vmid: result.vmid || null,
    ip: result.ip || null,
    type: job.type || "vm",
    environment: result.environment || payload.environment || null,
  }];
}

/**
 * Create CMDB CIs for all resources in a completed job.
 * Returns array of { hostname, vmid, ip, ciNumber, ciSysId, ciClass, url, mock }.
 */
export async function createCmdbForJob(job, { ticket, snowUser, osName = null } = {}) {
  if (job?.type === "internal" || job?.type === "resize") return [];

  const resources = resourcesForCmdb(job);
  if (!resources.length) return [];

  const useMock = ticket?.mock ?? !isConfigured();
  const shouldCreate = cmdbEnabled() || useMock;
  if (!shouldCreate) return [];

  const payload = job.payload || {};
  const cpu = payload.cpu ?? null;
  const memoryGB = payload.memoryGB ?? null;
  const diskGB = payload.diskGB ?? null;
  const requestId = payload.requestId || ticket?.requestId || null;
  const ritmSysId = ticket?.ritmSysId || null;

  const created = [];

  for (const res of resources) {
    try {
      const ci = await createCmdbCi({
        hostname: res.hostname,
        ip: res.ip,
        vmid: res.vmid,
        cpu,
        memoryGB,
        diskGB,
        osName,
        environment: res.environment,
        resourceType: res.type,
        ownedBySysId: snowUser?.sysId || null,
        jobId: job.id,
        requestId,
        mock: useMock,
      });
      if (!ci) continue;

      if (ritmSysId) {
        await linkCiToTask({ ciSysId: ci.ciSysId, taskSysId: ritmSysId, mock: useMock }).catch((err) => {
          console.warn(`[cmdb] link CI to RITM failed: ${err.message}`);
        });
      }

      created.push({
        hostname: res.hostname,
        vmid: res.vmid,
        ip: res.ip,
        type: res.type,
        ...ci,
      });
    } catch (err) {
      console.warn(`[cmdb] CI create failed for ${res.hostname}: ${err.message}`);
      logAudit({
        actor: { username: "system", role: "system" },
        action: "servicenow.cmdb.create",
        target: res.hostname || String(res.vmid),
        status: "failure",
        detail: { error: err.message, jobId: job.id },
      });
    }
  }

  return created;
}
