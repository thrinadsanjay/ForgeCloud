import { useEffect, useMemo, useState } from "react";
import {
  adminListPackages,
  adminUpsertPackage,
  adminDeletePackage,
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

const SECTIONS = [
  {
    id: "packages",
    label: "Packages",
    icon: "📦",
    title: "Software packages",
    summary: "What users can pick at provision time. Mark org-standard items as Default — they stay checked and cannot be removed.",
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
  const [isDefault, setIsDefault] = useState(false);
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const load = () => adminListPackages().then(setRows).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) =>
      r.id.toLowerCase().includes(q)
      || (r.name || "").toLowerCase().includes(q)
      || (r.installPkg || "").toLowerCase().includes(q),
    );
  }, [rows, query]);

  const defaultCount = rows.filter((r) => r.isDefault && r.enabled).length;

  const add = async (e) => {
    e?.preventDefault();
    setError("");
    setBusy(true);
    try {
      await adminUpsertPackage({
        id: id.trim(),
        name: name.trim() || id.trim(),
        installPkg: installPkg.trim() || null,
        isDefault,
        enabled: true,
        sortOrder: rows.length,
      });
      setId("");
      setName("");
      setInstallPkg("");
      setIsDefault(false);
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
    <div className="catalog-panel-stack">
      <div className="catalog-intro card card-pad">
        <div className="catalog-intro-head">
          <span className="catalog-intro-icon" aria-hidden="true">{section.icon}</span>
          <div>
            <h2>{section.title}</h2>
            <p className="muted">{section.summary}</p>
          </div>
        </div>
        <ul className="catalog-tips">
          <li>Standard packages install at <strong>first boot via cloud-init</strong> (Forge auto-uploads a snippet — no manual YAML per VM).</li>
          <li>Use <strong>Install as</strong> when the apt/yum name differs from the ID.</li>
          <li>Packages with a custom <strong>install command</strong> still use SSH after boot (for vendor repos / agents).</li>
        </ul>
      </div>

      <div className="catalog-stats">
        <div className="catalog-stat"><span className="catalog-stat-n">{rows.length}</span><span className="catalog-stat-l">Total</span></div>
        <div className="catalog-stat"><span className="catalog-stat-n">{defaultCount}</span><span className="catalog-stat-l">Default (locked)</span></div>
        <div className="catalog-stat"><span className="catalog-stat-n">{rows.filter((r) => r.enabled).length}</span><span className="catalog-stat-l">Enabled</span></div>
      </div>

      <div className="card card-pad">
        <h3 className="catalog-compact-title">Add package</h3>
        {error && <div className="login-error">{error}</div>}
        <form className="catalog-inline-form" onSubmit={add}>
          <input className="control-input catalog-inline-input" placeholder="ID e.g. docker" value={id} onChange={(e) => setId(e.target.value)} aria-label="Package ID" />
          <input className="control-input catalog-inline-input" placeholder="Display name" value={name} onChange={(e) => setName(e.target.value)} aria-label="Display name" />
          <input className="control-input catalog-inline-input" placeholder="Install as (optional)" value={installPkg} onChange={(e) => setInstallPkg(e.target.value)} aria-label="Install package name" />
          <label className="catalog-inline-check">
            <input type="checkbox" checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)} />
            Default
          </label>
          <button className="btn btn-primary catalog-inline-btn" type="submit" disabled={busy || !id.trim()}>
            {busy ? "…" : "Add"}
          </button>
        </form>
      </div>

      <div className="card card-pad">
        <div className="catalog-list-head">
          <h3 className="catalog-compact-title">Package list</h3>
          <input className="control-input catalog-search" placeholder="Search…" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search packages" />
        </div>
        {filtered.length === 0 ? (
          <div className="catalog-empty muted">{rows.length ? "No matches." : "No packages yet."}</div>
        ) : (
          <div className="catalog-pkg-table">
            <div className="catalog-pkg-head">
              <span>Package</span>
              <span>Install as</span>
              <span>Default</span>
              <span>Status</span>
              <span />
            </div>
            {filtered.map((r) => (
              <div key={r.id} className={`catalog-pkg-row ${r.enabled ? "" : "catalog-row-off"}`}>
                <div className="catalog-pkg-cell">
                  <code className="catalog-row-id">{r.id}</code>
                  <span className="catalog-row-name">{r.name}</span>
                </div>
                <code className="catalog-pkg-install">{r.installPkg || r.id}</code>
                <button type="button" className={`catalog-toggle ${r.isDefault ? "on" : ""}`} onClick={() => toggleDefault(r)}>
                  {r.isDefault ? "Default" : "Optional"}
                </button>
                <button type="button" className={`catalog-toggle ${r.enabled ? "on" : ""}`} onClick={() => toggleEnabled(r)}>
                  {r.enabled ? "On" : "Off"}
                </button>
                <button type="button" className="btn btn-ghost catalog-delete" onClick={() => remove(r.id)}>Remove</button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function SizesPanel({ section }) {
  const { confirm } = useDialog();
  const [rows, setRows] = useState([]);
  const [key, setKey] = useState("");
  const [label, setLabel] = useState("");
  const [cpu, setCpu] = useState(2);
  const [memoryGB, setMemoryGB] = useState(4);
  const [query, setQuery] = useState("");
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

  return (
    <div className="catalog-panel-stack">
      <div className="catalog-intro card card-pad">
        <div className="catalog-intro-head">
          <span className="catalog-intro-icon" aria-hidden="true">{section.icon}</span>
          <div>
            <h2>{section.title}</h2>
            <p className="muted">{section.summary}</p>
          </div>
        </div>
        <ul className="catalog-tips">
          <li>Each size sets <strong>CPU cores</strong> and <strong>RAM (GB)</strong>. Disk is still chosen separately at provision time.</li>
          <li>Users pick a size in both the catalog form and Forge Assist chat; a <strong>Custom</strong> option always stays available for exact numbers.</li>
        </ul>
      </div>

      <div className="catalog-stats">
        <div className="catalog-stat"><span className="catalog-stat-n">{rows.length}</span><span className="catalog-stat-l">Total</span></div>
        <div className="catalog-stat"><span className="catalog-stat-n">{rows.filter((r) => r.enabled).length}</span><span className="catalog-stat-l">Enabled</span></div>
        <div className="catalog-stat"><span className="catalog-stat-n">{rows.reduce((n, r) => n + (Number(r.cpu) || 0), 0)}</span><span className="catalog-stat-l">CPU cores (sum)</span></div>
        <div className="catalog-stat"><span className="catalog-stat-n">{rows.reduce((n, r) => n + (Number(r.memoryGB) || 0), 0)}</span><span className="catalog-stat-l">RAM GB (sum)</span></div>
      </div>

      <div className="card card-pad">
        <h3 className="catalog-compact-title">Add size</h3>
        {error && <div className="login-error">{error}</div>}
        <form className="catalog-inline-form" onSubmit={add}>
          <input className="control-input catalog-inline-input" placeholder="Key e.g. small" value={key} onChange={(e) => setKey(e.target.value)} aria-label="Size key" />
          <input className="control-input catalog-inline-input" placeholder="Label e.g. Small" value={label} onChange={(e) => setLabel(e.target.value)} aria-label="Size label" />
          <input className="control-input catalog-inline-input" type="number" min="1" max="128" placeholder="CPU" value={cpu} onChange={(e) => setCpu(e.target.value)} aria-label="CPU cores" />
          <input className="control-input catalog-inline-input" type="number" min="1" max="1024" placeholder="RAM GB" value={memoryGB} onChange={(e) => setMemoryGB(e.target.value)} aria-label="RAM in GB" />
          <button className="btn btn-primary catalog-inline-btn" type="submit" disabled={busy || !key.trim()}>
            {busy ? "…" : "Add"}
          </button>
        </form>
      </div>

      <div className="card card-pad">
        <div className="catalog-list-head">
          <h3 className="catalog-compact-title">Size list</h3>
          <input className="control-input catalog-search" placeholder="Search…" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search sizes" />
        </div>
        {filtered.length === 0 ? (
          <div className="catalog-empty muted">{rows.length ? "No matches." : "No sizes yet."}</div>
        ) : (
          <div className="catalog-pkg-table">
            <div className="catalog-pkg-head">
              <span>Size</span>
              <span>CPU</span>
              <span>RAM (GB)</span>
              <span>Status</span>
              <span />
            </div>
            {filtered.map((r) => (
              <div key={r.key} className={`catalog-pkg-row ${r.enabled ? "" : "catalog-row-off"}`}>
                <div className="catalog-pkg-cell">
                  <code className="catalog-row-id">{r.key}</code>
                  <span className="catalog-row-name">{r.label}</span>
                </div>
                <input
                  className="control-input catalog-size-num"
                  type="number"
                  min="1"
                  max="128"
                  defaultValue={r.cpu}
                  onBlur={(e) => updateField(r, "cpu", e.target.value)}
                  aria-label={`${r.label} CPU cores`}
                />
                <input
                  className="control-input catalog-size-num"
                  type="number"
                  min="1"
                  max="1024"
                  defaultValue={r.memoryGB}
                  onBlur={(e) => updateField(r, "memoryGB", e.target.value)}
                  aria-label={`${r.label} RAM in GB`}
                />
                <button type="button" className={`catalog-toggle ${r.enabled ? "on" : ""}`} onClick={() => toggleEnabled(r)}>
                  {r.enabled ? "On" : "Off"}
                </button>
                <button type="button" className="btn btn-ghost catalog-delete" onClick={() => remove(r.key)}>Remove</button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function HostnamePanel({ section }) {
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
    <div className="catalog-panel-stack">
      <div className="catalog-intro card card-pad">
        <div className="catalog-intro-head">
          <span className="catalog-intro-icon" aria-hidden="true">{section.icon}</span>
          <div>
            <h2>{section.title}</h2>
            <p className="muted">{section.summary}</p>
          </div>
        </div>
        <ul className="catalog-tips">
          <li>Used when chat invents a hostname, and auto-filled when a template is selected on Provision.</li>
          <li>Include <code>{"{app}"}</code> for the application role (web, db, docker, …).</li>
          <li>Tokens are replaced at suggestion time. Sequential <code>{"{n}"}</code> values increment globally.</li>
        </ul>
      </div>

      <div className="card card-pad">
        <h3 className="catalog-compact-title">Format pattern</h3>
        {error && <div className="login-error">{error}</div>}
        <form className="catalog-inline-form" onSubmit={save} style={{ flexWrap: "wrap" }}>
          <input
            className="control-input catalog-inline-input"
            style={{ flex: "1 1 240px", fontFamily: "var(--mono, ui-monospace, monospace)" }}
            value={format}
            onChange={(e) => { setFormat(e.target.value); setSaved(false); }}
            placeholder={defaultFormat}
            aria-label="Hostname format"
          />
          <button
            className="btn btn-ghost catalog-inline-btn"
            type="button"
            onClick={() => {
              setFormat(defaultFormat);
              setApplicationsText(defaultApplications);
              setSaved(false);
            }}
          >
            Reset
          </button>
          <button className="btn btn-primary catalog-inline-btn" type="submit" disabled={busy || !format.trim()}>
            {busy ? "Saving…" : "Save"}
          </button>
        </form>
        <div className="muted" style={{ marginTop: 10, fontSize: 13 }}>
          Preview: <code className="catalog-row-id">{preview || "—"}</code>
          {saved && <span style={{ marginLeft: 10, color: "var(--ok)" }}>Saved</span>}
        </div>
      </div>

      <div className="card card-pad">
        <h3 className="catalog-compact-title">Application options</h3>
        <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
          Comma-separated list shown in the provision form. Used for the <code>{"{app}"}</code> token.
        </p>
        <input
          className="control-input"
          style={{ width: "100%", fontFamily: "var(--mono, ui-monospace, monospace)" }}
          value={applicationsText}
          onChange={(e) => { setApplicationsText(e.target.value); setSaved(false); }}
          placeholder={defaultApplications}
          aria-label="Hostname applications"
        />
      </div>

      <div className="card card-pad">
        <h3 className="catalog-compact-title">Available tokens</h3>
        <div className="catalog-pkg-table">
          <div className="catalog-pkg-head">
            <span>Token</span>
            <span>Meaning</span>
          </div>
          {tokens.map((t) => (
            <div key={t.token} className="catalog-pkg-row">
              <code className="catalog-row-id">{t.token}</code>
              <span className="catalog-row-name">{t.meaning}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function WorkflowsPanel({ section }) {
  const [rows, setRows] = useState([]);
  const [expanded, setExpanded] = useState(null);

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

  return (
    <div className="catalog-panel-stack">
      <div className="catalog-intro card card-pad">
        <div className="catalog-intro-head">
          <span className="catalog-intro-icon" aria-hidden="true">{section.icon}</span>
          <div>
            <h2>{section.title}</h2>
            <p className="muted">{section.summary}</p>
          </div>
        </div>
      </div>

      <div className="card card-pad catalog-api-hint">
        <h3 className="catalog-compact-title">API example</h3>
        <pre className="catalog-code">{`POST /api/admin/workflows`}</pre>
      </div>

      <div className="card card-pad">
        <h3 className="catalog-compact-title">Templates</h3>
        {rows.length === 0 ? (
          <div className="catalog-empty muted">No workflows defined.</div>
        ) : (
          <div className="catalog-workflow-list">
            {rows.map((r) => (
              <div key={r.id} className="catalog-workflow-card">
                <button type="button" className="catalog-workflow-head" onClick={() => setExpanded(expanded === r.id ? null : r.id)}>
                  <div>
                    <div className="catalog-workflow-name">{r.name}</div>
                    <div className="catalog-workflow-meta muted"><code>{r.id}</code> · {r.steps?.length || 0} steps</div>
                  </div>
                  <span className="catalog-workflow-caret">{expanded === r.id ? "▾" : "›"}</span>
                </button>
                {expanded === r.id && (
                  <div className="catalog-workflow-body">
                    {stages(r.steps).map(([stage, steps]) => (
                      <div key={stage} className="catalog-workflow-stage">
                        <div className="catalog-workflow-stage-label">{stage}</div>
                        <ol className="catalog-workflow-steps">
                          {steps.map((s) => <li key={s.id || s.key}>{s.label}</li>)}
                        </ol>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
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
          {section === "sizes" && <SizesPanel section={active} />}
          {section === "hostname" && <HostnamePanel section={active} />}
          {section === "workflows" && <WorkflowsPanel section={active} />}
        </div>
      </div>
    </div>
  );
}


