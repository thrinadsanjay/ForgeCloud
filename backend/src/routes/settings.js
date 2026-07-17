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

const router = Router();
router.use(requireAuth, requireAdmin);

// GET /settings — current effective config, grouped for the admin UI.
// Secrets are returned only as an `isSet` flag, never as values.
router.get("/settings", (req, res) => {
  res.json(getEffectiveSettings());
});

// PUT /settings — merge a { values: { KEY: value } } patch. Blank secrets are
// left unchanged. Returns the updated (masked) config.
router.put("/settings", (req, res) => {
  const values = req.body?.values;
  if (!values || typeof values !== "object") {
    return res.status(400).json({ error: "values object is required" });
  }

  const updated = updateSettings(values);
  if (Object.keys(values).some((k) => k.startsWith("PROXMOX_"))) {
    clearPveNodeCache();
  }

  // Audit the set of keys that changed, never the values (may be secrets).
  logAudit({
    actor: req.user,
    action: "settings.update",
    target: "system settings",
    detail: { keys: Object.keys(values) },
  });

  res.json(updated);
});

// POST /settings/proxmox/test — probe the current Proxmox connection.
router.post("/settings/proxmox/test", async (req, res) => {
  try {
    const info = await testConnection();
    res.json({ ok: true, ...info });
  } catch (err) {
    res.status(502).json({ ok: false, error: err.message });
  }
});

// POST /settings/k3s/test — probe the current K3s / Kubernetes API connection.
router.post("/settings/k3s/test", async (req, res) => {
  try {
    const info = await testK3sConnection();
    res.json({ ok: true, ...info });
  } catch (err) {
    res.status(502).json({ ok: false, error: err.message });
  }
});

// POST /settings/servicenow/test — probe the linked ServiceNow instance.
router.post("/settings/servicenow/test", async (req, res) => {
  try {
    const info = await testServiceNowConnection();
    res.json({ ok: true, ...info });
  } catch (err) {
    res.status(502).json({ ok: false, error: err.message });
  }
});

// POST /settings/ipam/test — probe the linked IPAM system.
router.post("/settings/ipam/test", async (req, res) => {
  try {
    const info = await testIpamConnection();
    res.json({ ok: true, ...info });
  } catch (err) {
    res.status(502).json({ ok: false, error: err.message });
  }
});

// POST /settings/n8n/test — send a test event to the n8n webhook URL.
router.post("/settings/n8n/test", async (req, res) => {
  try {
    const info = await testN8nWebhook();
    res.json({ ok: true, ...info });
  } catch (err) {
    res.status(502).json({ ok: false, error: err.message });
  }
});

// POST /settings/ai/test — smoke-test Gemini/OpenAI/etc with a tiny prompt.
router.post("/settings/ai/test", async (req, res) => {
  try {
    const info = await testAiConnection();
    res.json({ ok: true, ...info });
  } catch (err) {
    res.status(502).json({ ok: false, error: err.message || formatAiProviderError(err) });
  }
});

export default router;
