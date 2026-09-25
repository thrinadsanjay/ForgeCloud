export const ROLES = {
  ADMIN: "admin",
  APPROVER: "approver",
  USER: "user",
};

export const ROLE_LABELS = {
  admin: "Admin",
  approver: "Deployment Approver",
  user: "User",
};

export const ALL_ROLES = [ROLES.ADMIN, ROLES.APPROVER, ROLES.USER];

export function isAdminRole(role) {
  return role === ROLES.ADMIN;
}

export function canReviewDeployments(role) {
  return role === ROLES.ADMIN || role === ROLES.APPROVER;
}

export function canSeeAllDeployments(role) {
  return role === ROLES.ADMIN || role === ROLES.APPROVER;
}

export function roleLabel(role) {
  return ROLE_LABELS[role] || role || "User";
}
