import crypto from "crypto";
import axios from "axios";
import https from "https";
import { logAudit } from "./auditService.js";

// --- ServiceNow ITSM integration ---
// Catalog flow: sc_request + sc_req_item on submit, work notes during provisioning,
// close RITM on success. Failure path: work note + closed incomplete + optional incident.

function instanceUrl() {
  return (process.env.SERVICENOW_INSTANCE_URL || "").replace(/\/+$/, "");
}

export function isConfigured() {
  return !!instanceUrl();
}

export function catalogEnabled() {
  return process.env.SERVICENOW_CATALOG_ENABLED !== "false";
}

export function incidentsEnabled() {
  return process.env.SERVICENOW_INCIDENTS_ENABLED !== "false";
}

function timeoutMs() {
  return Number(process.env.SERVICENOW_HTTP_TIMEOUT_MS) || 15000;
}

let httpsAgent = null;
let httpsVerify = null;
function getHttpsAgent() {
  const verify = process.env.SERVICENOW_VERIFY_TLS === "true";
  if (!httpsAgent || httpsVerify !== verify) {
    httpsAgent = new https.Agent({ rejectUnauthorized: verify });
    httpsVerify = verify;
  }
  return httpsAgent;
}

function authConfig() {
  const username = process.env.SERVICENOW_USERNAME || "";
  const password = process.env.SERVICENOW_PASSWORD || "";
  return username ? { username, password } : undefined;
}

async function snowRequest(method, path, { data, params, retries = 2 } = {}) {
  const base = instanceUrl();
  if (!base) throw new Error("ServiceNow instance URL is not configured");

  const url = `${base}${path.startsWith("/") ? path : `/${path}`}`;
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const res = await axios({
        method,
        url,
        data,
        params,
        auth: authConfig(),
        timeout: timeoutMs(),
        httpsAgent: url.startsWith("https") ? getHttpsAgent() : undefined,
        headers: { Accept: "application/json", "Content-Type": "application/json" },
      });
      return res.data?.result ?? res.data;
    } catch (err) {
      lastErr = err;
      const status = err.response?.status;
      const retryable = !status || status >= 500 || status === 429;
      if (!retryable || attempt === retries) break;
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    }
  }
  const status = lastErr.response?.status;
  const msg = lastErr.response?.data?.error?.message || lastErr.message;
  throw new Error(`ServiceNow ${method} ${path} failed${status ? ` (HTTP ${status})` : ""}: ${msg}`);
}

function snowUrl(table, sysId) {
  const base = instanceUrl() || "https://dev-ssp.service-now.com";
  const tablePath = table === "sc_req_item" ? "sc_req_item" : table === "sc_request" ? "sc_request" : "incident";
  return `${base}/nav_to.do?uri=${tablePath}.do?sys_id=${sysId}`;
}

// --- Mock helpers (when URL unset or catalog disabled without item sys_id) ---
let mockSeq = 1000000 + crypto.randomInt(1000, 8999);

function nextMockNumber(prefix) {
  mockSeq += 1;
  return `${prefix}${String(mockSeq).padStart(7, "0")}`;
}

function mockSysId() {
  return crypto.randomBytes(16).toString("hex");
}

function formatWorkNote(message) {
  const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
  return `[Forge ${ts}] ${message}`;
}

// Verify connectivity to the configured ServiceNow instance.
export async function testConnection() {
  const url = instanceUrl();
  if (!url) throw new Error("ServiceNow instance URL is not configured");
  await snowRequest("get", "/api/now/table/sys_user", { params: { sysparm_limit: 1 }, retries: 0 });
  return { url, platform: "ServiceNow ITSM" };
}

// In-memory cache for portal-user → ServiceNow sys_user lookups (1h TTL).
const userCache = new Map();
const USER_CACHE_TTL_MS = 60 * 60 * 1000;

export function userLookupEnabled() {
  return isConfigured() && process.env.SERVICENOW_USER_LOOKUP_ENABLED !== "false";
}

/**
 * Resolve a portal user's ServiceNow sys_id by email (preferred) or username.
 * Returns { sysId, userName, email, name } or null.
 */
export async function resolveUserSysId({ email, username } = {}) {
  if (!userLookupEnabled()) return null;

  const emailKey = (email || "").trim().toLowerCase();
  const userKey = (username || "").trim().toLowerCase();
  const cacheKey = emailKey || userKey;
  if (!cacheKey) return null;

  const cached = userCache.get(cacheKey);
  if (cached && Date.now() - cached.at < USER_CACHE_TTL_MS) {
    return cached.value;
  }

  const parts = [];
  if (emailKey) parts.push(`email=${emailKey}`);
  if (userKey) parts.push(`user_name=${userKey}`);
  const query = parts.join("^OR");

  try {
    const rows = await snowRequest("get", "/api/now/table/sys_user", {
      params: {
        sysparm_query: query,
        sysparm_limit: 1,
        sysparm_fields: "sys_id,user_name,email,name",
      },
    });
    const row = Array.isArray(rows) ? rows[0] : rows;
    const value = row?.sys_id
      ? { sysId: row.sys_id, userName: row.user_name, email: row.email, name: row.name }
      : null;
    userCache.set(cacheKey, { at: Date.now(), value });
    return value;
  } catch (err) {
    console.warn(`[snow] user lookup failed for ${cacheKey}: ${err.message}`);
    return null;
  }
}

/**
 * Create catalog request (REQ) + requested item (RITM).
 * Falls back to mock numbers when instance URL is unset or catalog item not configured.
 */
export async function createCatalogRequest({
  shortDescription,
  description = "",
  requestedForSysId = null,
  openedBySysId = null,
  assignmentGroupSysId = null,
  requestId = null,
  kind = "vm",
} = {}) {
  const catItemSysId = (process.env.SERVICENOW_CATALOG_ITEM_SYS_ID || "").trim();
  const useReal = isConfigured() && catalogEnabled() && catItemSysId;

  if (!useReal) {
    const requestSysId = mockSysId();
    const ritmSysId = mockSysId();
    const requestNumber = nextMockNumber("REQ");
    const ritmNumber = nextMockNumber("RITM");
    const ticket = {
      requestNumber,
      requestSysId,
      ritmNumber,
      ritmSysId,
      requestUrl: snowUrl("sc_request", requestSysId),
      ritmUrl: snowUrl("sc_req_item", ritmSysId),
      mock: true,
      state: "submitted",
    };
    logAudit({
      actor: { username: "system", role: "system" },
      action: "servicenow.catalog.create",
      target: ritmNumber,
      detail: { requestId, requestNumber, ritmNumber, mock: true, kind },
    });
    return ticket;
  }

  const reqBody = {
    short_description: shortDescription || "Forge server provisioning request",
    description: description || "",
  };
  const requestedFor = requestedForSysId || process.env.SERVICENOW_REQUESTED_FOR_SYS_ID || null;
  const openedBy = openedBySysId || process.env.SERVICENOW_OPENED_BY_SYS_ID || null;
  const assignmentGroup = assignmentGroupSysId || process.env.SERVICENOW_ASSIGNMENT_GROUP_SYS_ID || null;
  if (requestedFor) reqBody.requested_for = requestedFor;
  if (openedBy) reqBody.opened_by = openedBy;
  if (assignmentGroup) reqBody.assignment_group = assignmentGroup;

  const reqResult = await snowRequest("post", "/api/now/table/sc_request", { data: reqBody });
  const requestSysId = reqResult.sys_id;
  const requestNumber = reqResult.number;

  const ritmBody = {
    request: requestSysId,
    cat_item: catItemSysId,
    short_description: shortDescription || "Forge server provisioning",
    description: description || "",
    quantity: 1,
  };
  if (assignmentGroup) ritmBody.assignment_group = assignmentGroup;

  const ritmResult = await snowRequest("post", "/api/now/table/sc_req_item", { data: ritmBody });
  const ritmSysId = ritmResult.sys_id;
  const ritmNumber = ritmResult.number;

  // Move RITM to Work in Progress
  await snowRequest("patch", `/api/now/table/sc_req_item/${ritmSysId}`, {
    data: { state: "2" },
  }).catch(() => {});

  const ticket = {
    requestNumber,
    requestSysId,
    ritmNumber,
    ritmSysId,
    requestUrl: snowUrl("sc_request", requestSysId),
    ritmUrl: snowUrl("sc_req_item", ritmSysId),
    mock: false,
    state: "work_in_progress",
  };

  logAudit({
    actor: { username: "system", role: "system" },
    action: "servicenow.catalog.create",
    target: ritmNumber,
    detail: { requestId, requestNumber, requestSysId, ritmNumber, ritmSysId, mock: false, kind },
  });

  return ticket;
}

/** Append a work note to a ServiceNow record (sc_req_item, sc_request, or incident). */
export async function addWorkNote({ table = "sc_req_item", sysId, message, mock = false } = {}) {
  if (!sysId || !message) return null;
  const note = formatWorkNote(message);

  if (mock || !isConfigured()) {
    logAudit({
      actor: { username: "system", role: "system" },
      action: "servicenow.worknote",
      target: sysId,
      detail: { table, message: note, mock: true },
    });
    return { note, mock: true };
  }

  await snowRequest("patch", `/api/now/table/${table}/${sysId}`, {
    data: { work_notes: note },
  });

  logAudit({
    actor: { username: "system", role: "system" },
    action: "servicenow.worknote",
    target: sysId,
    detail: { table, message: note },
  });

  return { note, mock: false };
}

/** Close RITM as complete or incomplete. */
export async function closeRitm({
  ritmSysId,
  success = true,
  closeNotes = "",
  mock = false,
} = {}) {
  if (!ritmSysId) return null;

  const state = success ? "3" : "4"; // 3=Closed Complete, 4=Closed Incomplete
  const notes = closeNotes || (success
    ? "Provisioning completed successfully via Forge."
    : "Provisioning failed via Forge.");

  if (mock || !isConfigured()) {
    logAudit({
      actor: { username: "system", role: "system" },
      action: "servicenow.ritm.close",
      target: ritmSysId,
      detail: { state, closeNotes: notes, mock: true },
    });
    return { state: success ? "closed_complete" : "closed_incomplete", mock: true };
  }

  await snowRequest("patch", `/api/now/table/sc_req_item/${ritmSysId}`, {
    data: {
      state,
      close_notes: notes,
      active: "false",
    },
  });

  logAudit({
    actor: { username: "system", role: "system" },
    action: "servicenow.ritm.close",
    target: ritmSysId,
    detail: { state, closeNotes: notes },
  });

  return { state: success ? "closed_complete" : "closed_incomplete", mock: false };
}

/** Create a real incident when configured; mock otherwise. */
export async function createIncident({
  shortDescription,
  description = "",
  callerId = "forge-portal",
  callerSysId = null,
  jobId = null,
  ritmSysId = null,
  mock = false,
} = {}) {
  if (!incidentsEnabled()) return null;

  if (mock || !isConfigured()) {
    const number = nextMockNumber("INC");
    const sysId = mockSysId();
    const incident = {
      number,
      sysId,
      state: "New",
      priority: "3 - Moderate",
      shortDescription: shortDescription || "Forge provisioning failure",
      description,
      callerId,
      jobId,
      url: snowUrl("incident", sysId),
      createdAt: new Date().toISOString(),
      mock: true,
    };
    logAudit({
      actor: { username: "system", role: "system" },
      action: "servicenow.incident.create",
      target: number,
      detail: { jobId, ritmSysId, shortDescription: incident.shortDescription, mock: true },
    });
    return incident;
  }

  const body = {
    short_description: shortDescription || "Forge provisioning failure",
    description: description || "",
    caller_id: callerSysId || process.env.SERVICENOW_CALLER_SYS_ID || undefined,
    urgency: "2",
    impact: "2",
  };
  if (ritmSysId) body.parent = ritmSysId;

  const result = await snowRequest("post", "/api/now/table/incident", { data: body });
  const incident = {
    number: result.number,
    sysId: result.sys_id,
    state: result.state || "New",
    shortDescription: body.short_description,
    description,
    callerId,
    jobId,
    url: snowUrl("incident", result.sys_id),
    createdAt: new Date().toISOString(),
    mock: false,
  };

  logAudit({
    actor: { username: "system", role: "system" },
    action: "servicenow.incident.create",
    target: incident.number,
    detail: { jobId, ritmSysId, sysId: incident.sysId, mock: false },
  });

  return incident;
}

// --- CMDB CI creation (ServiceNow) ---

export function cmdbEnabled() {
  return isConfigured() && process.env.SERVICENOW_CMDB_ENABLED !== "false";
}

function cmdbClass() {
  return (process.env.SERVICENOW_CMDB_CLASS || "cmdb_ci_server").trim() || "cmdb_ci_server";
}

function ciUrl(sysId, table = null) {
  const base = instanceUrl() || "https://dev-ssp.service-now.com";
  const tbl = table || cmdbClass();
  return `${base}/nav_to.do?uri=${tbl}.do?sys_id=${sysId}`;
}

/**
 * Create a server (or Linux server) CI in ServiceNow CMDB.
 */
export async function createCmdbCi({
  hostname,
  ip = null,
  vmid = null,
  cpu = null,
  memoryGB = null,
  diskGB = null,
  osName = null,
  environment = null,
  resourceType = "vm",
  ownedBySysId = null,
  jobId = null,
  requestId = null,
  mock = false,
} = {}) {
  if (!cmdbEnabled() && !mock) return null;
  if (!hostname) return null;

  const table = cmdbClass();

  if (mock || !isConfigured()) {
    const ciNumber = nextMockNumber("CI");
    const ciSysId = mockSysId();
    const ci = {
      ciNumber,
      ciSysId,
      ciClass: table,
      name: hostname,
      url: ciUrl(ciSysId, table),
      mock: true,
    };
    logAudit({
      actor: { username: "system", role: "system" },
      action: "servicenow.cmdb.create",
      target: ciNumber,
      detail: { hostname, vmid, ip, jobId, requestId, mock: true },
    });
    return ci;
  }

  const body = {
    name: hostname,
    host_name: hostname,
    short_description: `Forge ${resourceType}: ${hostname}`,
    virtual: true,
    install_status: "1",
    operational_status: "1",
    comments: [
      "Provisioned by Forge",
      vmid ? `Proxmox VMID: ${vmid}` : null,
      jobId ? `Forge job: ${jobId}` : null,
      requestId ? `Forge request: ${requestId}` : null,
      environment ? `Network: ${environment}` : null,
    ].filter(Boolean).join(" · "),
  };

  if (ip) body.ip_address = ip;
  if (cpu != null) body.cpu_count = String(cpu);
  if (memoryGB != null) body.ram = String(Number(memoryGB) * 1024);
  if (diskGB != null) body.disk_space = String(diskGB);
  if (osName) body.os = osName;

  const company = process.env.SERVICENOW_CMDB_COMPANY_SYS_ID;
  const location = process.env.SERVICENOW_CMDB_LOCATION_SYS_ID;
  const supportGroup = process.env.SERVICENOW_CMDB_SUPPORT_GROUP_SYS_ID
    || process.env.SERVICENOW_ASSIGNMENT_GROUP_SYS_ID;
  if (company) body.company = company;
  if (location) body.location = location;
  if (supportGroup) body.support_group = supportGroup;
  if (ownedBySysId) body.owned_by = ownedBySysId;

  const result = await snowRequest("post", `/api/now/table/${table}`, { data: body });
  const ci = {
    ciNumber: result.number || result.name || hostname,
    ciSysId: result.sys_id,
    ciClass: table,
    name: result.name || hostname,
    url: ciUrl(result.sys_id, table),
    mock: false,
  };

  logAudit({
    actor: { username: "system", role: "system" },
    action: "servicenow.cmdb.create",
    target: ci.ciNumber,
    detail: { hostname, vmid, ip, ciSysId: ci.ciSysId, jobId, requestId, mock: false },
  });

  return ci;
}

/** Link a CI to a task (RITM) via task_ci. */
export async function linkCiToTask({ ciSysId, taskSysId, mock = false } = {}) {
  if (!ciSysId || !taskSysId) return null;

  if (mock || !isConfigured()) {
    logAudit({
      actor: { username: "system", role: "system" },
      action: "servicenow.cmdb.link",
      target: taskSysId,
      detail: { ciSysId, taskSysId, mock: true },
    });
    return { linked: true, mock: true };
  }

  await snowRequest("post", "/api/now/table/task_ci", {
    data: { task: taskSysId, ci_item: ciSysId },
  });

  logAudit({
    actor: { username: "system", role: "system" },
    action: "servicenow.cmdb.link",
    target: taskSysId,
    detail: { ciSysId, taskSysId },
  });

  return { linked: true, mock: false };
}

export { formatWorkNote, snowUrl, ciUrl };
