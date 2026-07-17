import axios from "axios";
import https from "https";
import crypto from "crypto";
import { logAudit } from "./auditService.js";

// --- Internal provisioning integrations ---
//
// The internal workflow (catalogService) is a list of steps, each
// declaring the `system` (team API / Ansible playbook) it calls. This module
// executes one step: when that system's endpoint is configured in the admin
// Settings tab (INTERNAL_<SYSTEM>_URL / INTERNAL_<SYSTEM>_TOKEN) it makes the
// real authenticated HTTP call; otherwise it returns a realistic simulated
// response so the workflow still completes end to end.
//
// Both paths return { system, reference, detail, fields }. `fields` is merged
// into the workflow context so later steps can reference earlier results (e.g.
// the datacenter, reserved IP, or created VMID). Endpoints are read from
// process.env at call time so a saved Settings change takes effect immediately.

const timeoutMs = () => Number(process.env.INTERNAL_HTTP_TIMEOUT_MS) || 30000;

// Reuse one HTTPS agent per TLS-verify setting rather than rebuilding per call.
// Verification is opt-in (env === "true"), consistent with the Proxmox/K3s
// settings, since internal endpoints often present private-CA certificates.
let agent = null;
let agentVerify = null;
function httpsAgent() {
  const verify = process.env.INTERNAL_VERIFY_TLS === "true";
  if (!agent || agentVerify !== verify) {
    agent = new https.Agent({ rejectUnauthorized: verify });
    agentVerify = verify;
  }
  return agent;
}

// Whether a system's endpoint has been configured in Settings. When false, the
// corresponding step is simulated rather than calling out.
export function isSystemConfigured(system) {
  if (!system) return false;
  const key = String(system).toUpperCase();
  const enabled = process.env[`INTERNAL_${key}_ENABLED`];
  // Explicit disable wins; missing ENABLE flag falls back to "URL present".
  if (enabled === "false" || enabled === "0") return false;
  const url = process.env[`INTERNAL_${key}_URL`];
  if (!(url && String(url).trim())) return false;
  if (enabled === "true" || enabled === "1") return true;
  // Legacy: URL set before ENABLE toggles existed → treat as configured.
  return enabled == null || String(enabled).trim() === "";
}

// First present (non-empty) value among candidate keys.
function pick(obj, keys) {
  for (const k of keys) {
    if (obj && obj[k] != null && obj[k] !== "") return obj[k];
  }
  return undefined;
}

// Cross-step fields that are lifted from a real response's top level (if not
// already nested under `fields`) so later steps can consume them.
const CARRY_FIELDS = ["ip", "gateway", "subnet", "vlan", "fqdn", "datacenter", "serverStreet", "template", "vmid", "node", "datastore"];

// --- Simulated-response helpers (used when a system isn't configured) ---
const rand = (min, max) => crypto.randomInt(min, max + 1);
const ref = (prefix, digits = 7) => `${prefix}${String(rand(0, 10 ** digits - 1)).padStart(digits, "0")}`;

// POST to a configured internal system endpoint. Wraps any HTTP error with the
// system + status so a real integration failure surfaces on the job.
async function callSystem(system, action, body) {
  const key = system.toUpperCase();
  const url = process.env[`INTERNAL_${key}_URL`];
  const token = process.env[`INTERNAL_${key}_TOKEN`];

  const headers = { "Content-Type": "application/json", Accept: "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;

  let res;
  try {
    res = await axios.post(url, body, {
      headers,
      timeout: timeoutMs(),
      httpsAgent: String(url).startsWith("https") ? httpsAgent() : undefined,
    });
  } catch (err) {
    const status = err.response?.status;
    const detail = err.response?.data
      ? JSON.stringify(err.response.data).slice(0, 300)
      : err.message;
    logAudit({
      actor: { username: "system", role: "system" },
      action: `internal.${key}.${action}`,
      target: url,
      status: "failure",
      detail: { httpStatus: status || null, error: detail },
    });
    throw new Error(`${system} call failed${status ? ` (HTTP ${status})` : ""}: ${detail}`);
  }

  const data = res.data ?? {};
  logAudit({
    actor: { username: "system", role: "system" },
    action: `internal.${key}.${action}`,
    target: String(pick(data, ["reference", "id", "number", "ip", "fqdn"]) || url),
    status: "success",
    detail: { httpStatus: res.status },
  });
  return data;
}

// Build a realistic simulated result for a step, keyed by step.key. Produces a
// reference + any fields later steps depend on.
function simulate(step, ctx) {
  const host = (ctx.hostname || "host").toLowerCase();
  switch (step.key) {
    case "datacenter": {
      const datacenter = ["DC Halle", "DC Ghislenghien"][rand(0, 1)];
      return { reference: datacenter, detail: `Target datacenter determined: ${datacenter}`, fields: { datacenter } };
    }
    case "server-street": {
      const serverStreet = `STR-${String(rand(1, 24)).padStart(2, "0")}`;
      return { reference: serverStreet, detail: `Reserved server street ${serverStreet} in ${ctx.datacenter || "the datacenter"}`, fields: { serverStreet } };
    }
    case "iso-template": {
      const template = `rhel9-std-${rand(2024, 2026)}.${String(rand(1, 12)).padStart(2, "0")}`;
      return { reference: template, detail: `Using build template ${template}`, fields: { template } };
    }
    case "ip": {
      const octet2 = rand(20, 60);
      const octet3 = rand(10, 240);
      const ip = `10.${octet2}.${octet3}.${rand(20, 240)}`;
      const gateway = `10.${octet2}.${octet3}.1`;
      const subnet = `10.${octet2}.${octet3}.0/24`;
      const vlan = `VLAN${rand(100, 199)}`;
      return { reference: ip, detail: `Reserved ${ip}/24 (gw ${gateway}, ${vlan})`, fields: { ip, gateway, subnet, vlan } };
    }
    case "vm-create": {
      const vmid = rand(10000, 99999);
      const node = `esx-${String(rand(1, 32)).padStart(2, "0")}.dc.internal`;
      return { reference: String(vmid), detail: `Created VM ${host} (id ${vmid}) on ${node}`, fields: { vmid, node } };
    }
    case "omi":
      return { reference: ref("AAP-", 7), detail: "OMI monitoring agent installed and enrolled" };
    case "ppdm":
      return { reference: ref("AAP-", 7), detail: "PPDM backup tag applied" };
    case "cmdb":
      return { reference: ref("CI", 8), detail: `CMDB configuration item created for ${host}` };
    case "guardicore":
      return { reference: ref("AAP-", 7), detail: "Guardicore micro-segmentation agent installed" };
    case "defender":
      return { reference: ref("AAP-", 7), detail: "Microsoft Defender agent installed and onboarded" };
    case "grant-perms":
      return { reference: ref("PERM-", 6), detail: `VM permissions granted to ${ctx.requestedBy || "requester"}` };
    default:
      return { reference: ref("OK-", 6), detail: `${step.label} completed` };
  }
}

// Execute a single workflow step: real call when its system is configured,
// simulated response otherwise. `via` (the team/API name) is used as the
// result's `system` label shown in the monitor and summary.
export async function executeStep(step, ctx) {
  if (isSystemConfigured(step.system)) {
    const data = await callSystem(step.system, step.key, {
      action: step.key,
      hostname: ctx.hostname,
      cpu: ctx.cpu,
      memoryGB: ctx.memoryGB,
      diskGB: ctx.diskGB,
      requestedBy: ctx.requestedBy,
      // Carry forward everything gathered so far (datacenter, ip, vmid, …).
      context: ctx,
    });
    const fields = { ...(data.fields || {}) };
    for (const k of CARRY_FIELDS) {
      if (data[k] != null && fields[k] == null) fields[k] = data[k];
    }
    return {
      system: step.via,
      reference: pick(data, ["reference", "id", "number", "ip", "fqdn", "name"]) ?? null,
      detail: pick(data, ["detail", "message"]) || `${step.via} completed`,
      fields,
    };
  }

  const sim = simulate(step, ctx);
  logAudit({
    actor: { username: "system", role: "system" },
    action: `internal.${String(step.system || step.key).toUpperCase()}.${step.key}`,
    target: String(sim.reference ?? step.key),
    detail: { simulated: true },
  });
  return { system: step.via, reference: sim.reference ?? null, detail: sim.detail, fields: sim.fields || {} };
}
