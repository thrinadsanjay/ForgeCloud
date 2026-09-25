import { Router } from "express";
import crypto from "crypto";
import { getTicketByRitm, getTicketByRequestId } from "../services/servicenowTicketStore.js";
import {
  approveProvisionRequest,
  rejectProvisionRequest,
  getProvisionRequest,
} from "../services/requestStore.js";
import { logAudit } from "../services/auditService.js";

const router = Router();

function webhookSecret() {
  return (
    process.env.SERVICENOW_WEBHOOK_SECRET ||
    process.env.N8N_WEBHOOK_SECRET ||
    ""
  ).trim();
}

function timingSafeEqualStr(a, b) {
  const aa = Buffer.from(String(a || ""), "utf8");
  const bb = Buffer.from(String(b || ""), "utf8");
  if (aa.length !== bb.length) return false;
  return crypto.timingSafeEqual(aa, bb);
}

/** Shared-secret or HMAC auth for inbound ServiceNow / n8n callbacks. */
function requireInboundWebhook(req, res, next) {
  const secret = webhookSecret();
  if (!secret) {
    return res.status(503).json({ error: "SERVICENOW_WEBHOOK_SECRET is not configured" });
  }

  const headerSecret =
    req.get("X-Forge-Webhook-Secret") ||
    req.get("X-Webhook-Secret") ||
    "";
  if (headerSecret && timingSafeEqualStr(headerSecret, secret)) {
    return next();
  }

  const auth = req.get("Authorization") || "";
  if (auth.startsWith("Bearer ") && timingSafeEqualStr(auth.slice(7).trim(), secret)) {
    return next();
  }

  const sigHeader = req.get("X-Forge-Signature") || "";
  const match = /^sha256=(.+)$/i.exec(sigHeader);
  if (match) {
    const body = typeof req.body === "string"
      ? req.body
      : JSON.stringify(req.body || {});
    const expected = crypto.createHmac("sha256", secret).update(body).digest("hex");
    if (timingSafeEqualStr(match[1].trim(), expected)) {
      return next();
    }
  }

  return res.status(401).json({ error: "Invalid webhook signature or secret" });
}

router.use(requireInboundWebhook);

/**
 * Dual approval (portal OR ServiceNow — first wins).
 * POST /api/integrations/servicenow/approval
 * Body: { decision, ritmNumber|ritmSysId|requestId, approver, comments }
 */
router.post("/servicenow/approval", async (req, res) => {
  const decision = String(req.body?.decision || "").trim().toLowerCase();
  if (!["approve", "approved", "reject", "rejected"].includes(decision)) {
    return res.status(400).json({ error: "decision must be approve or reject" });
  }

  const requestId = resolveRequestId(req.body);
  if (!requestId) {
    return res.status(404).json({ error: "No Forge request matched ritmNumber/ritmSysId/requestId" });
  }

  const request = getProvisionRequest(requestId);
  if (!request) {
    return res.status(404).json({ error: "Request not found" });
  }

  const actor = String(req.body?.approver || req.body?.approvedBy || "servicenow").trim() || "servicenow";
  const comments = String(req.body?.comments || req.body?.reason || "").trim();
  const isApprove = decision === "approve" || decision === "approved";

  if (request.status !== "pending_approval") {
    return res.json({
      ok: true,
      alreadyDecided: true,
      request,
      message: `Request already ${request.status} (approvalSource=${request.approvalSource || "unknown"})`,
    });
  }

  try {
    if (isApprove) {
      const result = await approveProvisionRequest({
        id: requestId,
        approver: actor,
        source: "servicenow",
      });
      logAudit({
        actor: { username: actor, role: "servicenow" },
        action: "request.approve.servicenow",
        target: `Request ${requestId}`,
        detail: { requestId, jobId: result?.job?.id || null, ritm: req.body?.ritmNumber },
      });
      return res.json({
        ok: true,
        alreadyDecided: !!result?.alreadyDecided,
        request: result?.request,
        job: result?.job || null,
      });
    }

    const rejected = rejectProvisionRequest({
      id: requestId,
      reviewer: actor,
      reason: comments || "Rejected in ServiceNow",
      source: "servicenow",
    });
    logAudit({
      actor: { username: actor, role: "servicenow" },
      action: "request.reject.servicenow",
      target: `Request ${requestId}`,
      detail: { requestId, reason: comments, ritm: req.body?.ritmNumber },
    });
    return res.json({ ok: true, alreadyDecided: false, request: rejected });
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }
});

function resolveRequestId(body = {}) {
  if (body.requestId) {
    const r = getProvisionRequest(body.requestId);
    if (r) return r.id;
  }
  const ticket = getTicketByRitm({
    ritmNumber: body.ritmNumber || body.number,
    ritmSysId: body.ritmSysId || body.sys_id || body.sysId,
  });
  if (ticket?.requestId) return ticket.requestId;

  // Direct requestId on ticket map even if getProvisionRequest missed (unlikely)
  if (body.requestId && getTicketByRequestId(body.requestId)) {
    return body.requestId;
  }
  return null;
}

export default router;
