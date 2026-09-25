/** Portal roles — keep ids stable; UI labels may be friendlier. */
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

export function isValidRole(role) {
  return ALL_ROLES.includes(role);
}

export function isAdminRole(role) {
  return role === ROLES.ADMIN;
}

/** Can approve/reject size-policy holds and see the approval queue. */
export function canReviewDeployments(role) {
  return role === ROLES.ADMIN || role === ROLES.APPROVER;
}

/** See all users' jobs/requests (not only own). */
export function canSeeAllDeployments(role) {
  return role === ROLES.ADMIN || role === ROLES.APPROVER;
}
