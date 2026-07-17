// Proxmox tag helpers. Tags identify who a VM belongs to (user + groups) and
// which environment it lives in, and drive visibility in the Resources view.
//
// Proxmox tags are lowercase and limited to [a-z0-9_.-], so every value is
// sanitized the same way on write (tagging a VM) and on read (computing what a
// user may see) — keeping the two sides consistent.

export function sanitizeTag(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 60);
}

export const userTag = (username) => `user-${sanitizeTag(username)}`;
export const groupTag = (group) => `group-${sanitizeTag(group)}`;
export const envTag = (env) => `env-${sanitizeTag(env)}`;

// All the tags that identify a deployment: its owner, the owner's groups, env.
export function ownerTags({ username, groups = [], environment } = {}) {
  const tags = [];
  if (username) tags.push(userTag(username));
  for (const g of groups) tags.push(groupTag(g));
  if (environment) tags.push(envTag(environment));
  return Array.from(new Set(tags));
}

// Parse Proxmox's tag string (";", "," or whitespace separated) into an array.
export function parseTags(tagStr) {
  if (Array.isArray(tagStr)) return tagStr;
  return String(tagStr || "").split(/[;,\s]+/).filter(Boolean);
}
