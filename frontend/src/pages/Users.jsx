import { useEffect, useRef, useState } from "react";
import {
  getUsers, createUser, updateUserRole, deleteUser,
} from "../api/client.js";
import { useDialog } from "../components/DialogProvider.jsx";
import EmptyState from "../components/EmptyState.jsx";
import AdminPageHeader from "../components/AdminPageHeader.jsx";
import { ALL_ROLES, ROLE_LABELS, roleLabel } from "../lib/roles.js";

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
        Delete user
      </button>
    </div>
  );
}

export default function Users({ embedded = false }) {
  const { confirm, alert } = useDialog();
  const [users, setUsers] = useState([]);
  const [error, setError] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [query, setQuery] = useState("");
  const [form, setForm] = useState({ username: "", password: "", displayName: "", email: "", role: "user" });
  const [busy, setBusy] = useState(false);
  const [menuFor, setMenuFor] = useState(null);
  const menuBtnRefs = useRef({});

  const load = () => getUsers().then(setUsers).catch((e) => setError(e.response?.data?.error || e.message));
  useEffect(() => { load(); }, []);

  const upd = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await createUser(form);
      setForm({ username: "", password: "", displayName: "", email: "", role: "user" });
      setShowForm(false);
      load();
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setBusy(false);
    }
  };

  const changeRole = async (u, nextRole) => {
    if (!nextRole || nextRole === u.role) return;
    try { await updateUserRole(u.id, nextRole); load(); }
    catch (e) { alert({ title: "Couldn't change role", message: e.response?.data?.error || e.message, tone: "danger" }); }
  };

  const remove = async (u) => {
    setMenuFor(null);
    if (!(await confirm({ title: "Delete user", message: `Delete user "${u.username}"?`, confirmLabel: "Delete", tone: "danger" }))) return;
    try { await deleteUser(u.id); load(); }
    catch (e) { alert({ title: "Couldn't delete user", message: e.response?.data?.error || e.message, tone: "danger" }); }
  };

  const filtered = users.filter((u) => {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return [u.username, u.displayName, u.email, u.role].some((v) => String(v || "").toLowerCase().includes(q));
  });

  const admins = users.filter((u) => u.role === "admin").length;
  const approvers = users.filter((u) => u.role === "approver").length;

  return (
    <div className={embedded ? "" : "page"}>
      <AdminPageHeader
        title="Users"
        description="Local accounts and roles. OIDC users appear after first sign-in."
        actions={(
          <button className="btn btn-primary" onClick={() => setShowForm((s) => !s)}>
            {showForm ? "Cancel" : "Add user"}
          </button>
        )}
      >
        <div className="adm-toolbar">
          <input
            className="control-input"
            placeholder="Search users…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      </AdminPageHeader>

      {error && <div className="login-error" style={{ marginBottom: 14 }}>{error}</div>}

      <div className="adm-kpi-row">
        <div className="adm-kpi"><span className="adm-kpi-label">Total Users</span><strong>{users.length}</strong></div>
        <div className="adm-kpi"><span className="adm-kpi-label">Admins</span><strong>{admins}</strong></div>
        <div className="adm-kpi"><span className="adm-kpi-label">Approvers</span><strong>{approvers}</strong></div>
        <div className="adm-kpi"><span className="adm-kpi-label">Showing</span><strong>{filtered.length}</strong></div>
      </div>

      {showForm && (
        <div className="adm-card" style={{ marginBottom: 16, maxWidth: 520 }}>
          <form onSubmit={submit}>
            <div className="field"><label>Username</label><input required value={form.username} onChange={upd("username")} /></div>
            <div className="field"><label>Password</label><input type="password" required value={form.password} onChange={upd("password")} /></div>
            <div className="field"><label>Display name</label><input value={form.displayName} onChange={upd("displayName")} /></div>
            <div className="field"><label>Email</label><input type="email" value={form.email} onChange={upd("email")} /></div>
            <div className="field">
              <label>Role</label>
              <select value={form.role} onChange={upd("role")}>
                <option value="user">{ROLE_LABELS.user}</option>
                <option value="approver">{ROLE_LABELS.approver}</option>
                <option value="admin">{ROLE_LABELS.admin}</option>
              </select>
            </div>
            <button className="btn btn-primary" disabled={busy}>{busy ? "Creating…" : "Create user"}</button>
          </form>
        </div>
      )}

      {filtered.length === 0 ? (
        <EmptyState
          icon="👤"
          title="No users yet"
          description="Create a local account or wait for the first OIDC sign-in."
          actionLabel="Add user"
          onAction={() => setShowForm(true)}
        />
      ) : (
        <div className="adm-card" style={{ padding: 0, overflow: "hidden" }}>
          <table className="table">
            <thead>
              <tr><th>User</th><th>Email</th><th>Source</th><th>Role</th><th>Actions</th></tr>
            </thead>
            <tbody>
              {filtered.map((u) => (
                <tr key={u.id}>
                  <td>
                    <div style={{ fontWeight: 600 }}>{u.displayName || u.username}</div>
                    <div className="muted mono" style={{ fontSize: 12 }}>{u.username}</div>
                  </td>
                  <td>{u.email || "—"}</td>
                  <td><span className="badge badge-user">{u.source}</span></td>
                  <td>
                    <span className={`badge ${u.role === "admin" ? "badge-admin" : u.role === "approver" ? "badge-approver" : "badge-user"}`}>
                      {roleLabel(u.role)}
                    </span>
                  </td>
                  <td>
                    <div className="actions-cell">
                      <select
                        className="control-select"
                        style={{ maxWidth: 160 }}
                        value={u.role || "user"}
                        onChange={(e) => changeRole(u, e.target.value)}
                        aria-label={`Role for ${u.username}`}
                      >
                        {ALL_ROLES.map((r) => (
                          <option key={r} value={r}>{ROLE_LABELS[r]}</option>
                        ))}
                      </select>
                      <div className="grp-overflow">
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm grp-more"
                          ref={(el) => { menuBtnRefs.current[u.id] = el; }}
                          aria-label={`More actions for ${u.username}`}
                          aria-expanded={menuFor === u.id}
                          onClick={() => setMenuFor((cur) => (cur === u.id ? null : u.id))}
                        >
                          ⋯
                        </button>
                        <OverflowMenu
                          open={menuFor === u.id}
                          anchorRef={{ current: menuBtnRefs.current[u.id] }}
                          onClose={() => setMenuFor(null)}
                          onDelete={() => remove(u)}
                        />
                      </div>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
