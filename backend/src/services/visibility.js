import { groupsForUser } from "./groupStore.js";
import { userTag, groupTag, parseTags } from "./tags.js";

// The set of tags that make a resource "belong" to this user: their own
// user tag plus a group tag for every group they're a member of.
export function identityTagSet(user) {
  if (!user) return new Set();
  const groups = groupsForUser(user.username);
  return new Set([userTag(user.username), ...groups.map(groupTag)]);
}

// Whether a user may see/manage a resource given its Proxmox tags. Admins see
// everything; everyone else sees a resource only if its tags include their
// user tag or one of their group tags.
export function canSeeTags(tags, user) {
  if (user?.role === "admin") return true;
  const set = identityTagSet(user);
  return parseTags(tags).some((t) => set.has(String(t).toLowerCase()));
}
