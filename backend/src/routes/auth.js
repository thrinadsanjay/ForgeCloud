import { Router } from "express";
import {
  issueToken,
  isOidcConfigured,
  getOidcAuthUrl,
  exchangeOidcCode,
} from "../services/authService.js";
import {
  findByUsername,
  findById,
  verifyPassword,
  upsertExternalUser,
  updateUserPreferences,
} from "../services/userStore.js";
import { logAudit } from "../services/auditService.js";
import { requireAuth } from "../middleware/auth.js";
import { createPat, listPats, revokePat } from "../services/patStore.js";

const router = Router();

// --- Local login ---
router.post("/auth/login", (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: "username and password required" });
  }
  const user = findByUsername(username);
  if (!user || user.source !== "local" || !verifyPassword(user, password)) {
    logAudit({ actor: { username }, action: "auth.login", status: "failure", detail: { reason: "bad credentials" } });
    return res.status(401).json({ error: "Invalid credentials" });
  }
  const token = issueToken(user);
  logAudit({ actor: user, action: "auth.login", status: "success", detail: { method: "local" } });
  const { passwordHash, ...safe } = user;
  res.json({ token, user: safe });
});

async function oidcLoginUrlHandler(req, res) {
  if (!isOidcConfigured()) {
    return res.status(400).json({ error: "OIDC SSO is not configured" });
  }
  try {
    const url = await getOidcAuthUrl(req.query.state);
    res.json({ url });
  } catch (err) {
    res.status(502).json({ error: err.message || "Failed to build OIDC login URL" });
  }
}

async function oidcCallbackHandler(req, res) {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: "code required" });
  if (!isOidcConfigured()) {
    return res.status(400).json({ error: "OIDC SSO is not configured" });
  }
  try {
    const profile = await exchangeOidcCode(code);
    const user = upsertExternalUser({
      username: profile.username,
      displayName: profile.displayName,
      email: profile.email,
      source: "oidc",
    });
    const token = issueToken(user);
    logAudit({ actor: user, action: "auth.login", status: "success", detail: { method: "oidc" } });
    res.json({ token, user });
  } catch (err) {
    logAudit({
      actor: { username: "unknown" },
      action: "auth.login",
      status: "failure",
      detail: { method: "oidc", error: err.message },
    });
    res.status(502).json({ error: `OIDC login failed: ${err.message}` });
  }
}

// --- OIDC SSO (generic OpenID Connect) ---
router.get("/auth/oidc/status", (req, res) => {
  res.json({ enabled: isOidcConfigured() });
});
router.get("/auth/oidc/login-url", oidcLoginUrlHandler);
router.post("/auth/oidc/callback", oidcCallbackHandler);

// Legacy Entra path aliases (same handlers)
router.get("/auth/entra/status", (req, res) => {
  res.json({ enabled: isOidcConfigured() });
});
router.get("/auth/entra/login-url", oidcLoginUrlHandler);
router.post("/auth/entra/callback", oidcCallbackHandler);

// --- Who am I ---
router.get("/auth/me", requireAuth, (req, res) => {
  const stored = findById(req.user.id);
  if (!stored) {
    return res.status(404).json({ error: "User not found" });
  }
  const { passwordHash, ...safe } = stored;
  res.json({ user: safe });
});

router.get("/auth/preferences", requireAuth, (req, res) => {
  const stored = findById(req.user.id);
  if (!stored) {
    return res.status(404).json({ error: "User not found" });
  }
  res.json({ preferences: stored.preferences || { theme: "slate", showBackground: true } });
});

router.put("/auth/preferences", requireAuth, (req, res) => {
  const { preferences } = req.body || {};
  if (!preferences || typeof preferences !== "object") {
    return res.status(400).json({ error: "preferences object required" });
  }
  const allowedThemes = ["slate", "forest", "sunrise"];
  if (preferences.theme && !allowedThemes.includes(preferences.theme)) {
    return res.status(400).json({ error: `theme must be one of: ${allowedThemes.join(", ")}` });
  }
  if (preferences.showBackground !== undefined && typeof preferences.showBackground !== "boolean") {
    return res.status(400).json({ error: "showBackground must be boolean" });
  }
  try {
    const user = updateUserPreferences(req.user.id, preferences);
    res.json({ preferences: user.preferences });
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

// --- Personal Access Tokens (for Terraform / Ansible / CLI) ---
router.get("/auth/pats", requireAuth, (req, res) => {
  res.json({ pats: listPats(req.user.username) });
});

router.post("/auth/pats", requireAuth, (req, res) => {
  const { name, expiresInDays } = req.body || {};
  const { token, pat } = createPat({
    username: req.user.username,
    role: req.user.role,
    name,
    expiresInDays,
  });
  logAudit({ actor: req.user, action: "auth.pat.create", target: pat.id, detail: { name: pat.name, expiresAt: pat.expiresAt } });
  // The raw token is returned exactly once — the client must store it now.
  res.status(201).json({ token, pat });
});

router.delete("/auth/pats/:id", requireAuth, (req, res) => {
  const ok = revokePat(req.user.username, req.params.id);
  logAudit({ actor: req.user, action: "auth.pat.revoke", target: req.params.id, status: ok ? "success" : "failure" });
  if (!ok) return res.status(404).json({ error: "Token not found" });
  res.json({ ok: true });
});

export default router;
