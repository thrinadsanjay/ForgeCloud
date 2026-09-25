import { useEffect, useMemo, useRef, useState } from "react";
import {
  adminListPackages,
  adminUpsertPackage,
  adminDeletePackage,
  adminListApplicationRoles,
  adminUpsertApplicationRole,
  adminDeleteApplicationRole,
  adminListAppBlueprints,
  adminUpsertAppBlueprint,
  adminDeleteAppBlueprint,
  adminGetCatalogValidation,
  adminListWorkflows,
  adminListInstanceSizes,
  adminUpsertInstanceSize,
  adminDeleteInstanceSize,
  adminGetHostnameFormat,
  adminSetHostnameFormat,
  adminPreviewHostnameFormat,
  adminSyncHostnameFromRoles,
} from "../api/client.js";
import { useDialog } from "../components/DialogProvider.jsx";
import AdminPageHeader from "../components/AdminPageHeader.jsx";
import Toggle from "../components/Toggle.jsx";
import AnchoredPopover from "../components/AnchoredPopover.jsx";

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

function CatalogValidationBanner() {
  const [report, setReport] = useState(null);

  const refresh = () => {
    adminGetCatalogValidation()
      .then(setReport)
      .catch(() => setReport(null));
  };
  useEffect(() => { refresh(); }, []);

  if (!report?.issues?.length) return null;
  const errors = report.issues.filter((i) => i.severity === "error");
  const warns = report.issues.filter((i) => i.severity === "warn");
  return (
    <div className={`catalog-validation ${errors.length ? "is-error" : "is-warn"}`} role="status">
      <div className="catalog-validation-head">
        <strong>{errors.length ? "Catalog issues" : "Catalog warnings"}</strong>
        <button type="button" className="btn btn-ghost btn-sm" onClick={refresh}>Refresh</button>
      </div>
      <ul>
        {report.issues.slice(0, 8).map((i, idx) => (
          <li key={`${i.code}-${idx}`}>{i.message}</li>
        ))}
      </ul>
      {report.issues.length > 8 && (
        <p className="muted" style={{ margin: "6px 0 0", fontSize: 12 }}>
          +{report.issues.length - 8} more — fix Packages / App roles, then refresh.
        </p>
      )}
      {warns.length > 0 && errors.length === 0 && (
        <p className="muted" style={{ margin: "6px 0 0", fontSize: 12 }}>
          Warnings do not block saves; errors do.
        </p>
      )}
    </div>
  );
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
    id: "blueprints",
    label: "Blueprints",
    icon: "🚀",
    title: "Application blueprints",
    summary: "Create, edit, enable, and delete Ansible / Compose apps users pick at provision time.",
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

const APP_CATEGORY_OPTIONS = [
  "Containers",
  "Kubernetes",
  "Monitoring",
  "Web",
  "Developer",
  "General",
];

const APP_STRATEGY_OPTIONS = [
  { value: "ansible", label: "Ansible" },
  { value: "compose", label: "Compose" },
  { value: "ansible+compose", label: "Ansible + Compose" },
];

function emptyAppForm() {
  return {
    id: "",
    name: "",
    description: "",
    category: "General",
    strategy: "ansible",
    dependsOn: "",
    ansiblePlaybook: "",
    composePath: "",
    ports: "",
    urlTemplate: "",
    components: "",
    eta: "",
    enabled: true,
    healthType: "",
    healthPort: "",
    healthPath: "",
    healthTimeoutSec: "90",
    sortOrder: 0,
  };
}

function formFromApp(row) {
  const hc = row.healthcheck && typeof row.healthcheck === "object" ? row.healthcheck : {};
  const vars = row.defaultVars && typeof row.defaultVars === "object" ? row.defaultVars : {};
  const comps = Array.isArray(row.components)
    ? row.components
    : (Array.isArray(vars.components) ? vars.components : []);
  return {
    id: row.id || "",
    name: row.name || "",
    description: row.description || "",
    category: row.category || vars.category || "General",
    strategy: row.strategy || "ansible",
    dependsOn: Array.isArray(row.dependsOn) ? row.dependsOn.join(", ") : "",
    ansiblePlaybook: row.ansiblePlaybook || "",
    composePath: row.composePath || "",
    ports: Array.isArray(row.ports) ? row.ports.join(", ") : "",
    urlTemplate: row.urlTemplate || "",
    components: comps.join(", "),
    eta: row.eta || vars.eta || "",
    enabled: row.enabled !== false,
    healthType: hc.type || "",
    healthPort: hc.port != null ? String(hc.port) : "",
    healthPath: hc.path || "",
    healthTimeoutSec: hc.timeoutSec != null ? String(hc.timeoutSec) : "90",
    sortOrder: row.sortOrder ?? 0,
  };
}

function parseCsvList(value) {
  return String(value || "")
    .split(/[,;\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function PackagesPanel({ section }) {
  const { confirm } = useDialog();
  const [rows, setRows] = useState([]);
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [installPkg, setInstallPkg] = useState("");
  const [category, setCategory] = useState("Uncategorized");
  const [hostnameCode, setHostnameCode] = useState("");
  const [description, setDescription] = useState("");
  const [isDefault, setIsDefault] = useState(false);
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [collapsed, setCollapsed] = useState({});
  const [menuId, setMenuId] = useState(null);
  const menuBtnRefs = useRef({});
  const committedRef = useRef({});

  const load = () => adminListPackages().then((data) => {
    setRows(data);
    committedRef.current = Object.fromEntries(
      data.map((r) => [r.id, {
        hostnameCode: r.hostnameCode || null,
        installPkg: r.installPkg || null,
        description: r.description || null,
      }]),
    );
  }).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) =>
      r.id.toLowerCase().includes(q)
      || (r.name || "").toLowerCase().includes(q)
      || (r.installPkg || "").toLowerCase().includes(q)
      || (r.category || "").toLowerCase().includes(q)
      || (r.hostnameCode || "").toLowerCase().includes(q)
      || (r.description || "").toLowerCase().includes(q),
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
        description: description.trim() || null,
        isDefault,
        enabled: true,
        sortOrder: rows.length,
      });
      setId("");
      setName("");
      setInstallPkg("");
      setCategory("Uncategorized");
      setHostnameCode("");
      setDescription("");
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
      <CatalogValidationBanner />
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
          <label className="pkg-board-add-field pkg-board-add-field-wide">
            <span>Description</span>
            <input className="control-input" placeholder="Short blurb (optional)" value={description} onChange={(e) => setDescription(e.target.value)} />
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
                        r.description || null,
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
                                ref={(el) => { menuBtnRefs.current[r.id] = el; }}
                                aria-label={`Actions for ${title}`}
                                aria-expanded={menuId === r.id}
                                onClick={() => setMenuId((cur) => (cur === r.id ? null : r.id))}
                              >
                                ⋮
                              </button>
                              <AnchoredPopover
                                open={menuId === r.id}
                                onClose={() => setMenuId(null)}
                                anchorRef={{ current: menuBtnRefs.current[r.id] }}
                                className="pkg-card-menu-pop"
                                estimatedHeight={220}
                                estimatedWidth={200}
                                closeOnScroll={false}
                              >
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
                                <label className="pkg-card-menu-field">
                                  <span>Description</span>
                                  <input
                                    className="control-input pkg-card-code"
                                    value={r.description || ""}
                                    placeholder="Short blurb"
                                    onBlur={(e) => commitMetaField(r, "description", e.target.value, (raw) => {
                                      const v = String(raw || "").trim();
                                      return v || null;
                                    })}
                                    onChange={(e) => {
                                      setRows((prev) => prev.map((x) => (x.id === r.id ? { ...x, description: e.target.value } : x)));
                                    }}
                                  />
                                </label>
                                <button type="button" className="pkg-card-menu-danger" onClick={() => { setMenuId(null); remove(r.id); }}>
                                  Remove package
                                </button>
                              </AnchoredPopover>
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
  const menuBtnRefs = useRef({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const load = async () => {
    const [roles, pkgs] = await Promise.all([adminListApplicationRoles(), adminListPackages()]);
    setRows(roles);
    setPackages(pkgs);
  };
  useEffect(() => { load().catch((e) => setError(e.message)); }, []);

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
    try {
      await adminUpsertApplicationRole({ ...row, ...patch });
      setError("");
      await load();
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    }
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
      <CatalogValidationBanner />
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
            <div className="role-form-check">
              <Toggle
                variant="square"
                size="sm"
                checked={allowMulti}
                onChange={setAllowMulti}
                title="Allow multi override"
              />
              <span>Allow multi override</span>
            </div>
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
                        ref={(el) => { menuBtnRefs.current[r.id] = el; }}
                        aria-label={`More for ${r.id}`}
                        aria-expanded={menuId === r.id}
                        onClick={() => setMenuId((cur) => (cur === r.id ? null : r.id))}
                      >
                        ⋮
                      </button>
                      <AnchoredPopover
                        open={menuId === r.id}
                        onClose={() => setMenuId(null)}
                        anchorRef={{ current: menuBtnRefs.current[r.id] }}
                        className="role-menu-pop"
                        estimatedHeight={88}
                        estimatedWidth={140}
                      >
                        <button type="button" onClick={() => beginEdit(r)}>Edit in form</button>
                        <button type="button" className="is-danger" onClick={() => { setMenuId(null); remove(r.id); }}>
                          Remove
                        </button>
                      </AnchoredPopover>
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

function AppsPanel() {
  const { confirm } = useDialog();
  const [rows, setRows] = useState([]);
  const [form, setForm] = useState(() => emptyAppForm());
  const [editingId, setEditingId] = useState(null);
  const [showForm, setShowForm] = useState(false);
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const load = () => adminListAppBlueprints().then(setRows).catch((e) => setError(e.response?.data?.error || e.message));
  useEffect(() => { load(); }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) =>
      r.id.toLowerCase().includes(q)
      || (r.name || "").toLowerCase().includes(q)
      || (r.description || "").toLowerCase().includes(q)
      || (r.category || "").toLowerCase().includes(q)
      || (r.strategy || "").toLowerCase().includes(q)
      || (r.ansiblePlaybook || "").toLowerCase().includes(q)
      || (r.composePath || "").toLowerCase().includes(q),
    );
  }, [rows, query]);

  const enabledCount = rows.filter((r) => r.enabled).length;

  const setField = (key, value) => setForm((prev) => ({ ...prev, [key]: value }));

  const openAdd = () => {
    setEditingId(null);
    setForm(emptyAppForm());
    setError("");
    setShowForm(true);
  };

  const openEdit = (row) => {
    setEditingId(row.id);
    setForm(formFromApp(row));
    setError("");
    setShowForm(true);
  };

  const cancelForm = () => {
    setShowForm(false);
    setEditingId(null);
    setForm(emptyAppForm());
    setError("");
  };

  const save = async (e) => {
    e?.preventDefault();
    setError("");
    setBusy(true);
    try {
      const existing = editingId ? rows.find((r) => r.id === editingId) : null;
      const components = parseCsvList(form.components);
      const eta = form.eta.trim();
      await adminUpsertAppBlueprint({
        id: form.id.trim(),
        name: form.name.trim() || form.id.trim(),
        description: form.description.trim(),
        category: form.category || "General",
        strategy: form.strategy,
        dependsOn: form.dependsOn,
        ansiblePlaybook: form.ansiblePlaybook.trim(),
        composePath: form.composePath.trim(),
        ports: form.ports,
        urlTemplate: form.urlTemplate.trim(),
        healthType: form.healthType,
        healthPort: form.healthPort,
        healthPath: form.healthPath.trim(),
        healthTimeoutSec: form.healthTimeoutSec,
        sortOrder: Number.isFinite(Number(form.sortOrder)) ? Number(form.sortOrder) : (existing?.sortOrder ?? rows.length * 10),
        enabled: form.enabled !== false,
        defaultVars: {
          ...(existing?.defaultVars || {}),
          category: form.category || "General",
          components,
          ...(eta ? { eta } : {}),
        },
      });
      cancelForm();
      await load();
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setBusy(false);
    }
  };

  const toggleEnabled = async (row) => {
    try {
      await adminUpsertAppBlueprint({
        ...row,
        category: row.category || row.defaultVars?.category || "General",
        dependsOn: row.dependsOn || [],
        ports: row.ports || [],
        healthcheck: row.healthcheck || {},
        defaultVars: row.defaultVars || {},
        enabled: !row.enabled,
      });
      await load();
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    }
  };

  const remove = async (appId) => {
    const ok = await confirm({
      title: "Delete blueprint?",
      message: `“${appId}” will be removed from the catalog and the provision picker. This cannot be undone.`,
      confirmLabel: "Delete",
      tone: "danger",
    });
    if (!ok) return;
    try {
      await adminDeleteAppBlueprint(appId);
      if (editingId === appId) cancelForm();
      await load();
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    }
  };

  const needsAnsible = form.strategy === "ansible" || form.strategy === "ansible+compose";
  const needsCompose = form.strategy === "compose" || form.strategy === "ansible+compose";
  const otherBlueprintIds = rows.filter((r) => r.id !== editingId).map((r) => r.id);

  return (
    <div className="adm-board">
      <div className="adm-stat-grid">
        <div className="adm-stat-card">
          <span className="adm-stat-icon is-brand" aria-hidden="true">◆</span>
          <div>
            <div className="adm-stat-label">Blueprints</div>
            <div className="adm-stat-value">{rows.length}</div>
            <div className="adm-stat-hint">Create · edit · delete</div>
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
          <span className="adm-stat-icon is-blue" aria-hidden="true">deps</span>
          <div>
            <div className="adm-stat-label">With deps</div>
            <div className="adm-stat-value">{rows.filter((r) => (r.dependsOn || []).length).length}</div>
            <div className="adm-stat-hint">Auto-include parents</div>
          </div>
        </div>
      </div>

      <div className="adm-board-toolbar">
        <input
          className="control-input adm-board-search"
          placeholder="Search blueprints…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search blueprints"
        />
        <button
          type="button"
          className={`btn btn-sm ${showForm && !editingId ? "btn-ghost" : "btn-primary"}`}
          onClick={() => (showForm && !editingId ? cancelForm() : openAdd())}
        >
          {showForm && !editingId ? "Cancel" : "+ Create blueprint"}
        </button>
      </div>

      {showForm && (
        <form className="adm-add-form apps-blueprint-form" onSubmit={save}>
          <div className="apps-blueprint-form-head">
            <strong>{editingId ? `Edit blueprint · ${editingId}` : "Create blueprint"}</strong>
            <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>
              Metadata only — playbooks and compose files live in the Ansible content repo.
            </p>
          </div>
          {error && <div className="login-error adm-add-error">{error}</div>}
          <label className="adm-add-field">
            <span>ID</span>
            <input
              className="control-input"
              placeholder="e.g. grafana-influx"
              value={form.id}
              onChange={(e) => setField("id", e.target.value)}
              required
              disabled={Boolean(editingId)}
            />
          </label>
          <label className="adm-add-field">
            <span>Name</span>
            <input className="control-input" placeholder="Display name" value={form.name} onChange={(e) => setField("name", e.target.value)} required />
          </label>
          <label className="adm-add-field">
            <span>Category</span>
            <select className="control-input" value={form.category} onChange={(e) => setField("category", e.target.value)}>
              {APP_CATEGORY_OPTIONS.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </label>
          <label className="adm-add-field">
            <span>Strategy</span>
            <select className="control-input" value={form.strategy} onChange={(e) => setField("strategy", e.target.value)}>
              {APP_STRATEGY_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </label>
          <label className="adm-add-field adm-add-field-grow">
            <span>Description</span>
            <input className="control-input" value={form.description} onChange={(e) => setField("description", e.target.value)} />
          </label>
          <label className="adm-add-field adm-add-field-grow">
            <span>Components (shown on cards)</span>
            <input
              className="control-input"
              placeholder="Docker Engine, Compose, Portainer"
              value={form.components}
              onChange={(e) => setField("components", e.target.value)}
            />
          </label>
          <label className="adm-add-field">
            <span>ETA label</span>
            <input className="control-input" placeholder="5–8 min" value={form.eta} onChange={(e) => setField("eta", e.target.value)} />
          </label>
          <label className="adm-add-field">
            <span>Depends on</span>
            <input
              className="control-input"
              placeholder={otherBlueprintIds.length ? otherBlueprintIds.slice(0, 4).join(", ") : "docker, …"}
              value={form.dependsOn}
              onChange={(e) => setField("dependsOn", e.target.value)}
              list="blueprint-dep-suggestions"
            />
            <datalist id="blueprint-dep-suggestions">
              {otherBlueprintIds.map((id) => <option key={id} value={id} />)}
            </datalist>
          </label>
          <label className="adm-add-field">
            <span>Ports</span>
            <input className="control-input" placeholder="3000, 8086" value={form.ports} onChange={(e) => setField("ports", e.target.value)} />
          </label>
          {needsAnsible && (
            <label className="adm-add-field adm-add-field-grow">
              <span>Ansible playbook</span>
              <input className="control-input" placeholder="playbooks/docker.yml" value={form.ansiblePlaybook} onChange={(e) => setField("ansiblePlaybook", e.target.value)} required={needsAnsible} />
            </label>
          )}
          {needsCompose && (
            <label className="adm-add-field adm-add-field-grow">
              <span>Compose path</span>
              <input className="control-input" placeholder="apps/portainer/compose.yml" value={form.composePath} onChange={(e) => setField("composePath", e.target.value)} required={needsCompose} />
            </label>
          )}
          <label className="adm-add-field adm-add-field-grow">
            <span>URL template</span>
            <input className="control-input" placeholder="http://{ip}:3000" value={form.urlTemplate} onChange={(e) => setField("urlTemplate", e.target.value)} />
          </label>
          <label className="adm-add-field adm-add-field-sm">
            <span>Health</span>
            <select className="control-input" value={form.healthType} onChange={(e) => setField("healthType", e.target.value)}>
              <option value="">None</option>
              <option value="tcp">TCP</option>
              <option value="http">HTTP</option>
            </select>
          </label>
          <label className="adm-add-field adm-add-field-sm">
            <span>HC port</span>
            <input className="control-input" type="number" min="1" max="65535" value={form.healthPort} onChange={(e) => setField("healthPort", e.target.value)} />
          </label>
          <label className="adm-add-field">
            <span>HC path</span>
            <input className="control-input" placeholder="/api/health" value={form.healthPath} onChange={(e) => setField("healthPath", e.target.value)} />
          </label>
          <label className="adm-add-field adm-add-field-sm">
            <span>Timeout s</span>
            <input className="control-input" type="number" min="10" value={form.healthTimeoutSec} onChange={(e) => setField("healthTimeoutSec", e.target.value)} />
          </label>
          <label className="adm-add-field adm-add-field-sm">
            <span>Sort</span>
            <input className="control-input" type="number" value={form.sortOrder} onChange={(e) => setField("sortOrder", e.target.value)} />
          </label>
          <div className="adm-add-field adm-add-field-sm apps-blueprint-enabled">
            <span>Enabled</span>
            <Toggle
              variant="square"
              size="sm"
              checked={form.enabled !== false}
              onChange={(on) => setField("enabled", on)}
              title="Show in provision picker"
            />
          </div>
          <div className="adm-add-actions">
            <button className="btn btn-primary btn-sm" type="submit" disabled={busy || !form.id.trim()}>
              {busy ? "Saving…" : editingId ? "Save changes" : "Create blueprint"}
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={cancelForm}>Cancel</button>
            {editingId && (
              <button type="button" className="btn btn-ghost btn-sm" style={{ color: "var(--danger, #b91c1c)" }} onClick={() => remove(editingId)}>
                Delete
              </button>
            )}
          </div>
        </form>
      )}

      {!showForm && error && <div className="login-error" style={{ marginBottom: "0.75rem" }}>{error}</div>}

      <div className="adm-table-wrap">
        <div className="adm-table-head">
          <h3 className="adm-table-title">Application blueprints</h3>
          <span className="muted adm-table-count">{filtered.length} shown · Paths are relative to the Ansible content repo</span>
        </div>
        {filtered.length === 0 ? (
          <div className="catalog-empty">
            <p className="muted" style={{ margin: "0 0 12px" }}>
              {rows.length ? "No matches." : "No blueprints yet. Create one to offer Ansible / Compose apps at provision time."}
            </p>
            {!rows.length && (
              <button type="button" className="btn btn-primary btn-sm" onClick={openAdd}>+ Create blueprint</button>
            )}
          </div>
        ) : (
          <div className="adm-dense-table apps-blueprint-table">
            <div className="adm-dense-tr adm-dense-head apps-blueprint-row">
              <div>Blueprint</div>
              <div>Strategy</div>
              <div>Paths / deps</div>
              <div>Status</div>
              <div>Manage</div>
            </div>
            {filtered.map((r) => (
              <div key={r.id} className={`adm-dense-tr apps-blueprint-row ${r.enabled ? "" : "is-off"}`}>
                <div className="adm-dense-entity">
                  <span className="adm-entity-icon" style={{ background: "#0f766e" }} aria-hidden="true">
                    {(r.name || r.id || "?").slice(0, 2).toUpperCase()}
                  </span>
                  <div>
                    <code className="adm-entity-id">{r.id}</code>
                    <div className="adm-entity-name">{r.name}</div>
                    <div className="muted" style={{ fontSize: "0.78rem" }}>
                      {r.category || "General"}
                      {(r.ports || []).length ? ` · ${(r.ports || []).join(", ")}` : ""}
                      {(r.components || r.defaultVars?.components || []).length
                        ? ` · ${(r.components || r.defaultVars.components).slice(0, 3).join(", ")}`
                        : ""}
                    </div>
                  </div>
                </div>
                <div>
                  <span className="pkg-chip is-optional">{r.strategy}</span>
                </div>
                <div className="apps-blueprint-paths muted">
                  {r.ansiblePlaybook ? <div><code>{r.ansiblePlaybook}</code></div> : null}
                  {r.composePath ? <div><code>{r.composePath}</code></div> : null}
                  {(r.dependsOn || []).length ? <div>depends: {(r.dependsOn || []).join(", ")}</div> : null}
                  {!r.ansiblePlaybook && !r.composePath && !(r.dependsOn || []).length ? "—" : null}
                </div>
                <Toggle
                  variant="square"
                  size="sm"
                  checked={r.enabled !== false}
                  onChange={() => toggleEnabled(r)}
                  title={r.enabled !== false ? "Disable blueprint" : "Enable blueprint"}
                />
                <div className="apps-blueprint-actions">
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => openEdit(r)}>Edit</button>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => remove(r.id)}>Delete</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
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
  const [roleApplications, setRoleApplications] = useState([]);
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
        setRoleApplications(Array.isArray(info.roleApplications) ? info.roleApplications : []);
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
  const rolesCsv = roleApplications.join(", ");
  const outOfSync = roleApplications.length > 0
    && rolesCsv !== appList.map((a) => a.toLowerCase()).join(", ");

  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    setSaved(false);
    try {
      const info = await adminSetHostnameFormat({ format, applications: applicationsText });
      setFormat(info.format);
      if (Array.isArray(info.applications)) setApplicationsText(info.applications.join(", "));
      if (Array.isArray(info.roleApplications)) setRoleApplications(info.roleApplications);
      setPreview(info.preview || "");
      setSaved(true);
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setBusy(false);
    }
  };

  const syncFromRoles = async () => {
    setBusy(true);
    setError("");
    try {
      const info = await adminSyncHostnameFromRoles();
      if (Array.isArray(info.applications)) setApplicationsText(info.applications.join(", "));
      if (Array.isArray(info.roleApplications)) setRoleApplications(info.roleApplications);
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
        <div className="adm-host-sync-row">
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            disabled={busy || !roleApplications.length}
            onClick={syncFromRoles}
            title="Replace application options with enabled App role ids"
          >
            Sync from App roles
          </button>
          {outOfSync ? (
            <span className="adm-host-sync-warn">Out of sync with App roles ({roleApplications.join(", ")})</span>
          ) : roleApplications.length > 0 ? (
            <span className="muted" style={{ fontSize: 12 }}>Aligned with App roles</span>
          ) : null}
        </div>
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
          {(section === "blueprints" || section === "apps") && <AppsPanel />}
          {section === "app-roles" && <AppRolesPanel />}
          {section === "sizes" && <SizesPanel />}
          {section === "hostname" && <HostnamePanel />}
          {section === "workflows" && <WorkflowsPanel />}
        </div>
      </div>
    </div>
  );
}


