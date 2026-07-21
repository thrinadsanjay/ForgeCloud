import { useEffect, useMemo, useRef, useState } from "react";
import {
  adminListPackages,
  adminUpsertPackage,
  adminDeletePackage,
  adminListApplicationRoles,
  adminUpsertApplicationRole,
  adminDeleteApplicationRole,
  adminListWorkflows,
  adminListInstanceSizes,
  adminUpsertInstanceSize,
  adminDeleteInstanceSize,
  adminGetHostnameFormat,
  adminSetHostnameFormat,
  adminPreviewHostnameFormat,
} from "../api/client.js";
import { useDialog } from "../components/DialogProvider.jsx";
import AdminPageHeader from "../components/AdminPageHeader.jsx";

const PACKAGE_CATEGORY_OPTIONS = [
  "Languages & runtimes",
  "Build tools",
  "Containers & orchestration",
  "Databases & cache",
  "Messaging",
  "Web & proxy",
  "DevOps & IaC",
  "Monitoring",
  "Utilities",
  "Uncategorized",
];

/** Colored monogram for package cards (no external logo assets). */
const PACKAGE_ICON_STYLES = {
  "dotnet-sdk": { label: ".N", bg: "#512bd4" },
  go: { label: "Go", bg: "#00add8" },
  java: { label: "Ja", bg: "#ea2d2e" },
  nodejs: { label: "No", bg: "#339933" },
  openjdk: { label: "OJ", bg: "#b07219" },
  php: { label: "PHP", bg: "#777bb4" },
  python: { label: "Py", bg: "#3776ab" },
  postgres: { label: "PG", bg: "#336791" },
  mysql: { label: "My", bg: "#4479a1" },
  mongodb: { label: "Mg", bg: "#00684a" },
  redis: { label: "Re", bg: "#dc382d" },
  rabbitmq: { label: "RQ", bg: "#f60" },
  nginx: { label: "Nx", bg: "#009639" },
  docker: { label: "Dk", bg: "#2496ed" },
  "docker-compose": { label: "DC", bg: "#1d63ed" },
  kubectl: { label: "K8", bg: "#326ce5" },
  helm: { label: "Hm", bg: "#0f1689" },
  terraform: { label: "Tf", bg: "#7b42bc" },
  ansible: { label: "An", bg: "#ee0000" },
  awscli: { label: "AWS", bg: "#ff9900" },
  grafana: { label: "Gr", bg: "#f46800" },
  prometheus: { label: "Pr", bg: "#e6522c" },
  git: { label: "Git", bg: "#f05032" },
  maven: { label: "Mv", bg: "#c71a36" },
  yarn: { label: "Yn", bg: "#2c8ebb" },
  curl: { label: "Cu", bg: "#073551" },
  vim: { label: "Vi", bg: "#019733" },
  jq: { label: "jq", bg: "#c7254e" },
  htop: { label: "ht", bg: "#4a5568" },
  tmux: { label: "tm", bg: "#1bb91f" },
  postman: { label: "Pm", bg: "#ff6c37" },
  aqt: { label: "Qt", bg: "#41cd52" },
};

function packageIcon(id) {
  const known = PACKAGE_ICON_STYLES[id];
  if (known) return known;
  const clean = String(id || "?").replace(/[^a-z0-9]/gi, "");
  const label = (clean.slice(0, 2) || "?").toUpperCase();
  let hash = 0;
  for (let i = 0; i < String(id).length; i++) hash = (hash * 31 + String(id).charCodeAt(i)) >>> 0;
  const hues = [210, 24, 152, 280, 34, 178, 8, 256];
  return { label, bg: `hsl(${hues[hash % hues.length]} 48% 42%)` };
}

const SECTIONS = [
  {
    id: "packages",
    label: "Packages",
    icon: "📦",
    title: "Software packages",
    summary: "What users can pick at provision time. Mark org-standard items as Default — they stay checked and cannot be removed.",
  },
  {
    id: "app-roles",
    label: "App roles",
    icon: "🧩",
    title: "Application roles",
    summary: "Provision Application dropdown: single / multi / bundle / suggest package picking per role.",
  },
  {
    id: "sizes",
    label: "Sizes",
    icon: "📐",
    title: "Instance sizes",
    summary: "T-shirt sizes (micro, small, large…) that map to CPU and RAM. Users pick a size instead of raw numbers.",
  },
  {
    id: "hostname",
    label: "Hostname",
    icon: "🏷️",
    title: "Default hostname format",
    summary: "Pattern used when Forge Assist or Provision invents a hostname. Include {app} for web/db/docker roles.",
  },
  {
    id: "workflows",
    label: "Workflows",
    icon: "🔗",
    title: "Internal workflows",
    summary: "Multi-step builds via external APIs (not Proxmox VM clones).",
  },
];

function PackagesPanel({ section }) {
  const { confirm } = useDialog();
  const [rows, setRows] = useState([]);
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [installPkg, setInstallPkg] = useState("");
  const [category, setCategory] = useState("Uncategorized");
  const [hostnameCode, setHostnameCode] = useState("");
  const [isDefault, setIsDefault] = useState(false);
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [collapsed, setCollapsed] = useState({});
  const [menuId, setMenuId] = useState(null);
  const committedRef = useRef({});

  const load = () => adminListPackages().then((data) => {
    setRows(data);
    committedRef.current = Object.fromEntries(
      data.map((r) => [r.id, {
        hostnameCode: r.hostnameCode || null,
        installPkg: r.installPkg || null,
      }]),
    );
  }).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);
  useEffect(() => {
    if (!menuId) return undefined;
    const close = () => setMenuId(null);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [menuId]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) =>
      r.id.toLowerCase().includes(q)
      || (r.name || "").toLowerCase().includes(q)
      || (r.installPkg || "").toLowerCase().includes(q)
      || (r.category || "").toLowerCase().includes(q)
      || (r.hostnameCode || "").toLowerCase().includes(q),
    );
  }, [rows, query]);

  const grouped = useMemo(() => {
    const map = new Map();
    for (const r of filtered) {
      const cat = (r.category || "Uncategorized").trim() || "Uncategorized";
      if (!map.has(cat)) map.set(cat, []);
      map.get(cat).push(r);
    }
    const order = [...PACKAGE_CATEGORY_OPTIONS];
    const keys = [...map.keys()].sort((a, b) => {
      const ia = order.indexOf(a);
      const ib = order.indexOf(b);
      if (ia < 0 && ib < 0) return a.localeCompare(b);
      if (ia < 0) return 1;
      if (ib < 0) return -1;
      return ia - ib;
    });
    return keys.map((k) => ({ name: k, items: map.get(k) }));
  }, [filtered]);

  // Auto-expand categories that match search; keep user collapses otherwise.
  useEffect(() => {
    if (!query.trim()) return;
    setCollapsed((prev) => {
      const next = { ...prev };
      for (const g of grouped) next[g.name] = false;
      return next;
    });
  }, [query, grouped]);

  const defaultCount = rows.filter((r) => r.isDefault && r.enabled).length;
  const enabledCount = rows.filter((r) => r.enabled).length;

  const toggleCollapse = (cat) => {
    setCollapsed((prev) => ({ ...prev, [cat]: !prev[cat] }));
  };

  const expandAll = () => {
    setCollapsed({});
  };

  const collapseAll = () => {
    const next = {};
    for (const g of grouped) next[g.name] = true;
    setCollapsed(next);
  };

  const add = async (e) => {
    e?.preventDefault();
    setError("");
    setBusy(true);
    try {
      await adminUpsertPackage({
        id: id.trim(),
        name: name.trim() || id.trim(),
        installPkg: installPkg.trim() || null,
        category: category || "Uncategorized",
        hostnameCode: hostnameCode.trim() || null,
        isDefault,
        enabled: true,
        sortOrder: rows.length,
      });
      setId("");
      setName("");
      setInstallPkg("");
      setCategory("Uncategorized");
      setHostnameCode("");
      setIsDefault(false);
      setShowAdd(false);
      await load();
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setBusy(false);
    }
  };

  const toggleEnabled = async (row) => {
    await adminUpsertPackage({ ...row, enabled: !row.enabled });
    await load();
  };

  const toggleDefault = async (row) => {
    await adminUpsertPackage({ ...row, isDefault: !row.isDefault });
    await load();
  };

  const saveMeta = async (row, patch) => {
    await adminUpsertPackage({ ...row, ...patch });
    await load();
  };

  const commitMetaField = async (row, field, raw, normalize) => {
    const next = normalize(raw);
    const prev = committedRef.current[row.id]?.[field] ?? null;
    if (next === prev) return;
    await saveMeta(row, { [field]: next });
  };

  const remove = async (pkgId) => {
    const ok = await confirm({
      title: "Remove package?",
      message: `“${pkgId}” will disappear from provisioning pickers.`,
      confirmLabel: "Remove",
      tone: "danger",
    });
    if (!ok) return;
    await adminDeletePackage(pkgId);
    await load();
  };

  return (
    <div className="pkg-board">
      <div className="pkg-board-toolbar">
        <div className="pkg-board-metrics" aria-label="Package counts">
          <span><strong>{rows.length}</strong> total</span>
          <span className="pkg-board-dot" aria-hidden="true">·</span>
          <span><strong>{defaultCount}</strong> default</span>
          <span className="pkg-board-dot" aria-hidden="true">·</span>
          <span><strong>{enabledCount}</strong> enabled</span>
        </div>
        <div className="pkg-board-actions">
          <input
            className="control-input pkg-board-search"
            placeholder="Search packages…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search packages"
          />
          <button type="button" className="btn btn-ghost btn-sm" onClick={expandAll}>Expand</button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={collapseAll}>Collapse</button>
          <button
            type="button"
            className={`btn btn-sm ${showAdd ? "btn-ghost" : "btn-primary"}`}
            onClick={() => setShowAdd((v) => !v)}
          >
            {showAdd ? "Cancel" : "+ Add package"}
          </button>
        </div>
      </div>

      {showAdd && (
        <form className="pkg-board-add" onSubmit={add}>
          {error && <div className="login-error pkg-board-add-error">{error}</div>}
          <label className="pkg-board-add-field">
            <span>ID</span>
            <input className="control-input" placeholder="e.g. docker" value={id} onChange={(e) => setId(e.target.value)} required />
          </label>
          <label className="pkg-board-add-field">
            <span>Display name</span>
            <input className="control-input" placeholder="Shown in pickers" value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label
            className="pkg-board-add-field"
            title="OS package name passed to apt/yum when it differs from the catalog ID. Leave blank to install using the ID."
          >
            <span>OS package</span>
            <input
              className="control-input"
              placeholder="apt/yum name if ≠ ID"
              value={installPkg}
              onChange={(e) => setInstallPkg(e.target.value)}
            />
          </label>
          <label className="pkg-board-add-field">
            <span>Category</span>
            <select className="control-input" value={category} onChange={(e) => setCategory(e.target.value)}>
              {PACKAGE_CATEGORY_OPTIONS.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </label>
          <label className="pkg-board-add-field" title="Short {app} token when this is the sole role pick (e.g. psql)">
            <span>Hostname code</span>
            <input className="control-input" placeholder="e.g. psql" value={hostnameCode} onChange={(e) => setHostnameCode(e.target.value)} />
          </label>
          <button
            type="button"
            className={`pkg-chip pkg-board-add-default ${isDefault ? "is-default" : "is-optional"}`}
            onClick={() => setIsDefault((v) => !v)}
            title={isDefault ? "Org default — always installed at provision" : "Optional — users can opt in"}
            aria-pressed={isDefault}
          >
            {isDefault ? "Default" : "Optional"}
          </button>
          <button className="btn btn-primary btn-sm" type="submit" disabled={busy || !id.trim()}>
            {busy ? "…" : "Add"}
          </button>
        </form>
      )}

      {grouped.length === 0 ? (
        <div className="catalog-empty muted">{rows.length ? "No matches." : "No packages yet."}</div>
      ) : (
        <div className="pkg-board-groups">
          {grouped.map((group) => {
            const isClosed = !!collapsed[group.name];
            return (
              <section key={group.name} className={`pkg-cat-box ${isClosed ? "is-collapsed" : ""}`}>
                <button
                  type="button"
                  className="pkg-cat-box-head"
                  onClick={() => toggleCollapse(group.name)}
                  aria-expanded={!isClosed}
                >
                  <span className="pkg-cat-box-chevron" aria-hidden="true">{isClosed ? "▸" : "▾"}</span>
                  <span className="pkg-cat-box-title">{group.name}</span>
                  <span className="pkg-cat-box-count">{group.items.length} package{group.items.length === 1 ? "" : "s"}</span>
                </button>
                {!isClosed && (
                  <div className="pkg-card-grid">
                    {group.items.map((r) => {
                      const title = r.name && r.name !== r.id ? r.name : r.id;
                      const icon = packageIcon(r.id);
                      const osPkg = r.installPkg && r.installPkg !== r.id ? r.installPkg : null;
                      const metaBits = [
                        osPkg ? `OS: ${osPkg}` : null,
                        r.hostnameCode ? `{app}=${r.hostnameCode}` : null,
                      ].filter(Boolean);
                      return (
                        <article key={r.id} className={`pkg-card ${r.enabled ? "" : "is-off"}`}>
                          <div className="pkg-card-head">
                            <span className="pkg-card-icon" style={{ background: icon.bg }} aria-hidden="true">
                              {icon.label}
                            </span>
                            <div className="pkg-card-title-block">
                              <div className="pkg-card-title">{title}</div>
                              <code className="pkg-card-id">{r.id}</code>
                            </div>
                            <div className="pkg-card-menu" onClick={(e) => e.stopPropagation()}>
                              <button
                                type="button"
                                className="pkg-card-menu-btn"
                                aria-label={`Actions for ${title}`}
                                aria-expanded={menuId === r.id}
                                onClick={() => setMenuId((cur) => (cur === r.id ? null : r.id))}
                              >
                                ⋮
                              </button>
                              {menuId === r.id && (
                                <div className="pkg-card-menu-pop" role="menu">
                                  <label className="pkg-card-menu-field">
                                    <span>Hostname code</span>
                                    <input
                                      className="control-input pkg-card-code"
                                      value={r.hostnameCode || ""}
                                      placeholder="—"
                                      onBlur={(e) => commitMetaField(r, "hostnameCode", e.target.value, (raw) => {
                                        const v = String(raw || "").trim().toLowerCase();
                                        return v || null;
                                      })}
                                      onChange={(e) => {
                                        setRows((prev) => prev.map((x) => (x.id === r.id ? { ...x, hostnameCode: e.target.value } : x)));
                                      }}
                                    />
                                  </label>
                                  <label className="pkg-card-menu-field" title="apt/yum name when different from ID">
                                    <span>OS package</span>
                                    <input
                                      className="control-input pkg-card-code"
                                      value={r.installPkg || ""}
                                      placeholder={r.id}
                                      onBlur={(e) => commitMetaField(r, "installPkg", e.target.value, (raw) => {
                                        const v = String(raw || "").trim();
                                        return (!v || v === r.id) ? null : v;
                                      })}
                                      onChange={(e) => {
                                        setRows((prev) => prev.map((x) => (x.id === r.id ? { ...x, installPkg: e.target.value } : x)));
                                      }}
                                    />
                                  </label>
                                  <button type="button" className="pkg-card-menu-danger" onClick={() => { setMenuId(null); remove(r.id); }}>
                                    Remove package
                                  </button>
                                </div>
                              )}
                            </div>
                          </div>
                          <p className="pkg-card-desc">
                            {metaBits.length
                              ? metaBits.join(" · ")
                              : "Uses catalog ID for apt/yum install."}
                          </p>
                          <div className="pkg-card-chips">
                            <button
                              type="button"
                              className={`pkg-chip ${r.isDefault ? "is-default" : "is-optional"}`}
                              onClick={() => toggleDefault(r)}
                              title={r.isDefault ? "Locked default — always installed" : "Mark as org default"}
                            >
                              {r.isDefault ? "Default" : "Optional"}
                            </button>
                            <button
                              type="button"
                              className={`pkg-chip ${r.enabled ? "is-on" : "is-off"}`}
                              onClick={() => toggleEnabled(r)}
                            >
                              {r.enabled ? "On" : "Off"}
                            </button>
                          </div>
                        </article>
                      );
                    })}
                  </div>
                )}
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}

function AppRolesPanel() {
  const { confirm } = useDialog();
  const [rows, setRows] = useState([]);
  const [packages, setPackages] = useState([]);
  const [id, setId] = useState("");
  const [label, setLabel] = useState("");
  const [selection, setSelection] = useState("multi");
  const [optionsText, setOptionsText] = useState("");
  const [defaultOptionId, setDefaultOptionId] = useState("");
  const [allowMulti, setAllowMulti] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [query, setQuery] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [menuId, setMenuId] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const load = async () => {
    const [roles, pkgs] = await Promise.all([adminListApplicationRoles(), adminListPackages()]);
    setRows(roles);
    setPackages(pkgs);
  };
  useEffect(() => { load().catch((e) => setError(e.message)); }, []);
  useEffect(() => {
    if (!menuId) return undefined;
    const close = () => setMenuId(null);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [menuId]);

  const enabledPkgs = useMemo(
    () => packages.filter((p) => p.enabled).map((p) => p.id).sort(),
    [packages],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) =>
      r.id.toLowerCase().includes(q)
      || (r.label || "").toLowerCase().includes(q)
      || (r.selection || "").toLowerCase().includes(q)
      || (r.options || []).some((o) => String(o).toLowerCase().includes(q)),
    );
  }, [rows, query]);

  const stats = useMemo(() => {
    const multi = rows.filter((r) => r.selection === "multi" || r.selection === "suggest").length;
    const single = rows.filter((r) => r.selection === "single").length;
    const bundle = rows.filter((r) => r.selection === "bundle").length;
    const active = rows.filter((r) => r.enabled !== false).length;
    return { multi, single, bundle, active };
  }, [rows]);

  const clearForm = () => {
    setId("");
    setLabel("");
    setOptionsText("");
    setDefaultOptionId("");
    setAllowMulti(false);
    setSelection("multi");
    setEditingId(null);
    setError("");
  };

  const beginEdit = (row) => {
    setEditingId(row.id);
    setId(row.id);
    setLabel(row.label || "");
    setSelection(row.selection || "multi");
    setOptionsText((row.options || []).join(", "));
    setDefaultOptionId(row.defaultOptionId || "");
    setAllowMulti(!!row.allowMultiOverride);
    setShowForm(true);
    setMenuId(null);
    setError("");
  };

  const optionList = () => optionsText.split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean);

  const addOptionChip = (pkgId) => {
    const cur = new Set(optionList());
    if (cur.has(pkgId)) return;
    cur.add(pkgId);
    setOptionsText([...cur].join(", "));
  };

  const save = async (e) => {
    e?.preventDefault();
    setBusy(true);
    setError("");
    try {
      const options = optionList();
      await adminUpsertApplicationRole({
        id: id.trim(),
        label: label.trim() || id.trim(),
        selection,
        options,
        defaultOptionId: defaultOptionId.trim() || null,
        allowMultiOverride: allowMulti,
        enabled: editingId
          ? (rows.find((r) => r.id === editingId)?.enabled !== false)
          : true,
        sortOrder: editingId ? (rows.find((r) => r.id === editingId)?.sortOrder ?? rows.length) : rows.length,
      });
      clearForm();
      setShowForm(false);
      await load();
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setBusy(false);
    }
  };

  const updateRole = async (row, patch) => {
    await adminUpsertApplicationRole({ ...row, ...patch });
    await load();
  };

  const remove = async (roleId) => {
    const ok = await confirm({
      title: "Remove application role?",
      message: `“${roleId}” will disappear from the Provision Application dropdown.`,
      confirmLabel: "Remove",
      tone: "danger",
    });
    if (!ok) return;
    await adminDeleteApplicationRole(roleId);
    if (editingId === roleId) clearForm();
    await load();
  };

  return (
    <div className="role-board">
      <div className="role-stat-grid" aria-label="Role summary">
        <div className="role-stat-card">
          <span className="role-stat-icon is-total" aria-hidden="true">▦</span>
          <div>
            <div className="role-stat-label">Total roles</div>
            <div className="role-stat-value">{rows.length}</div>
            <div className="role-stat-hint">Configured</div>
          </div>
        </div>
        <div className="role-stat-card">
          <span className="role-stat-icon is-multi" aria-hidden="true">☰</span>
          <div>
            <div className="role-stat-label">Multi / suggest</div>
            <div className="role-stat-value">{stats.multi}</div>
            <div className="role-stat-hint">Allow multiple packages</div>
          </div>
        </div>
        <div className="role-stat-card">
          <span className="role-stat-icon is-single" aria-hidden="true">◉</span>
          <div>
            <div className="role-stat-label">Single select</div>
            <div className="role-stat-value">{stats.single}</div>
            <div className="role-stat-hint">One package only</div>
          </div>
        </div>
        <div className="role-stat-card">
          <span className="role-stat-icon is-bundle" aria-hidden="true">▣</span>
          <div>
            <div className="role-stat-label">Bundle</div>
            <div className="role-stat-value">{stats.bundle}</div>
            <div className="role-stat-hint">{stats.active} active</div>
          </div>
        </div>
      </div>

      <div className="role-board-toolbar">
        <input
          className="control-input role-board-search"
          placeholder="Search roles…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search roles"
        />
        <button
          type="button"
          className={`btn btn-sm ${showForm ? "btn-ghost" : "btn-primary"}`}
          onClick={() => {
            if (showForm) {
              clearForm();
              setShowForm(false);
            } else {
              clearForm();
              setShowForm(true);
            }
          }}
        >
          {showForm ? "Cancel" : "+ Add / update role"}
        </button>
      </div>

      {showForm && (
        <form className="role-form" onSubmit={save}>
          <div className="role-form-head">
            <h3 className="role-form-title">{editingId ? `Update “${editingId}”` : "Add / update role"}</h3>
            <p className="role-form-hint muted">
              single = one pick · multi/suggest = checkboxes · bundle = auto-select all options
            </p>
          </div>
          {error && <div className="login-error">{error}</div>}
          <div className="role-form-grid">
            <label className="role-form-field">
              <span>ID</span>
              <input
                className="control-input"
                placeholder="e.g. db"
                value={id}
                onChange={(e) => setId(e.target.value)}
                required
                disabled={!!editingId}
              />
            </label>
            <label className="role-form-field">
              <span>Label</span>
              <input className="control-input" placeholder="Shown in Provision" value={label} onChange={(e) => setLabel(e.target.value)} />
            </label>
            <label className="role-form-field">
              <span>Mode</span>
              <select className="control-input" value={selection} onChange={(e) => setSelection(e.target.value)}>
                <option value="single">Single</option>
                <option value="multi">Multi</option>
                <option value="bundle">Bundle</option>
                <option value="suggest">Suggest</option>
              </select>
            </label>
            <label className="role-form-field role-form-field-wide">
              <span>Options</span>
              <input
                className="control-input"
                placeholder="postgres, mysql, …"
                value={optionsText}
                onChange={(e) => setOptionsText(e.target.value)}
              />
            </label>
            <label className="role-form-field">
              <span>Default option</span>
              <input
                className="control-input"
                placeholder="optional id"
                value={defaultOptionId}
                onChange={(e) => setDefaultOptionId(e.target.value)}
                list="role-default-options"
              />
              <datalist id="role-default-options">
                {optionList().map((o) => <option key={o} value={o} />)}
              </datalist>
            </label>
            <label className="role-form-check">
              <input type="checkbox" checked={allowMulti} onChange={(e) => setAllowMulti(e.target.checked)} />
              <span>Allow multi override</span>
            </label>
            <div className="role-form-actions">
              <button className="btn btn-primary btn-sm" type="submit" disabled={busy || !id.trim()}>
                {busy ? "…" : "Save"}
              </button>
              <button className="btn btn-ghost btn-sm" type="button" onClick={clearForm}>Clear</button>
            </div>
          </div>
          <div className="role-known">
            <span className="role-known-label">Known packages</span>
            <div className="role-known-chips">
              {enabledPkgs.map((pkgId) => {
                const selected = optionList().includes(pkgId);
                return (
                  <button
                    key={pkgId}
                    type="button"
                    className={`role-known-chip ${selected ? "is-on" : ""}`}
                    onClick={() => addOptionChip(pkgId)}
                    title={selected ? "Already in options" : `Add ${pkgId}`}
                  >
                    {pkgId}
                  </button>
                );
              })}
            </div>
          </div>
        </form>
      )}

      <div className="role-table-wrap">
        <div className="role-table-head">
          <h3 className="role-table-title">Configured roles</h3>
          <span className="muted role-table-count">{filtered.length} shown</span>
        </div>
        {filtered.length === 0 ? (
          <div className="catalog-empty muted">{rows.length ? "No matches." : "No roles yet."}</div>
        ) : (
          <div className="role-table" role="table">
            <div className="role-tr role-tr-head" role="row">
              <div role="columnheader">Role</div>
              <div role="columnheader">Mode</div>
              <div role="columnheader">Options</div>
              <div role="columnheader">Default</div>
              <div role="columnheader">Multi override</div>
              <div role="columnheader">Status</div>
              <div role="columnheader"><span className="sr-only">Actions</span></div>
            </div>
            {filtered.map((r) => {
              const icon = roleIcon(r.id);
              const opts = r.options || [];
              return (
                <div key={r.id} className={`role-tr ${r.enabled === false ? "is-off" : ""}`} role="row">
                  <div className="role-td role-td-role" role="cell">
                    <span className="role-icon" style={{ background: icon.bg }} aria-hidden="true">{icon.label}</span>
                    <div className="role-td-role-text">
                      <code className="role-id">{r.id}</code>
                      <span className="role-label">{r.label || r.id}</span>
                    </div>
                  </div>
                  <div className="role-td" role="cell">
                    <select
                      className={`control-input role-mode-select is-${r.selection}`}
                      value={r.selection}
                      onChange={(e) => updateRole(r, { selection: e.target.value })}
                      aria-label={`Mode for ${r.id}`}
                    >
                      <option value="single">Single</option>
                      <option value="multi">Multi</option>
                      <option value="bundle">Bundle</option>
                      <option value="suggest">Suggest</option>
                    </select>
                  </div>
                  <div className="role-td role-td-opts" role="cell">
                    {opts.length ? opts.map((pkg) => (
                      <span key={pkg} className="role-opt-chip">{pkg}</span>
                    )) : <span className="muted">—</span>}
                  </div>
                  <div className="role-td" role="cell">
                    {r.defaultOptionId
                      ? <code className="role-default">{r.defaultOptionId}</code>
                      : <span className="muted">—</span>}
                  </div>
                  <div className="role-td" role="cell">
                    <button
                      type="button"
                      className={`role-override-pill ${r.allowMultiOverride ? "is-yes" : ""}`}
                      onClick={() => updateRole(r, { allowMultiOverride: !r.allowMultiOverride })}
                      title="Toggle allow multi override (for single mode)"
                    >
                      {r.allowMultiOverride ? "Yes" : "No"}
                    </button>
                  </div>
                  <div className="role-td" role="cell">
                    <button
                      type="button"
                      className={`role-status ${r.enabled === false ? "is-off" : "is-on"}`}
                      onClick={() => updateRole(r, { enabled: r.enabled === false })}
                    >
                      <span className="role-status-dot" aria-hidden="true" />
                      {r.enabled === false ? "Off" : "Active"}
                    </button>
                  </div>
                  <div className="role-td role-td-actions" role="cell" onClick={(e) => e.stopPropagation()}>
                    <button type="button" className="role-action-btn" title="Edit" onClick={() => beginEdit(r)}>✎</button>
                    <div className="role-menu">
                      <button
                        type="button"
                        className="role-action-btn"
                        aria-label={`More for ${r.id}`}
                        aria-expanded={menuId === r.id}
                        onClick={() => setMenuId((cur) => (cur === r.id ? null : r.id))}
                      >
                        ⋮
                      </button>
                      {menuId === r.id && (
                        <div className="role-menu-pop" role="menu">
                          <button type="button" onClick={() => beginEdit(r)}>Edit in form</button>
                          <button type="button" className="is-danger" onClick={() => { setMenuId(null); remove(r.id); }}>
                            Remove
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function roleIcon(id) {
  const map = {
    web: { label: "Wb", bg: "#2563eb" },
    db: { label: "DB", bg: "#7c3aed" },
    docker: { label: "Dk", bg: "#0891b2" },
    api: { label: "{}", bg: "#ca8a04" },
    cache: { label: "Ca", bg: "#dc2626" },
    queue: { label: "Q", bg: "#ea580c" },
    app: { label: "Ap", bg: "#059669" },
    worker: { label: "Wk", bg: "#4f46e5" },
  };
  if (map[id]) return map[id];
  const clean = String(id || "?").replace(/[^a-z0-9]/gi, "");
  const label = (clean.slice(0, 2) || "?").toUpperCase();
  let hash = 0;
  for (let i = 0; i < String(id).length; i++) hash = (hash * 31 + String(id).charCodeAt(i)) >>> 0;
  const hues = [210, 265, 152, 24, 34, 190];
  return { label, bg: `hsl(${hues[hash % hues.length]} 52% 42%)` };
}

function SizesPanel() {
  const { confirm } = useDialog();
  const [rows, setRows] = useState([]);
  const [key, setKey] = useState("");
  const [label, setLabel] = useState("");
  const [cpu, setCpu] = useState(2);
  const [memoryGB, setMemoryGB] = useState(4);
  const [query, setQuery] = useState("");
  const [showAdd, setShowAdd] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const load = () => adminListInstanceSizes().then(setRows).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) =>
      r.key.toLowerCase().includes(q)
      || (r.label || "").toLowerCase().includes(q)
      || String(r.cpu).includes(q)
      || String(r.memoryGB).includes(q),
    );
  }, [rows, query]);

  const enabledCount = rows.filter((r) => r.enabled).length;
  const cpuSum = rows.reduce((n, r) => n + (Number(r.cpu) || 0), 0);
  const ramSum = rows.reduce((n, r) => n + (Number(r.memoryGB) || 0), 0);

  const add = async (e) => {
    e?.preventDefault();
    setError("");
    setBusy(true);
    try {
      await adminUpsertInstanceSize({
        key: key.trim().toLowerCase(),
        label: label.trim() || key.trim(),
        cpu: Number(cpu) || 1,
        memoryGB: Number(memoryGB) || 1,
        sortOrder: rows.length,
        enabled: true,
      });
      setKey("");
      setLabel("");
      setCpu(2);
      setMemoryGB(4);
      setShowAdd(false);
      await load();
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setBusy(false);
    }
  };

  const toggleEnabled = async (row) => {
    await adminUpsertInstanceSize({ ...row, enabled: !row.enabled });
    await load();
  };

  const updateField = async (row, field, value) => {
    const num = Number(value);
    if (!Number.isFinite(num) || num < 1) return;
    if (Number(row[field]) === num) return;
    await adminUpsertInstanceSize({ ...row, [field]: num });
    await load();
  };

  const remove = async (sizeKey) => {
    const ok = await confirm({
      title: "Remove size?",
      message: `“${sizeKey}” will disappear from provisioning size pickers.`,
      confirmLabel: "Remove",
      tone: "danger",
    });
    if (!ok) return;
    await adminDeleteInstanceSize(sizeKey);
    await load();
  };

  const sizeIcon = (k) => {
    const map = {
      micro: { label: "μ", bg: "#64748b" },
      small: { label: "S", bg: "#2563eb" },
      medium: { label: "M", bg: "#7c3aed" },
      large: { label: "L", bg: "#ea580c" },
      xlarge: { label: "XL", bg: "#dc2626" },
    };
    if (map[k]) return map[k];
    return { label: String(k || "?").slice(0, 2).toUpperCase(), bg: "#059669" };
  };

  return (
    <div className="adm-board">
      <div className="adm-stat-grid">
        <div className="adm-stat-card">
          <span className="adm-stat-icon is-brand" aria-hidden="true">▦</span>
          <div>
            <div className="adm-stat-label">Total sizes</div>
            <div className="adm-stat-value">{rows.length}</div>
            <div className="adm-stat-hint">T-shirt catalog</div>
          </div>
        </div>
        <div className="adm-stat-card">
          <span className="adm-stat-icon is-ok" aria-hidden="true">✓</span>
          <div>
            <div className="adm-stat-label">Enabled</div>
            <div className="adm-stat-value">{enabledCount}</div>
            <div className="adm-stat-hint">Shown at provision</div>
          </div>
        </div>
        <div className="adm-stat-card">
          <span className="adm-stat-icon is-blue" aria-hidden="true">CPU</span>
          <div>
            <div className="adm-stat-label">CPU cores</div>
            <div className="adm-stat-value">{cpuSum}</div>
            <div className="adm-stat-hint">Sum of sizes</div>
          </div>
        </div>
        <div className="adm-stat-card">
          <span className="adm-stat-icon is-purple" aria-hidden="true">RAM</span>
          <div>
            <div className="adm-stat-label">RAM (GB)</div>
            <div className="adm-stat-value">{ramSum}</div>
            <div className="adm-stat-hint">Sum of sizes</div>
          </div>
        </div>
      </div>

      <div className="adm-board-toolbar">
        <input
          className="control-input adm-board-search"
          placeholder="Search sizes…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search sizes"
        />
        <button
          type="button"
          className={`btn btn-sm ${showAdd ? "btn-ghost" : "btn-primary"}`}
          onClick={() => setShowAdd((v) => !v)}
        >
          {showAdd ? "Cancel" : "+ Add size"}
        </button>
      </div>

      {showAdd && (
        <form className="adm-add-form" onSubmit={add}>
          {error && <div className="login-error adm-add-error">{error}</div>}
          <label className="adm-add-field">
            <span>Key</span>
            <input className="control-input" placeholder="e.g. small" value={key} onChange={(e) => setKey(e.target.value)} required />
          </label>
          <label className="adm-add-field">
            <span>Label</span>
            <input className="control-input" placeholder="e.g. Small" value={label} onChange={(e) => setLabel(e.target.value)} />
          </label>
          <label className="adm-add-field adm-add-field-sm">
            <span>CPU</span>
            <input className="control-input" type="number" min="1" max="128" value={cpu} onChange={(e) => setCpu(e.target.value)} />
          </label>
          <label className="adm-add-field adm-add-field-sm">
            <span>RAM GB</span>
            <input className="control-input" type="number" min="1" max="1024" value={memoryGB} onChange={(e) => setMemoryGB(e.target.value)} />
          </label>
          <button className="btn btn-primary btn-sm" type="submit" disabled={busy || !key.trim()}>
            {busy ? "…" : "Add"}
          </button>
        </form>
      )}

      <div className="adm-table-wrap">
        <div className="adm-table-head">
          <h3 className="adm-table-title">Instance sizes</h3>
          <span className="muted adm-table-count">{filtered.length} shown · Custom always available at provision</span>
        </div>
        {filtered.length === 0 ? (
          <div className="catalog-empty muted">{rows.length ? "No matches." : "No sizes yet."}</div>
        ) : (
          <div className="adm-dense-table size-table">
            <div className="adm-dense-tr adm-dense-head">
              <div>Size</div>
              <div>CPU</div>
              <div>RAM (GB)</div>
              <div>Status</div>
              <div />
            </div>
            {filtered.map((r) => {
              const icon = sizeIcon(r.key);
              return (
                <div key={r.key} className={`adm-dense-tr ${r.enabled ? "" : "is-off"}`}>
                  <div className="adm-dense-entity">
                    <span className="adm-entity-icon" style={{ background: icon.bg }} aria-hidden="true">{icon.label}</span>
                    <div>
                      <code className="adm-entity-id">{r.key}</code>
                      <div className="adm-entity-name">{r.label}</div>
                    </div>
                  </div>
                  <input
                    className="control-input adm-num-input"
                    type="number"
                    min="1"
                    max="128"
                    defaultValue={r.cpu}
                    key={`${r.key}-cpu-${r.cpu}`}
                    onBlur={(e) => updateField(r, "cpu", e.target.value)}
                    aria-label={`${r.label} CPU`}
                  />
                  <input
                    className="control-input adm-num-input"
                    type="number"
                    min="1"
                    max="1024"
                    defaultValue={r.memoryGB}
                    key={`${r.key}-ram-${r.memoryGB}`}
                    onBlur={(e) => updateField(r, "memoryGB", e.target.value)}
                    aria-label={`${r.label} RAM`}
                  />
                  <button type="button" className={`pkg-chip ${r.enabled ? "is-on" : "is-off"}`} onClick={() => toggleEnabled(r)}>
                    {r.enabled ? "On" : "Off"}
                  </button>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => remove(r.key)}>Remove</button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function HostnamePanel() {
  const [format, setFormat] = useState("");
  const [applicationsText, setApplicationsText] = useState("web, db, docker, api, cache, queue, app, worker");
  const [tokens, setTokens] = useState([]);
  const [defaultFormat, setDefaultFormat] = useState("{os}-{app}-{rand4}");
  const [defaultApplications, setDefaultApplications] = useState("web, db, docker, api, cache, queue, app, worker");
  const [preview, setPreview] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  const load = () =>
    adminGetHostnameFormat()
      .then((info) => {
        setFormat(info.format || "");
        setTokens(info.tokens || []);
        setDefaultFormat(info.defaultFormat || "{os}-{app}-{rand4}");
        const apps = Array.isArray(info.applications) ? info.applications.join(", ") : applicationsText;
        setApplicationsText(apps);
        if (Array.isArray(info.defaultApplications)) {
          setDefaultApplications(info.defaultApplications.join(", "));
        }
        return adminPreviewHostnameFormat({
          format: info.format,
          app: info.applications?.[0] || "web",
        });
      })
      .then((p) => setPreview(p.preview || ""))
      .catch((e) => setError(e.response?.data?.error || e.message));

  useEffect(() => { load(); }, []);

  useEffect(() => {
    if (!format.trim()) {
      setPreview("");
      return undefined;
    }
    const firstApp = applicationsText.split(/[,;\n]+/).map((s) => s.trim()).filter(Boolean)[0] || "web";
    const t = setTimeout(() => {
      adminPreviewHostnameFormat({ format, app: firstApp })
        .then((p) => setPreview(p.preview || ""))
        .catch(() => {});
    }, 250);
    return () => clearTimeout(t);
  }, [format, applicationsText]);

  const appList = applicationsText.split(/[,;\n]+/).map((s) => s.trim()).filter(Boolean);

  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    setSaved(false);
    try {
      const info = await adminSetHostnameFormat({ format, applications: applicationsText });
      setFormat(info.format);
      if (Array.isArray(info.applications)) setApplicationsText(info.applications.join(", "));
      setPreview(info.preview || "");
      setSaved(true);
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="adm-board">
      <div className="adm-stat-grid">
        <div className="adm-stat-card">
          <span className="adm-stat-icon is-brand" aria-hidden="true">{"{}"}</span>
          <div>
            <div className="adm-stat-label">Tokens</div>
            <div className="adm-stat-value">{tokens.length}</div>
            <div className="adm-stat-hint">Available placeholders</div>
          </div>
        </div>
        <div className="adm-stat-card">
          <span className="adm-stat-icon is-purple" aria-hidden="true">App</span>
          <div>
            <div className="adm-stat-label">Applications</div>
            <div className="adm-stat-value">{appList.length}</div>
            <div className="adm-stat-hint">{"{app}"} options</div>
          </div>
        </div>
        <div className="adm-stat-card adm-stat-card-wide">
          <span className="adm-stat-icon is-blue" aria-hidden="true">◉</span>
          <div>
            <div className="adm-stat-label">Live preview</div>
            <div className="adm-stat-value adm-stat-mono">{preview || "—"}</div>
            <div className="adm-stat-hint">Updates as you type</div>
          </div>
        </div>
      </div>

      <form className="adm-host-form" onSubmit={save}>
        {error && <div className="login-error">{error}</div>}
        <div className="adm-host-form-row">
          <label className="adm-add-field adm-add-field-grow">
            <span>Format pattern</span>
            <input
              className="control-input adm-mono-input"
              value={format}
              onChange={(e) => { setFormat(e.target.value); setSaved(false); }}
              placeholder={defaultFormat}
              aria-label="Hostname format"
            />
          </label>
          <div className="adm-host-actions">
            <button
              className="btn btn-ghost btn-sm"
              type="button"
              onClick={() => {
                setFormat(defaultFormat);
                setApplicationsText(defaultApplications);
                setSaved(false);
              }}
            >
              Reset
            </button>
            <button className="btn btn-primary btn-sm" type="submit" disabled={busy || !format.trim()}>
              {busy ? "Saving…" : saved ? "Saved ✓" : "Save"}
            </button>
          </div>
        </div>
        <label className="adm-add-field adm-add-field-full">
          <span>Application options (comma-separated · used for {"{app}"})</span>
          <input
            className="control-input adm-mono-input"
            value={applicationsText}
            onChange={(e) => { setApplicationsText(e.target.value); setSaved(false); }}
            placeholder={defaultApplications}
            aria-label="Hostname applications"
          />
        </label>
        {appList.length > 0 && (
          <div className="adm-chip-row">
            {appList.map((a) => (
              <span key={a} className="role-opt-chip">{a}</span>
            ))}
          </div>
        )}
      </form>

      <div className="adm-table-wrap">
        <div className="adm-table-head">
          <h3 className="adm-table-title">Available tokens</h3>
          <span className="muted adm-table-count">Replaced at suggestion time · {"{n}"} increments globally</span>
        </div>
        <div className="adm-token-grid">
          {tokens.map((t) => (
            <div key={t.token} className="adm-token-card">
              <code className="adm-token-code">{t.token}</code>
              <span className="adm-token-meaning">{t.meaning}</span>
            </div>
          ))}
          {tokens.length === 0 && <div className="catalog-empty muted">No tokens loaded.</div>}
        </div>
      </div>
    </div>
  );
}

function WorkflowsPanel() {
  const [rows, setRows] = useState([]);
  const [expanded, setExpanded] = useState(null);
  const [query, setQuery] = useState("");
  const [showApi, setShowApi] = useState(false);

  useEffect(() => {
    adminListWorkflows().then(setRows);
  }, []);

  const stages = (steps) => {
    const map = new Map();
    for (const s of steps || []) {
      if (!map.has(s.stage)) map.set(s.stage, []);
      map.get(s.stage).push(s);
    }
    return [...map.entries()];
  };

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) =>
      r.id.toLowerCase().includes(q)
      || (r.name || "").toLowerCase().includes(q)
      || (r.steps || []).some((s) => String(s.label || "").toLowerCase().includes(q)),
    );
  }, [rows, query]);

  const stepCount = rows.reduce((n, r) => n + (r.steps?.length || 0), 0);
  const stageCount = rows.reduce((n, r) => n + stages(r.steps).length, 0);

  return (
    <div className="adm-board">
      <div className="adm-stat-grid">
        <div className="adm-stat-card">
          <span className="adm-stat-icon is-brand" aria-hidden="true">⛓</span>
          <div>
            <div className="adm-stat-label">Workflows</div>
            <div className="adm-stat-value">{rows.length}</div>
            <div className="adm-stat-hint">Internal templates</div>
          </div>
        </div>
        <div className="adm-stat-card">
          <span className="adm-stat-icon is-blue" aria-hidden="true">↳</span>
          <div>
            <div className="adm-stat-label">Stages</div>
            <div className="adm-stat-value">{stageCount}</div>
            <div className="adm-stat-hint">Across all templates</div>
          </div>
        </div>
        <div className="adm-stat-card">
          <span className="adm-stat-icon is-purple" aria-hidden="true">≡</span>
          <div>
            <div className="adm-stat-label">Steps</div>
            <div className="adm-stat-value">{stepCount}</div>
            <div className="adm-stat-hint">Total actions</div>
          </div>
        </div>
        <div className="adm-stat-card">
          <span className="adm-stat-icon is-ok" aria-hidden="true">API</span>
          <div>
            <div className="adm-stat-label">Manage via API</div>
            <div className="adm-stat-value adm-stat-sm">POST</div>
            <div className="adm-stat-hint">/api/admin/workflows</div>
          </div>
        </div>
      </div>

      <div className="adm-board-toolbar">
        <input
          className="control-input adm-board-search"
          placeholder="Search workflows…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search workflows"
        />
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setShowApi((v) => !v)}>
          {showApi ? "Hide API" : "API hint"}
        </button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setExpanded(null)} disabled={!expanded}>
          Collapse
        </button>
      </div>

      {showApi && (
        <div className="adm-api-hint">
          <code>POST /api/admin/workflows</code>
          <span className="muted">Create or update multi-step internal builds (not Proxmox VM clones).</span>
        </div>
      )}

      {filtered.length === 0 ? (
        <div className="catalog-empty muted">{rows.length ? "No matches." : "No workflows defined."}</div>
      ) : (
        <div className="wf-list">
          {filtered.map((r) => {
            const open = expanded === r.id;
            const stageEntries = stages(r.steps);
            return (
              <section key={r.id} className={`wf-box ${open ? "" : "is-collapsed"}`}>
                <button
                  type="button"
                  className="wf-box-head"
                  onClick={() => setExpanded(open ? null : r.id)}
                  aria-expanded={open}
                >
                  <span className="adm-entity-icon is-wf" aria-hidden="true">⚙</span>
                  <div className="wf-box-titles">
                    <div className="wf-box-name">{r.name || r.id}</div>
                    <code className="wf-box-id">{r.id}</code>
                  </div>
                  <span className="wf-box-meta">{r.steps?.length || 0} steps · {stageEntries.length} stages</span>
                  <span className="wf-box-chevron" aria-hidden="true">{open ? "▾" : "▸"}</span>
                </button>
                {open && (
                  <div className="wf-box-body">
                    {stageEntries.map(([stage, steps]) => (
                      <div key={stage} className="wf-stage">
                        <div className="wf-stage-label">{stage}</div>
                        <ol className="wf-steps">
                          {steps.map((s, i) => (
                            <li key={s.id || s.key || `${stage}-${i}`}>
                              <span className="wf-step-n">{i + 1}</span>
                              {s.label}
                            </li>
                          ))}
                        </ol>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default function CatalogAdmin({ section = "packages", embedded = false } = {}) {
  const active = SECTIONS.find((s) => s.id === section) || SECTIONS[0];

  return (
    <div className={`catalog-admin ${embedded ? "catalog-admin-embedded" : ""}`}>
      {embedded ? (
        <AdminPageHeader title={active.title} description={active.summary} />
      ) : (
        <div className="page-head">
          <div className="eyebrow">Administration</div>
          <h1>Catalog</h1>
          <p>Software packages for VM provisioning and optional internal workflow templates.</p>
        </div>
      )}

      <div className={embedded ? "" : "catalog-layout"}>
        {!embedded && (
          <nav className="catalog-nav" aria-label="Catalog sections">
            {SECTIONS.map((s) => (
              <button key={s.id} type="button" className={`catalog-nav-item ${section === s.id ? "active" : ""}`}>
                <span className="catalog-nav-icon" aria-hidden="true">{s.icon}</span>
                <span className="catalog-nav-text">
                  <span className="catalog-nav-label">{s.label}</span>
                  <span className="catalog-nav-desc">{s.summary}</span>
                </span>
              </button>
            ))}
          </nav>
        )}
        <div className="catalog-content" key={section}>
          {section === "packages" && <PackagesPanel section={active} />}
          {section === "app-roles" && <AppRolesPanel />}
          {section === "sizes" && <SizesPanel />}
          {section === "hostname" && <HostnamePanel />}
          {section === "workflows" && <WorkflowsPanel />}
        </div>
      </div>
    </div>
  );
}


