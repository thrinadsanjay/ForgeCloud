import { Router } from "express";
import { listUsers, createUser, updateUserRole, deleteUser } from "../services/userStore.js";
import {
  listGroups, createGroup, deleteGroup, addMember, removeMember, setGroupQuotas,
} from "../services/groupStore.js";
import { getGroupUsage } from "../services/quotaService.js";
import { logAudit } from "../services/auditService.js";
import { requireAuth, requireAdmin } from "../middleware/auth.js";

const router = Router();

const adminOnly = [requireAuth, requireAdmin];

router.get("/users", adminOnly, (req, res) => {
  res.json(listUsers());
});

router.post("/users", adminOnly, (req, res) => {
  const { username, password, displayName, email, role } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: "username and password required" });
  }
  try {
    const user = createUser({ username, password, displayName, email, role: role || "user", source: "local" });
    logAudit({ actor: req.user, action: "user.create", target: username, detail: { role: user.role } });
    res.status(201).json(user);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.put("/users/:id/role", adminOnly, (req, res) => {
  const { role } = req.body;
  if (!["admin", "approver", "user"].includes(role)) {
    return res.status(400).json({ error: "role must be 'admin', 'approver', or 'user'" });
  }
  try {
    const user = updateUserRole(req.params.id, role);
    logAudit({ actor: req.user, action: "user.update_role", target: user.username, detail: { role } });
    res.json(user);
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

router.delete("/users/:id", adminOnly, (req, res) => {
  try {
    deleteUser(req.params.id);
    logAudit({ actor: req.user, action: "user.delete", target: req.params.id });
    res.json({ deleted: true });
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

router.get("/groups", adminOnly, async (req, res) => {
  const groups = listGroups();
  const withUsage = await Promise.all(groups.map(async (g) => {
    const usage = await getGroupUsage(g.name).catch(() => ({ vms: 0, cpu: 0, memoryGB: 0 }));
    return { ...g, usage };
  }));
  res.json(withUsage);
});

router.post("/groups", adminOnly, (req, res) => {
  try {
    const group = createGroup(req.body?.name);
    logAudit({ actor: req.user, action: "group.create", target: group.name });
    res.status(201).json(group);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.put("/groups/:name/quotas", adminOnly, (req, res) => {
  try {
    const group = setGroupQuotas(req.params.name, req.body || {});
    logAudit({
      actor: req.user,
      action: "group.set_quotas",
      target: group.name,
      detail: { quotas: group.quotas },
    });
    res.json(group);
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

router.delete("/groups/:name", adminOnly, (req, res) => {
  try {
    deleteGroup(req.params.name);
    logAudit({ actor: req.user, action: "group.delete", target: req.params.name });
    res.json({ deleted: true });
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

router.post("/groups/:name/members", adminOnly, (req, res) => {
  const username = String(req.body?.username || "").trim();
  if (!username) return res.status(400).json({ error: "username is required" });
  try {
    const group = addMember(req.params.name, username);
    logAudit({ actor: req.user, action: "group.add_member", target: req.params.name, detail: { username } });
    res.json(group);
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

router.delete("/groups/:name/members/:username", adminOnly, (req, res) => {
  try {
    const group = removeMember(req.params.name, req.params.username);
    logAudit({ actor: req.user, action: "group.remove_member", target: req.params.name, detail: { username: req.params.username } });
    res.json(group);
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

export default router;
