import { Router } from "express";
import { requireAuth, requireAdmin } from "../middleware/auth.js";
import {
  adminListPackages,
  adminUpsertPackage,
  adminDeletePackage,
  adminListApplicationRoles,
  adminUpsertApplicationRole,
  adminDeleteApplicationRole,
  adminListBaselines,
  adminUpsertBaseline,
  adminDeleteBaseline,
  adminListWorkflows,
  adminUpsertWorkflow,
  adminDeleteWorkflow,
  adminListCatalogTemplates,
  adminUpsertCatalogTemplate,
  adminDeleteCatalogTemplate,
  adminListTemplateDefaults,
  adminUpsertTemplateDefault,
  adminDeleteTemplateDefault,
  adminListInstanceSizes,
  adminUpsertInstanceSize,
  adminDeleteInstanceSize,
  listPackages,
  listBaselines,
  getHostnameFormatInfo,
  setHostnameFormat,
  previewHostname,
} from "../services/catalogService.js";

const router = Router();
router.use(requireAuth);
router.use(requireAdmin);

// Public catalog endpoints (also on api.js) — duplicated here for admin namespace clarity
router.get("/catalog/packages", (req, res) => res.json(listPackages()));
router.get("/catalog/baselines", (req, res) => res.json(listBaselines()));

// Packages
router.get("/admin/packages", async (req, res) => {
  res.json(await adminListPackages());
});
router.post("/admin/packages", async (req, res) => {
  const row = await adminUpsertPackage(req.body);
  res.status(201).json(row);
});
router.put("/admin/packages/:id", async (req, res) => {
  const row = await adminUpsertPackage({ ...req.body, id: req.params.id });
  res.json(row);
});
router.delete("/admin/packages/:id", async (req, res) => {
  await adminDeletePackage(req.params.id);
  res.json({ ok: true });
});

router.get("/admin/application-roles", async (req, res) => {
  res.json(await adminListApplicationRoles());
});
router.post("/admin/application-roles", async (req, res) => {
  try {
    res.json(await adminUpsertApplicationRole(req.body || {}));
  } catch (err) {
    res.status(err.status || 502).json({ error: err.message });
  }
});
router.put("/admin/application-roles/:id", async (req, res) => {
  try {
    res.json(await adminUpsertApplicationRole({ ...req.body, id: req.params.id }));
  } catch (err) {
    res.status(err.status || 502).json({ error: err.message });
  }
});
router.delete("/admin/application-roles/:id", async (req, res) => {
  await adminDeleteApplicationRole(req.params.id);
  res.json({ ok: true });
});

// Security baselines
router.get("/admin/baselines", async (req, res) => {
  res.json(await adminListBaselines());
});
router.post("/admin/baselines", async (req, res) => {
  const row = await adminUpsertBaseline(req.body);
  res.status(201).json(row);
});
router.put("/admin/baselines/:id", async (req, res) => {
  const row = await adminUpsertBaseline({ ...req.body, id: req.params.id });
  res.json(row);
});
router.delete("/admin/baselines/:id", async (req, res) => {
  await adminDeleteBaseline(req.params.id);
  res.json({ ok: true });
});

// Workflows
router.get("/admin/workflows", async (req, res) => {
  res.json(await adminListWorkflows());
});
router.post("/admin/workflows", async (req, res) => {
  const row = await adminUpsertWorkflow(req.body);
  res.status(201).json(row);
});
router.put("/admin/workflows/:id", async (req, res) => {
  const row = await adminUpsertWorkflow({ ...req.body, id: req.params.id });
  res.json(row);
});
router.delete("/admin/workflows/:id", async (req, res) => {
  await adminDeleteWorkflow(req.params.id);
  res.json({ ok: true });
});

// Container / stack catalog templates
router.get("/admin/catalog-templates", async (req, res) => {
  res.json(await adminListCatalogTemplates(req.query.kind));
});
router.post("/admin/catalog-templates", async (req, res) => {
  const row = await adminUpsertCatalogTemplate(req.body);
  res.status(201).json(row);
});
router.put("/admin/catalog-templates/:id", async (req, res) => {
  const row = await adminUpsertCatalogTemplate({ ...req.body, id: req.params.id });
  res.json(row);
});
router.delete("/admin/catalog-templates/:id", async (req, res) => {
  await adminDeleteCatalogTemplate(req.params.id);
  res.json({ ok: true });
});

// Template defaults (MEAN, MERN, LAMP, etc.)
router.get("/admin/template-defaults", async (req, res) => {
  res.json(await adminListTemplateDefaults());
});
router.post("/admin/template-defaults", async (req, res) => {
  const { presetKey, items } = req.body;
  const row = await adminUpsertTemplateDefault(presetKey, items);
  res.status(201).json(row);
});
router.put("/admin/template-defaults/:presetKey", async (req, res) => {
  const row = await adminUpsertTemplateDefault(req.params.presetKey, req.body.items);
  res.json(row);
});
router.delete("/admin/template-defaults/:presetKey", async (req, res) => {
  await adminDeleteTemplateDefault(req.params.presetKey);
  res.json({ ok: true });
});

// Instance sizes (T-shirt sizing: CPU + RAM per size)
router.get("/admin/instance-sizes", async (req, res) => {
  res.json(await adminListInstanceSizes());
});
router.post("/admin/instance-sizes", async (req, res) => {
  const row = await adminUpsertInstanceSize(req.body);
  res.status(201).json(row);
});
router.put("/admin/instance-sizes/:key", async (req, res) => {
  const row = await adminUpsertInstanceSize({ ...req.body, key: req.params.key });
  res.json(row);
});
router.delete("/admin/instance-sizes/:key", async (req, res) => {
  await adminDeleteInstanceSize(req.params.key);
  res.json({ ok: true });
});

// Default hostname format for chat / provision suggestions
router.get("/admin/hostname-format", (req, res) => {
  res.json(getHostnameFormatInfo());
});
router.put("/admin/hostname-format", async (req, res) => {
  try {
    const info = await setHostnameFormat(req.body?.format, {
      applications: req.body?.applications,
    });
    res.json({
      ...info,
      preview: previewHostname(info.format, {
        os: "ubuntu",
        kind: "vm",
        user: req.user?.username || "admin",
        env: "dev",
        app: info.applications?.[0] || "web",
      }),
    });
  } catch (err) {
    res.status(err.status === 400 ? 400 : 502).json({ error: err.message });
  }
});
router.post("/admin/hostname-format/preview", (req, res) => {
  const info = getHostnameFormatInfo();
  const format = req.body?.format || info.format;
  res.json({
    format,
    preview: previewHostname(format, {
      os: req.body?.os || "ubuntu",
      kind: req.body?.kind || "vm",
      user: req.body?.user || req.user?.username || "admin",
      env: req.body?.env || "dev",
      app: req.body?.app || req.body?.application || info.applications?.[0] || "web",
    }),
  });
});

// Forge Assist usage (derived from saved chat sessions)
router.get("/admin/chat-analytics", async (req, res) => {
  const { getChatAnalytics } = await import("../services/chatStore.js");
  res.json(getChatAnalytics());
});

export default router;
