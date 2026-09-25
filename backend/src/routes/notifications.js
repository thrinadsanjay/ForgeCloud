import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import {
  listForUser,
  unreadCountForUser,
  markRead,
  markManyRead,
  markAllRead,
  dismissNotification,
  pruneExpired,
} from "../services/notificationStore.js";

const router = Router();
router.use(requireAuth);

// GET /notifications/inbox — caller's notifications (own + role), newest first.
// ?category=action|update|all  ?limit=50
router.get("/notifications/inbox", (req, res) => {
  pruneExpired({ persist: true });
  const category = String(req.query.category || "all").toLowerCase();
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
  const cat = ["action", "update", "all"].includes(category) ? category : "all";
  res.json({
    notifications: listForUser(req.user, { limit, category: cat === "all" ? null : cat }),
    unread: unreadCountForUser(req.user),
    actionUnread: unreadCountForUser(req.user, { category: "action" }),
    updateUnread: unreadCountForUser(req.user, { category: "update" }),
  });
});

router.post("/notifications/:id/read", (req, res) => {
  const ok = markRead(req.params.id, req.user);
  if (!ok) return res.status(404).json({ error: "Notification not found" });
  res.json({
    ok: true,
    unread: unreadCountForUser(req.user),
    actionUnread: unreadCountForUser(req.user, { category: "action" }),
  });
});

router.post("/notifications/read-many", (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
  const changed = markManyRead(ids, req.user);
  res.json({
    ok: true,
    changed,
    unread: unreadCountForUser(req.user),
    actionUnread: unreadCountForUser(req.user, { category: "action" }),
  });
});

router.post("/notifications/read-all", (req, res) => {
  const category = String(req.body?.category || req.query.category || "all").toLowerCase();
  const cat = ["action", "update", "all"].includes(category) ? category : "all";
  const changed = markAllRead(req.user, { category: cat === "all" ? null : cat });
  res.json({
    ok: true,
    changed,
    unread: unreadCountForUser(req.user),
    actionUnread: unreadCountForUser(req.user, { category: "action" }),
  });
});

router.delete("/notifications/:id", (req, res) => {
  const ok = dismissNotification(req.params.id, req.user);
  if (!ok) return res.status(404).json({ error: "Notification not found" });
  res.json({
    ok: true,
    unread: unreadCountForUser(req.user),
    actionUnread: unreadCountForUser(req.user, { category: "action" }),
  });
});

export default router;
