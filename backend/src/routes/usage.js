import { Router } from "express";
import { requireAuth, requireAdmin } from "../middleware/auth.js";
import { isAdminRole } from "../constants/roles.js";
import { buildUsageReport, getMyUsage, getTeamUsageDetail } from "../services/usageService.js";

const router = Router();

router.get("/usage/me", requireAuth, async (req, res) => {
  try {
    res.json(await getMyUsage(req.user.username));
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

router.get("/usage/admin", requireAuth, requireAdmin, async (_req, res) => {
  try {
    res.json(await buildUsageReport());
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

router.get("/usage/teams/:name", requireAuth, async (req, res) => {
  try {
    const data = await getTeamUsageDetail(req.params.name, {
      viewer: req.user.username,
      isAdmin: isAdminRole(req.user.role),
    });
    res.json(data);
  } catch (e) {
    res.status(e.status || 502).json({ error: e.message });
  }
});

export default router;
