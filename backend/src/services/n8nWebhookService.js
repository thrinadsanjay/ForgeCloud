import axios from "axios";
import crypto from "crypto";
import https from "https";
import { logAudit } from "./auditService.js";
import { PRODUCT_SOURCE } from "../constants/brand.js";

// Outbound webhooks for n8n (or any HTTP automation). Fire-and-forget with optional HMAC signature.

const EVENTS = new Set([
  "request.submitted",
  "request.approved",
  "request.rejected",
  "provisioning.started",
  "provisioning.step",
  "provisioning.completed",
  "provisioning.failed",
  "provisioning.cancelled",
  "provisioning.rolled_back",
  "cmdb.ci.created",
]);

export function webhooksEnabled() {
  return process.env.N8N_WEBHOOK_ENABLED !== "false"
    && !!(process.env.N8N_WEBHOOK_URL || "").trim();
}

function webhookUrl() {
  return (process.env.N8N_WEBHOOK_URL || "").trim();
}

function timeoutMs() {
  return Number(process.env.N8N_HTTP_TIMEOUT_MS) || 10000;
}

let httpsAgent = null;
let httpsVerify = null;
function getHttpsAgent() {
  const verify = process.env.N8N_VERIFY_TLS === "true";
  if (!httpsAgent || httpsVerify !== verify) {
    httpsAgent = new https.Agent({ rejectUnauthorized: verify });
    httpsVerify = verify;
  }
  return httpsAgent;
}

function signBody(body, secret) {
  if (!secret) return null;
  return crypto.createHmac("sha256", secret).update(body).digest("hex");
}

/**
 * POST a lifecycle event to the configured n8n webhook URL.
 * Never throws — failures are logged and audited.
 */
export async function emitWebhook(event, payload = {}, { force = false } = {}) {
  if (!EVENTS.has(event)) {
    console.warn(`[n8n] unknown event: ${event}`);
    return { ok: false, skipped: true };
  }
  if (!force && !webhooksEnabled()) return { ok: false, skipped: true };

  const url = webhookUrl();
  const envelope = {
    event,
    timestamp: new Date().toISOString(),
    source: PRODUCT_SOURCE,
    ...payload,
  };
  const body = JSON.stringify(envelope);
  const secret = (process.env.N8N_WEBHOOK_SECRET || "").trim();
  const headers = {
    "Content-Type": "application/json",
    "X-Forge-Event": event,
  };
  const sig = signBody(body, secret);
  if (sig) headers["X-Forge-Signature"] = `sha256=${sig}`;

  try {
    const res = await axios.post(url, body, {
      headers,
      timeout: timeoutMs(),
      httpsAgent: url.startsWith("https") ? getHttpsAgent() : undefined,
      validateStatus: (s) => s < 500,
    });
    const ok = res.status >= 200 && res.status < 300;
    logAudit({
      actor: { username: "system", role: "system" },
      action: `n8n.webhook.${event}`,
      target: url,
      status: ok ? "success" : "failure",
      detail: { httpStatus: res.status, requestId: payload.request?.id, jobId: payload.job?.id },
    });
    if (!ok) {
      console.warn(`[n8n] webhook ${event} returned HTTP ${res.status}`);
    }
    return { ok, status: res.status };
  } catch (err) {
    logAudit({
      actor: { username: "system", role: "system" },
      action: `n8n.webhook.${event}`,
      target: url,
      status: "failure",
      detail: { error: err.message, requestId: payload.request?.id, jobId: payload.job?.id },
    });
    console.warn(`[n8n] webhook ${event} failed: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

/** Send a test ping — used by Admin → Settings. */
export async function testWebhook() {
  const url = webhookUrl();
  if (!url) throw new Error("n8n webhook URL is not configured");
  const result = await emitWebhook("request.submitted", {
    test: true,
    message: "Forge connectivity test from Settings",
  }, { force: true });
  if (!result.ok && !result.skipped) {
    throw new Error(result.error || `Webhook returned HTTP ${result.status}`);
  }
  return { url, ok: true };
}

export function fireWebhook(event, payload) {
  emitWebhook(event, payload).catch(() => {});
}
