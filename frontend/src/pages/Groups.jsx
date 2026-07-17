import { useEffect, useMemo, useRef, useState } from "react";
import {
  getUsers,
  getGroups,
  createGroup,
  deleteGroup,
  addGroupMember,
  removeGroupMember,
  setGroupQuotas,
} from "../api/client.js";
import { useDialog } from "../components/DialogProvider.jsx";
import EmptyState from "../components/EmptyState.jsx";
import AdminPageHeader from "../components/AdminPageHeader.jsx";
import { roleLabel } from "../lib/roles.js";

const AVATAR_COLORS = [
  "#7c3aed", "#2563eb", "#059669", "#e67e22", "#dc2626", "#64748b",
  "#0891b2", "#db2777", "#4f46e5", "#ca8a04",
];

const ROLE_BADGE = {
  admin: { label: "Admin", tone: "orange" },
  approver: { label: "Approver", tone: "green" },
  user: { label: "User", tone: "blue" },
};

function hashHue(str) {
  let h = 0;
  for (let i = 0; i < String(str).length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

function initials(name) {
  const parts = String(name || "?").trim().split(/[\s._-]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return String(name || "?").slice(0, 2).toUpperCase();
}

function fmtUpdated(iso) {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    const today = new Date();
    if (d.toDateString() === today.toDateString()) {
      return `Today ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
    }
    return d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  } catch {
    return "—";
  }
}

function groupDescription(name, memberCount) {
  const key = String(name || "").toLowerCase();
  if (/dev|engineer|app/.test(key)) return "Can provision development VMs and applications.";
  if (/infra|ops|platform|sre/.test(key)) return "Infrastructure administrators and platform owners.";
  if (/qa|test|quality/.test(key)) return "QA team — provision and validate workloads.";
  if (/support|help|desk/.test(key)) return "Read-only and support access.";
  if (/finance|cost|finops/.test(key)) return "Cost dashboards and FinOps visibility.";
  if (/audit|compliance|sec/.test(key)) return "Audit reports and compliance review.";
  if (memberCount === 0) return "No members yet — add people to share ownership.";
  return "Team group for shared VM and namespace ownership.";
}

function groupIconTone(name) {
  const key = String(name || "").toLowerCase();
  if (/dev|engineer/.test(key)) return "purple";
  if (/infra|ops|platform/.test(key)) return "blue";
  if (/qa|test/.test(key)) return "green";
  if (/support|help/.test(key)) return "orange";
  if (/finance|cost/.test(key)) return "red";
  if (/audit|sec/.test(key)) return "gray";
  return "orange";
}

function AvatarStack({ members, usersByName, max = 5 }) {
  const shown = members.slice(0, max);
  const extra = members.length - shown.length;
  return (
    <div className="grp-avatars" aria-label={`${members.length} members`}>
      {shown.map((username) => {
        const u = usersByName.get(String(username).toLowerCase());
        const label = u?.displayName || username;
        return (
          <span
            key={username}
            className="grp-avatar"
            style={{ background: hashHue(username) }}
            title={label}
          >
            {initials(label)}
          </span>
        );
      })}
      {extra > 0 && <span className="grp-avatar grp-avatar-more">+{extra}</span>}
      {members.length === 0 && <span className="grp-avatars-empty">No members</span>}
    </div>
  );
}

function ManageDrawer({ group, users, usersByName, onClose, onChanged }) {
  const { alert } = useDialog();
  const [pick, setPick] = useState("");
  const [busy, setBusy] = useState(false);
  const [quotas, setQuotas] = useState({
    maxVms: group.quotas?.maxVms || "",
    maxCpu: group.quotas?.maxCpu || "",
    maxMemoryGB: group.quotas?.maxMemoryGB || "",
  });
  const available = users.filter((u) => !group.members.includes(u.username));

  useEffect(() => {
    setQuotas({
      maxVms: group.quotas?.maxVms || "",
      maxCpu: group.quotas?.maxCpu || "",
      maxMemoryGB: group.quotas?.maxMemoryGB || "",
    });
  }, [group.name, group.quotas?.maxVms, group.quotas?.maxCpu, group.quotas?.maxMemoryGB]);

  const add = async () => {
    if (!pick) return;
    setBusy(true);
    try {
      await addGroupMember(group.name, pick);
      setPick("");
      onChanged();
    } catch (e) {
      alert({ title: "Couldn't add member", message: e.response?.data?.error || e.message, tone: "danger" });
    } finally {
      setBusy(false);
    }
  };

  const remove = async (username) => {
    setBusy(true);
    try {
      await removeGroupMember(group.name, username);
      onChanged();
    } catch (e) {
      alert({ title: "Couldn't remove member", message: e.response?.data?.error || e.message, tone: "danger" });
    } finally {
      setBusy(false);
    }
  };

  const saveQuotas = async () => {
    setBusy(true);
    try {
      await setGroupQuotas(group.name, {
        maxVms: quotas.maxVms === "" ? 0 : Number(quotas.maxVms),
        maxCpu: quotas.maxCpu === "" ? 0 : Number(quotas.maxCpu),
        maxMemoryGB: quotas.maxMemoryGB === "" ? 0 : Number(quotas.maxMemoryGB),
      });
      onChanged();
      alert({ title: "Quotas saved", message: `Team limits updated for ${group.name}.` });
    } catch (e) {
      alert({ title: "Couldn't save quotas", message: e.response?.data?.error || e.message, tone: "danger" });
    } finally {
      setBusy(false);
    }
  };

  const usage = group.usage || { vms: 0, cpu: 0, memoryGB: 0 };

  return (
    <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal-card grp-manage-modal" role="dialog" aria-label={`Manage ${group.name}`}>
        <div className="modal-header">
          <div>
            <h3 style={{ margin: 0 }}>Manage · {group.name}</h3>
            <p className="muted" style={{ margin: "4px 0 0", fontSize: 13 }}>
              Members and team quotas. Empty / 0 = unlimited.
            </p>
          </div>
          <button type="button" className="close-btn" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="modal-body">
          <div className="grp-quota-block">
            <div className="grp-quota-title">Team quotas</div>
            <p className="muted" style={{ fontSize: 12, margin: "0 0 10px" }}>
              In use: {usage.vms} VMs · {usage.cpu} CPU · {usage.memoryGB} GB RAM
            </p>
            <div className="grp-quota-grid">
              <label>
                Max VMs
                <input
                  className="control-input"
                  type="number"
                  min="0"
                  placeholder="∞"
                  value={quotas.maxVms}
                  onChange={(e) => setQuotas((q) => ({ ...q, maxVms: e.target.value }))}
                />
              </label>
              <label>
                Max CPU
                <input
                  className="control-input"
                  type="number"
                  min="0"
                  placeholder="∞"
                  value={quotas.maxCpu}
                  onChange={(e) => setQuotas((q) => ({ ...q, maxCpu: e.target.value }))}
                />
              </label>
              <label>
                Max RAM (GB)
                <input
                  className="control-input"
                  type="number"
                  min="0"
                  placeholder="∞"
                  value={quotas.maxMemoryGB}
                  onChange={(e) => setQuotas((q) => ({ ...q, maxMemoryGB: e.target.value }))}
                />
              </label>
            </div>
            <button type="button" className="btn btn-ghost btn-sm" onClick={saveQuotas} disabled={busy} style={{ marginTop: 8 }}>
              Save quotas
            </button>
          </div>

          <div className="grp-manage-add">
            <select
              className="control-select"
              value={pick}
              onChange={(e) => setPick(e.target.value)}
              disabled={busy || available.length === 0}
            >
              <option value="">{available.length ? "Select user…" : "All users already members"}</option>
              {available.map((u) => (
                <option key={u.id} value={u.username}>{u.displayName || u.username}</option>
              ))}
            </select>
            <button type="button" className="btn btn-primary" onClick={add} disabled={!pick || busy}>
              Add
            </button>
          </div>

          <ul className="grp-manage-list">
            {group.members.length === 0 && (
              <li className="muted" style={{ padding: "12px 0" }}>No members in this group.</li>
            )}
            {group.members.map((username) => {
              const u = usersByName.get(String(username).toLowerCase());
              const label = u?.displayName || username;
              return (
                <li key={username}>
                  <span className="grp-avatar" style={{ background: hashHue(username) }}>{initials(label)}</span>
                  <div className="grp-manage-user">
                    <strong>{label}</strong>
                    <span className="muted mono">{username}</span>
                  </div>
                  {u?.role && (
                    <span className={`grp-perm grp-perm-${ROLE_BADGE[u.role]?.tone || "gray"}`}>
                      {roleLabel(u.role)}
                    </span>
                  )}
                  <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => remove(username)}>
                    Remove
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      </div>
    </div>
  );
}

function OverflowMenu({ open, onClose, onDelete, anchorRef }) {
  const menuRef = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e) => {
      if (menuRef.current?.contains(e.target) || anchorRef.current?.contains(e.target)) return;
      onClose();
    };
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("pointerdown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, onClose, anchorRef]);

  if (!open) return null;
  return (
    <div className="grp-menu" ref={menuRef} role="menu">
      <button type="button" role="menuitem" className="grp-menu-danger" onClick={onDelete}>
        Delete group
      </button>
    </div>
  );
}

export default function Groups() {
  const { confirm, alert } = useDialog();
  const [groups, setGroups] = useState([]);
  const [users, setUsers] = useState([]);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState("");
  const [pending, setPending] = useState(false);
  const [manageTarget, setManageTarget] = useState(null);
  const [menuFor, setMenuFor] = useState(null);
  const menuBtnRefs = useRef({});

  const load = async () => {
    try {
      const [g, u] = await Promise.all([getGroups(), getUsers()]);
      setGroups(Array.isArray(g) ? g : []);
      setUsers(Array.isArray(u) ? u : []);
      setError("");
    } catch (e) {
      setError(e.response?.data?.error || e.message);
    }
  };

  useEffect(() => { load(); }, []);

  const usersByName = useMemo(() => {
    const map = new Map();
    for (const u of users) map.set(String(u.username).toLowerCase(), u);
    return map;
  }, [users]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return groups;
    return groups.filter((g) => {
      if (g.name.toLowerCase().includes(q)) return true;
      return g.members.some((m) => String(m).toLowerCase().includes(q));
    });
  }, [groups, query]);

  const stats = useMemo(() => {
    const totalMembers = groups.reduce((n, g) => n + (g.members?.length || 0), 0);
    const withAccess = groups.filter((g) => (g.members?.length || 0) > 0).length;
    const latest = groups.reduce((best, g) => {
      if (!g.createdAt) return best;
      if (!best || g.createdAt > best) return g.createdAt;
      return best;
    }, null);
    return {
      total: groups.length,
      members: totalMembers,
      withAccess,
      updated: latest,
    };
  }, [groups]);

  const create = async (e) => {
    e.preventDefault();
    if (!newName.trim()) return;
    setPending(true);
    setError("");
    try {
      await createGroup(newName.trim());
      setNewName("");
      setShowCreate(false);
      await load();
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setPending(false);
    }
  };

  const remove = async (name) => {
    setMenuFor(null);
    if (!(await confirm({
      title: "Delete group",
      message: `Delete group "${name}"? Members will lose shared group ownership tags.`,
      confirmLabel: "Delete",
      tone: "danger",
    }))) return;
    try {
      await deleteGroup(name);
      if (manageTarget?.name === name) setManageTarget(null);
      await load();
    } catch (e) {
      alert({ title: "Couldn't delete group", message: e.response?.data?.error || e.message, tone: "danger" });
    }
  };

  const permissionBadges = (group) => {
    const roles = new Set();
    for (const m of group.members || []) {
      const u = usersByName.get(String(m).toLowerCase());
      if (u?.role) roles.add(u.role);
    }
    if (roles.size === 0) return [{ label: "No access yet", tone: "gray" }];
    return [...roles].map((r) => ROLE_BADGE[r] || { label: roleLabel(r), tone: "gray" });
  };

  const manageGroup = manageTarget
    ? groups.find((g) => g.name === manageTarget.name) || manageTarget
    : null;

  return (
    <div className="grp-page">
      <AdminPageHeader
        title="Groups"
        description="Organize users into groups to simplify permissions and resource ownership."
        actions={(
          <button type="button" className="btn btn-primary" onClick={() => setShowCreate((s) => !s)}>
            {showCreate ? "Cancel" : "+ New Group"}
          </button>
        )}
      >
        <div className="adm-toolbar">
          <input
            className="control-input grp-search"
            placeholder="Search groups…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search groups"
          />
        </div>
      </AdminPageHeader>

      {error && <div className="login-error" style={{ marginBottom: 14 }}>{error}</div>}

      {showCreate && (
        <form className="grp-create card card-pad" onSubmit={create}>
          <div className="field" style={{ marginBottom: 0, flex: 1 }}>
            <label htmlFor="grp-new-name">Group name</label>
            <input
              id="grp-new-name"
              className="control-input"
              required
              autoFocus
              placeholder="e.g. Developers"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
            />
          </div>
          <button className="btn btn-primary" disabled={pending || !newName.trim()} style={{ alignSelf: "flex-end" }}>
            {pending ? "Creating…" : "Create group"}
          </button>
        </form>
      )}

      <div className="grp-kpis">
        <div className="grp-kpi">
          <span className="grp-kpi-icon tone-purple" aria-hidden="true">⧉</span>
          <div>
            <div className="grp-kpi-label">Total Groups</div>
            <div className="grp-kpi-value">{stats.total}</div>
            <div className="grp-kpi-meta">Active teams</div>
          </div>
        </div>
        <div className="grp-kpi">
          <span className="grp-kpi-icon tone-green" aria-hidden="true">◉</span>
          <div>
            <div className="grp-kpi-label">Total Members</div>
            <div className="grp-kpi-value">{stats.members}</div>
            <div className="grp-kpi-meta">Across all groups</div>
          </div>
        </div>
        <div className="grp-kpi">
          <span className="grp-kpi-icon tone-blue" aria-hidden="true">◎</span>
          <div>
            <div className="grp-kpi-label">Groups with Access</div>
            <div className="grp-kpi-value">{stats.withAccess}</div>
            <div className="grp-kpi-meta">Have platform access</div>
          </div>
        </div>
        <div className="grp-kpi">
          <span className="grp-kpi-icon tone-orange" aria-hidden="true">◷</span>
          <div>
            <div className="grp-kpi-label">Last Updated</div>
            <div className="grp-kpi-value grp-kpi-value-sm">{fmtUpdated(stats.updated)}</div>
            <div className="grp-kpi-meta">Groups synced</div>
          </div>
        </div>
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          icon="👥"
          title={query ? "No matching groups" : "No groups yet"}
          description={query
            ? "Try a different search."
            : "Create a group, then add members. Provisioned VMs can be owned by a group."}
          actionLabel={query ? undefined : "+ New Group"}
          onAction={query ? undefined : () => setShowCreate(true)}
        />
      ) : (
        <div className="grp-list">
          {filtered.map((g) => {
            const badges = permissionBadges(g);
            const tone = groupIconTone(g.name);
            return (
              <article key={g.name} className="grp-card">
                <div className={`grp-card-icon tone-${tone}`} aria-hidden="true">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                    <circle cx="9" cy="7" r="4" />
                    <path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
                  </svg>
                </div>

                <div className="grp-card-main">
                  <h2>{g.name}</h2>
                  <p>{groupDescription(g.name, g.members.length)}</p>
                  {(g.quotas?.maxVms || g.quotas?.maxCpu || g.quotas?.maxMemoryGB) ? (
                    <p className="grp-quota-summary muted">
                      Quota · VMs {g.usage?.vms ?? 0}/{g.quotas.maxVms || "∞"}
                      {" · "}CPU {g.usage?.cpu ?? 0}/{g.quotas.maxCpu || "∞"}
                      {" · "}RAM {g.usage?.memoryGB ?? 0}/{g.quotas.maxMemoryGB || "∞"} GB
                    </p>
                  ) : null}
                </div>

                <div className="grp-card-members">
                  <div className="grp-card-label">{g.members.length} {g.members.length === 1 ? "Member" : "Members"}</div>
                  <AvatarStack members={g.members} usersByName={usersByName} />
                </div>

                <div className="grp-card-perms">
                  <div className="grp-card-label">Permissions</div>
                  <div className="grp-perms">
                    {badges.map((b) => (
                      <span key={b.label} className={`grp-perm grp-perm-${b.tone}`}>{b.label}</span>
                    ))}
                  </div>
                </div>

                <div className="grp-card-actions">
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => setManageTarget(g)}>
                    Manage
                  </button>
                  <div className="grp-overflow">
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm grp-more"
                      ref={(el) => { menuBtnRefs.current[g.name] = el; }}
                      aria-label={`More actions for ${g.name}`}
                      aria-expanded={menuFor === g.name}
                      onClick={() => setMenuFor((cur) => (cur === g.name ? null : g.name))}
                    >
                      ⋯
                    </button>
                    <OverflowMenu
                      open={menuFor === g.name}
                      anchorRef={{ current: menuBtnRefs.current[g.name] }}
                      onClose={() => setMenuFor(null)}
                      onDelete={() => remove(g.name)}
                    />
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}

      {manageGroup && (
        <ManageDrawer
          group={manageGroup}
          users={users}
          usersByName={usersByName}
          onClose={() => setManageTarget(null)}
          onChanged={load}
        />
      )}
    </div>
  );
}
