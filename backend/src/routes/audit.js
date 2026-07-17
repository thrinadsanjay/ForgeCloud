import { Router } from "express";
import { listAudit } from "../services/auditService.js";
import { requireAuth, requireAdmin } from "../middleware/auth.js";

const router = Router();

router.get("/audit", requireAuth, requireAdmin, (req, res) => {
  const { limit, action, username } = req.query;
  res.json(
    listAudit({
      limit: limit ? Number(limit) : 200,
      action: action || undefined,
      username: username || undefined,
    })
  );
});

export default router;
