import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { listForUser, unreadCountForUser, markRead, markAllRead } from "../services/notificationStore.js";

const router = Router();
router.use(requireAuth);

// GET /notifications/inbox — the caller's notifications (own + role), newest first.
router.get("/notifications/inbox", (req, res) => {
  res.json({
    notifications: listForUser(req.user),
    unread: unreadCountForUser(req.user),
  });
});

// POST /notifications/:id/read — mark one as read.
router.post("/notifications/:id/read", (req, res) => {
  const ok = markRead(req.params.id, req.user);
  if (!ok) return res.status(404).json({ error: "Notification not found" });
  res.json({ ok: true, unread: unreadCountForUser(req.user) });
});

// POST /notifications/read-all — mark all of the caller's notifications read.
router.post("/notifications/read-all", (req, res) => {
  const changed = markAllRead(req.user);
  res.json({ ok: true, changed, unread: unreadCountForUser(req.user) });
});

export default router;
