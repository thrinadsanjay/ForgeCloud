import { verifyToken } from "../services/authService.js";
import { verifyPat, isPatToken } from "../services/patStore.js";
import { findByUsername } from "../services/userStore.js";
import { canReviewDeployments, isAdminRole } from "../constants/roles.js";

export function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) {
    return res.status(401).json({ error: "Authentication required" });
  }

  // Personal Access Tokens let Terraform / Ansible / CLI clients authenticate
  // without an interactive login. They carry the owning user's identity + role.
  if (isPatToken(token)) {
    const pat = verifyPat(token);
    if (!pat) {
      return res.status(401).json({ error: "Invalid or expired API token" });
    }
    const user = findByUsername(pat.username);
    req.user = {
      id: user?.id || pat.username,
      username: pat.username,
      displayName: user?.displayName || pat.username,
      role: pat.role || user?.role || "user",
      source: "pat",
    };
    return next();
  }

  try {
    const claims = verifyToken(token);
    req.user = {
      id: claims.sub,
      username: claims.username,
      displayName: claims.displayName,
      role: claims.role,
      source: claims.source,
    };
    next();
  } catch (e) {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

export function requireAdmin(req, res, next) {
  if (!isAdminRole(req.user?.role)) {
    return res.status(403).json({ error: "Admin access required" });
  }
  next();
}

/** Admins and Deployment Approvers — approve/reject size-policy holds. */
export function requireReviewer(req, res, next) {
  if (!canReviewDeployments(req.user?.role)) {
    return res.status(403).json({ error: "Deployment Approver or Admin access required" });
  }
  next();
}
