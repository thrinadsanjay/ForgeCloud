import { Router } from "express";
import { requireAuth, requireAdmin } from "../middleware/auth.js";
import { logAudit } from "../services/auditService.js";
import { getEffectiveSettings, updateSettings } from "../services/settingsStore.js";
import { testConnection, clearPveNodeCache } from "../services/proxmoxService.js";
import { testConnection as testK3sConnection } from "../services/k3sService.js";
import { testConnection as testServiceNowConnection } from "../services/servicenowService.js";
import { testConnection as testIpamConnection } from "../services/ipamService.js";
import { testWebhook as testN8nWebhook } from "../services/n8nWebhookService.js";
import { testAiConnection, formatAiProviderError } from "../services/aiChatService.js";
import { syncAnsibleContent, contentStatus, buildContentTemplateArchive } from "../services/ansibleContentService.js";

const router = Router();
// Per-route guards only — never router.use(requireAdmin) on a /api-mounted
// router (that would 403 every later /api route for non-admins).
const admin = [requireAuth, requireAdmin];

// GET /settings — current effective config, grouped for the admin UI.
// Secrets are returned only as an `isSet` flag, never as values.
router.get("/settings", ...admin, (req, res) => {
  res.json(getEffectiveSettings());
});

// PUT /settings — merge a { values: { KEY: value } } patch. Blank secrets are
// left unchanged. Returns the updated (masked) config.
router.put("/settings", ...admin, (req, res) => {
  const values = req.body?.values;
  if (!values || typeof values !== "object") {
    return res.status(400).json({ error: "values object is required" });
  }

  const updated = updateSettings(values);
  if (Object.keys(values).some((k) => k.startsWith("PROXMOX_"))) {
    clearPveNodeCache();
  }

  // Audit only — toast covers UI feedback; keep the bell for actionable items.
  const keys = Object.keys(values);
  logAudit({
    actor: req.user,
    action: "settings.update",
    target: "system settings",
    detail: { keys },
  });

  res.json(updated);
});

// POST /settings/proxmox/test — probe the current Proxmox connection.
// ?light=1 skips guest inventory for fast dashboard health checks.
router.post("/settings/proxmox/test", ...admin, async (req, res) => {
  try {
    const light = req.query.light === "1" || req.body?.light === true;
    const info = await testConnection({ light });
    res.json({ ok: true, ...info });
  } catch (err) {
    res.status(502).json({ ok: false, error: err.message });
  }
});

// POST /settings/k3s/test — probe the current K3s / Kubernetes API connection.
router.post("/settings/k3s/test", ...admin, async (req, res) => {
  try {
    const info = await testK3sConnection();
    res.json({ ok: true, ...info });
  } catch (err) {
    res.status(502).json({ ok: false, error: err.message });
  }
});

// POST /settings/servicenow/test — probe the linked ServiceNow instance.
router.post("/settings/servicenow/test", ...admin, async (req, res) => {
  try {
    const info = await testServiceNowConnection();
    res.json({ ok: true, ...info });
  } catch (err) {
    res.status(502).json({ ok: false, error: err.message });
  }
});

// POST /settings/ipam/test — probe the linked IPAM system.
router.post("/settings/ipam/test", ...admin, async (req, res) => {
  try {
    const info = await testIpamConnection();
    res.json({ ok: true, ...info });
  } catch (err) {
    res.status(502).json({ ok: false, error: err.message });
  }
});

// POST /settings/n8n/test — send a test event to the n8n webhook URL.
router.post("/settings/n8n/test", ...admin, async (req, res) => {
  try {
    const info = await testN8nWebhook();
    res.json({ ok: true, ...info });
  } catch (err) {
    res.status(502).json({ ok: false, error: err.message });
  }
});

// POST /settings/ai/test — smoke-test Gemini/OpenAI/etc with a tiny prompt.
router.post("/settings/ai/test", ...admin, async (req, res) => {
  try {
    const info = await testAiConnection();
    res.json({ ok: true, ...info });
  } catch (err) {
    res.status(502).json({ ok: false, error: err.message || formatAiProviderError(err) });
  }
});

router.get("/settings/ansible-content", ...admin, (req, res) => {
  res.json(contentStatus());
});

router.post("/settings/ansible-content/sync", ...admin, async (req, res) => {
  try {
    const result = await syncAnsibleContent();
    logAudit({
      actor: req.user,
      action: "ansible_content.sync",
      target: result.pin,
      detail: {
        usingBundled: result.usingBundled,
        hasCustom: result.hasCustom,
        message: result.message,
        onboard: result.onboard,
      },
    });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message, ...contentStatus() });
  }
});

router.get("/settings/ansible-content/template", ...admin, async (req, res) => {
  try {
    const pack = await buildContentTemplateArchive();
    logAudit({
      actor: req.user,
      action: "ansible_content.template_download",
      target: pack.filename,
    });
    res.setHeader("Content-Type", pack.contentType);
    res.setHeader("Content-Disposition", `attachment; filename="${pack.filename}"`);
    res.send(pack.buffer);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
