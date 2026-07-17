import { useEffect, useMemo, useState } from "react";
import {
  getVmTemplates, getContainerTemplates, getStacks, getEnvironments, getTemplateDefaults,
  getCostRates, getPackages,
  provisionVm, provisionInternal, provisionContainer, provisionStack,
  getIacTemplate,
} from "../api/client.js";
import { useDialog } from "../components/DialogProvider.jsx";
import { IconDownload } from "../components/icons.jsx";
import ProvisionForm, {
  DEFAULT_COST_RATES,
  KIND_LABELS,
  FALLBACK_PACKAGE_IDS,
  buildPackageCategories,
  defaultPackagesFor,
  pkgName,
} from "../components/ProvisionForm.jsx";
import EmptyState from "../components/EmptyState.jsx";

const IAC_TOOL_OPTIONS = [
  { id: "terraform", label: "Terraform" },
  { id: "ansible", label: "Ansible" },
  { id: "pulumi", label: "Pulumi (TypeScript)" },
  { id: "curl", label: "REST (cURL)" },
];

// Tool picker + download for a template's Infrastructure-as-Code file. The
// downloaded file targets the Forge API and authenticates with an API token
// (generated from the account menu).
function IacExport({ kind, id }) {
  const { alert } = useDialog();
  const [tool, setTool] = useState("terraform");
  const [busy, setBusy] = useState(false);

  const download = async () => {
    setBusy(true);
    try {
      const file = await getIacTemplate({ kind, id, tool });
      const blob = new Blob([file.content], { type: "text/plain;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = file.filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      alert({ title: "Download failed", message: e.response?.data?.error || e.message, tone: "danger" });
    } finally {
      setBusy(false);
    }
  };

  // Stop clicks bubbling to the row (which would open the config modal).
  return (
    <div className="iac-export-inline" onClick={(e) => e.stopPropagation()}>
      <span className="iac-export-inline-label">Use with IaC:</span>
      <select className="control-select iac-export-select" value={tool} onChange={(e) => setTool(e.target.value)} aria-label="IaC tool">
        {IAC_TOOL_OPTIONS.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
      </select>
      <button
        type="button"
        className="icon-btn iac-export-download"
        onClick={download}
        disabled={busy}
        title="Download IaC file"
        aria-label="Download IaC file"
      >
        {busy ? <span className="spinner" style={{ width: 14, height: 14 }} /> : <IconDownload />}
      </button>
    </div>
  );
}

// Catalog categories used to group the list. A stack is anything whose kind is
// "stack" OR whose template name contains "stack" (e.g. "LAMP Stack"), so
// stack-like templates are grouped with real stacks.
const CATEGORY_META = {
  stack: { label: "Stacks", icon: "🧩" },
  vm: { label: "Virtual machines", icon: "🖥" },
  container: { label: "Containers", icon: "📦" },
};
const CATEGORY_ORDER = ["stack", "vm"];

const FAV_KEY = "forge.provision.favorites";
const RECENT_KEY = "forge.provision.recent";

function tplKey(kind, id) {
  return `${kind}:${id}`;
}

function readJsonList(key) {
  try {
    const raw = JSON.parse(localStorage.getItem(key) || "[]");
    return Array.isArray(raw) ? raw.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function writeJsonList(key, list) {
  try {
    localStorage.setItem(key, JSON.stringify(list.slice(0, 24)));
  } catch { /* ignore quota */ }
}

function categoryOf(row) {
  if (row.kind === "stack") return "stack";
  if (/\bstack\b/i.test(row.item?.name || "")) return "stack";
  return row.kind; // "vm" | "container"
}

export default function Provision({ embedded = false }) {
  const { alert } = useDialog();
  const [vmTemplates, setVmTemplates] = useState([]);
  const [containerTemplates, setContainerTemplates] = useState([]);
  const [stacks, setStacks] = useState([]);
  const [environments, setEnvironments] = useState([]);
  const [templateDefaults, setTemplateDefaults] = useState({});
  const [costRates, setCostRates] = useState(DEFAULT_COST_RATES);
  const [packageCategories, setPackageCategories] = useState(() => buildPackageCategories());
  const [lockedPackageIds, setLockedPackageIds] = useState([]);
  const [kindFilter, setKindFilter] = useState("all");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(null);
  const [requestNotice, setRequestNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [favorites, setFavorites] = useState(() => readJsonList(FAV_KEY));
  const [recent, setRecent] = useState(() => readJsonList(RECENT_KEY));

  const toggleFavorite = (row, e) => {
    e?.stopPropagation?.();
    const key = tplKey(row.kind, row.item.id);
    setFavorites((prev) => {
      const next = prev.includes(key) ? prev.filter((k) => k !== key) : [key, ...prev];
      writeJsonList(FAV_KEY, next);
      return next;
    });
  };

  const openTemplate = (row) => {
    const key = tplKey(row.kind, row.item.id);
    setRecent((prev) => {
      const next = [key, ...prev.filter((k) => k !== key)];
      writeJsonList(RECENT_KEY, next);
      return next;
    });
    setSelected(row);
  };

  useEffect(() => {
    getVmTemplates().then(setVmTemplates).catch(() => {});
    getContainerTemplates().then(setContainerTemplates).catch(() => {});
    getStacks().then(setStacks).catch(() => {});
    getEnvironments().then(setEnvironments).catch(() => {});
    getTemplateDefaults().then(setTemplateDefaults).catch(() => {});
    getCostRates().then(setCostRates).catch(() => {});
    getPackages()
      .then((data) => {
        const list = Array.isArray(data) ? data : [];
        const normalized = list.map((p) => (typeof p === "string" ? { id: p, isDefault: false } : p));
        const ids = normalized.map((p) => p.id);
        setPackageCategories(buildPackageCategories(ids.length ? ids : FALLBACK_PACKAGE_IDS));
        setLockedPackageIds(normalized.filter((p) => p.isDefault).map((p) => p.id));
      })
      .catch(() => {
        setPackageCategories(buildPackageCategories());
        setLockedPackageIds([]);
      });
  }, []);

  // This page covers VMs & stacks only — containers have their own hosting page.
  const rows = useMemo(() => {
    const vmRows = vmTemplates.map((item) => ({ kind: "vm", item }));
    const stackRows = stacks.map((item) => ({ kind: "stack", item }));
    return [...vmRows, ...stackRows];
  }, [vmTemplates, stacks]);

  const filteredRows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows
      .filter((row) => kindFilter === "all" || categoryOf(row) === kindFilter)
      .filter((row) => {
        if (!q) return true;
        return (row.item.name || "").toLowerCase().includes(q)
          || (row.item.id || "").toLowerCase().includes(q)
          || (row.item.description || "").toLowerCase().includes(q);
      })
      .sort((a, b) => (a.item.name || "").localeCompare(b.item.name || ""));
  }, [rows, kindFilter, query]);

  // Count catalog entries per category (for the filter chips).
  const categoryCounts = useMemo(() => {
    const counts = { stack: 0, vm: 0, container: 0 };
    rows.forEach((row) => { counts[categoryOf(row)] += 1; });
    return counts;
  }, [rows]);

  // Group the filtered rows into category sections, in a stable order.
  const groupedRows = useMemo(() => {
    const groups = new Map();
    for (const row of filteredRows) {
      const cat = categoryOf(row);
      if (!groups.has(cat)) groups.set(cat, []);
      groups.get(cat).push(row);
    }
    return CATEGORY_ORDER
      .filter((cat) => groups.has(cat))
      .map((cat) => ({ category: cat, rows: groups.get(cat) }));
  }, [filteredRows]);

  useEffect(() => {
    if (!selected) return;
    const stillExists = rows.some((row) => row.kind === selected.kind && row.item.id === selected.item.id);
    if (!stillExists) setSelected(null);
  }, [rows, selected]);

  useEffect(() => {
    const prevOverflow = document.body.style.overflow;
    if (selected) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = prevOverflow || "";
    }
    return () => {
      document.body.style.overflow = prevOverflow || "";
    };
  }, [selected]);

  const submit = async (form) => {
    if (!selected) return;
    setBusy(true);
    try {
      let result;
      if (selected.item.provider === "internal") {
        result = await provisionInternal({
          templateId: selected.item.id,
          hostname: form.hostname,
          application: form.application,
          cpu: form.cpu,
          memoryGB: form.memoryGB,
          additionalDiskGB: form.additionalDiskGB,
          ttlDays: form.ttlDays,
          permanent: form.permanent,
        });
      } else if (selected.kind === "vm") {
        result = await provisionVm({ templateId: selected.item.id, ...form });
      } else if (selected.kind === "container") {
        result = await provisionContainer({ templateId: selected.item.id, ...form });
      } else {
        result = await provisionStack({
          stackId: selected.item.id,
          hostnamePrefix: form.hostname,
          application: form.application,
          cpu: form.cpu,
          memoryGB: form.memoryGB,
          additionalDiskGB: form.additionalDiskGB,
          ttlDays: form.ttlDays,
          permanent: form.permanent,
          packages: form.packages,
          packageSelection: form.packageSelection,
        });
      }

      setSelected(null);

      // A deployment was created — pop open the floating deployment monitor
      // (maximized) so the user watches live progress without leaving the page.
      // Requests that still need approval have no job yet, so fall back to a
      // notice.
      if (result?.job?.id) {
        setRequestNotice("Provisioning started — follow the live progress in the deployment monitor.");
        window.dispatchEvent(new CustomEvent("forge:open-deployment-monitor", { detail: { jobId: result.job.id } }));
      } else if (result?.request?.id) {
        // High-config request paused for approval — pop the monitor so the user
        // sees it on hold until an admin approves it.
        setRequestNotice(`Request ${result.request.id} exceeds the size policy — it's on hold in the deployment monitor awaiting admin approval.`);
        window.dispatchEvent(new CustomEvent("forge:open-deployment-monitor", { detail: { requestId: result.request.id } }));
      }
    } catch (e) {
      alert({ title: "Provisioning failed", message: e.response?.data?.error || e.message, tone: "danger" });
    } finally {
      setBusy(false);
    }
  };

  const favoriteRows = useMemo(() => {
    const map = new Map(rows.map((r) => [tplKey(r.kind, r.item.id), r]));
    return favorites.map((k) => map.get(k)).filter(Boolean);
  }, [rows, favorites]);

  const recentRows = useMemo(() => {
    const map = new Map(rows.map((r) => [tplKey(r.kind, r.item.id), r]));
    return recent.map((k) => map.get(k)).filter(Boolean).slice(0, 6);
  }, [rows, recent]);

  return (
    <div className={embedded ? "" : "page"}>
      <div className="page-head">
        <div className="eyebrow">Catalog</div>
        <h1>Virtual machines &amp; stacks</h1>
        <p>Pick a template to configure and launch — or download an IaC file to provision it from your own tool.</p>
      </div>

      <div className="tpl-toolbar toolbar-panel">
        <input
          className="control-input tpl-search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by name, id, or description…"
          aria-label="Search catalog"
        />
        <div className="tpl-filters" role="group" aria-label="Filter by category">
          <button
            type="button"
            className={`tpl-filter ${kindFilter === "all" ? "active" : ""}`}
            aria-pressed={kindFilter === "all"}
            onClick={() => setKindFilter("all")}
          >All <span className="tpl-filter-n">{rows.length}</span></button>
          {CATEGORY_ORDER.map((cat) => (
            <button
              key={cat}
              type="button"
              className={`tpl-filter ${kindFilter === cat ? "active" : ""}`}
              aria-pressed={kindFilter === cat}
              onClick={() => setKindFilter((cur) => (cur === cat ? "all" : cat))}
            ><span aria-hidden="true">{CATEGORY_META[cat].icon}</span> {CATEGORY_META[cat].label} <span className="tpl-filter-n">{categoryCounts[cat]}</span></button>
          ))}
        </div>
      </div>

      {(favoriteRows.length > 0 || recentRows.length > 0) && (
        <div className="tpl-pins" style={{ marginBottom: 16 }}>
          {favoriteRows.length > 0 && (
            <div className="tpl-pin-row">
              <span className="tpl-pin-label">Favorites</span>
              <div className="tpl-pin-chips">
                {favoriteRows.map((row) => (
                  <button
                    key={`fav-${row.kind}-${row.item.id}`}
                    type="button"
                    className="tpl-pin-chip"
                    onClick={() => openTemplate(row)}
                  >
                    ★ {row.item.name}
                  </button>
                ))}
              </div>
            </div>
          )}
          {recentRows.length > 0 && (
            <div className="tpl-pin-row">
              <span className="tpl-pin-label">Recent</span>
              <div className="tpl-pin-chips">
                {recentRows.map((row) => (
                  <button
                    key={`rec-${row.kind}-${row.item.id}`}
                    type="button"
                    className="tpl-pin-chip muted"
                    onClick={() => openTemplate(row)}
                  >
                    {row.item.name}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {rows.length === 0 ? (
        <EmptyState
          icon="🖥"
          title="No templates mapped yet"
          description="An admin needs to map a Proxmox template (and optional stacks) under Admin → Mappings before you can provision."
          actionLabel="Open Mappings"
          actionHref="/admin?tab=mappings"
        />
      ) : groupedRows.length === 0 ? (
        <EmptyState
          icon="⌕"
          title="No matches"
          description="Nothing in the catalog matches your search or filters. Clear filters to see all templates."
          actionLabel="Clear filters"
          onAction={() => { setQuery(""); setKindFilter("all"); }}
        />
      ) : (
        groupedRows.map(({ category, rows: catRows }) => (
          <section key={category} className="tpl-section">
            <div className="tpl-section-head">
              <span className="tpl-section-icon" aria-hidden="true">{CATEGORY_META[category].icon}</span>
              <h2 className="tpl-section-title">{CATEGORY_META[category].label}</h2>
              <span className="tpl-section-count">{catRows.length}</span>
            </div>

            <div className="tpl-grid">
              {catRows.map((row) => {
                const isSelected = selected && selected.kind === row.kind && selected.item.id === row.item.id;
                const defs = defaultPackagesFor(row.item, templateDefaults);
                const key = tplKey(row.kind, row.item.id);
                const isFav = favorites.includes(key);
                return (
                  <div
                    key={key}
                    className={`tpl-card ${isSelected ? "tpl-card-active" : ""}`}
                    onClick={() => openTemplate(row)}
                    role="button"
                    tabIndex={0}
                    aria-label={`Configure ${row.item.name}`}
                    onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openTemplate(row); } }}
                  >
                    <div className="tpl-card-head">
                      <span className="tpl-card-icon" aria-hidden="true">{CATEGORY_META[category].icon}</span>
                      <div className="tpl-card-titles">
                        <div className="tpl-card-name">{row.item.name}</div>
                        <div className="tpl-card-tags">
                          <span className="badge provision-kind-badge">{KIND_LABELS[row.kind]}</span>
                          {row.item.provider === "internal" && <span className="provision-inline-kind">Internal workflow</span>}
                        </div>
                      </div>
                      <button
                        type="button"
                        className={`tpl-fav-btn ${isFav ? "on" : ""}`}
                        title={isFav ? "Remove from favorites" : "Add to favorites"}
                        aria-label={isFav ? "Remove from favorites" : "Add to favorites"}
                        onClick={(e) => toggleFavorite(row, e)}
                      >
                        {isFav ? "★" : "☆"}
                      </button>
                    </div>

                    {!!row.item.description && <p className="tpl-card-desc">{row.item.description}</p>}

                    {defs.length > 0 && (
                      <div className="tpl-card-defaults">
                        <span className="provision-row-defaults-label">Includes by default</span>
                        <div className="tpl-card-chips">
                          {defs.map((p, i) => (
                            <span key={`${pkgName(p)}-${i}`} className="provision-inline-kind provision-inline-kind-fixed">{pkgName(p)}</span>
                          ))}
                        </div>
                      </div>
                    )}

                    <div className="tpl-card-foot" onClick={(e) => e.stopPropagation()}>
                      <IacExport kind={row.kind} id={row.item.id} />
                      <button type="button" className="btn btn-primary btn-sm tpl-card-cta" onClick={() => openTemplate(row)}>
                        Provision
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        ))
      )}

      {selected && (
        <div className="provision-modal-backdrop">
          <div className="provision-modal-shell">
            <ProvisionForm selected={selected} environments={environments} templateDefaults={templateDefaults} costRates={costRates} packageCategories={packageCategories} lockedPackageIds={lockedPackageIds} busy={busy} onSubmit={submit} onClose={() => setSelected(null)} />
          </div>
        </div>
      )}

      {requestNotice && (
        <div className="card card-pad" style={{ marginTop: 18 }}>
          <div className="section-title" style={{ marginTop: 0 }}>Provisioning started</div>
          <p className="muted" style={{ margin: 0 }}>{requestNotice}</p>
        </div>
      )}
    </div>
  );
}
