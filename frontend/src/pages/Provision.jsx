import { useEffect, useMemo, useState } from "react";
import {
  getVmTemplates, getContainerTemplates, getStacks, getEnvironments, getTemplateDefaults,
  getCostRates, getPackages,
  provisionVm, provisionInternal, provisionContainer, provisionStack,
  getIacTemplate,
} from "../api/client.js";
import { useDialog } from "../components/DialogProvider.jsx";
import { useToast } from "../components/ToastProvider.jsx";
import { IconDownload } from "../components/icons.jsx";
import ProvisionForm, {
  DEFAULT_COST_RATES,
  KIND_LABELS,
  FALLBACK_PACKAGE_IDS,
  buildPackageCategories,
} from "../components/ProvisionForm.jsx";
import EmptyState from "../components/EmptyState.jsx";
import ProviderStatusBanner from "../components/ProviderStatusBanner.jsx";
import useProviderHealth from "../hooks/useProviderHealth.js";
import { TemplateLogoMark, resolveTemplateLogo } from "../lib/templateLogos.jsx";

const IAC_TOOL_OPTIONS = [
  { id: "terraform", label: "Terraform" },
  { id: "ansible", label: "Ansible" },
  { id: "pulumi", label: "Pulumi (TypeScript)" },
  { id: "curl", label: "REST (cURL)" },
];

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

  return (
    <div className="iac-export-card" onClick={(e) => e.stopPropagation()}>
      <span className="iac-export-card-label">Use with IaC</span>
      <div className="iac-export-card-row">
        <select
          className="control-select iac-export-select"
          value={tool}
          onChange={(e) => setTool(e.target.value)}
          aria-label="IaC tool"
        >
          {IAC_TOOL_OPTIONS.map((t) => (
            <option key={t.id} value={t.id}>{t.label}</option>
          ))}
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
    </div>
  );
}

const CATEGORY_META = {
  stack: { label: "Stacks", short: "Stack" },
  vm: { label: "Templates", short: "Virtual Machine" },
  container: { label: "Containers", short: "Container" },
};
const CATEGORY_ORDER = ["vm", "stack"];

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
  const { info, warn, error: toastError } = useToast();
  const proxmox = useProviderHealth("proxmox");
  const [vmTemplates, setVmTemplates] = useState([]);
  const [containerTemplates, setContainerTemplates] = useState([]);
  const [stacks, setStacks] = useState([]);
  const [environments, setEnvironments] = useState([]);
  const [templateDefaults, setTemplateDefaults] = useState({});
  const [costRates, setCostRates] = useState(DEFAULT_COST_RATES);
  const [packageCategories, setPackageCategories] = useState(() => buildPackageCategories());
  const [packageLabels, setPackageLabels] = useState({});
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
    if (proxmox.blocked) return;
    const key = tplKey(row.kind, row.item.id);
    setRecent((prev) => {
      const next = [key, ...prev.filter((k) => k !== key)];
      writeJsonList(RECENT_KEY, next);
      return next;
    });
    setSelected(row);
  };

  useEffect(() => {
    if (proxmox.blocked && selected) setSelected(null);
  }, [proxmox.blocked, selected]);

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
        setPackageCategories(
          normalized.length
            ? buildPackageCategories(normalized)
            : buildPackageCategories(FALLBACK_PACKAGE_IDS),
        );
        const labels = {};
        for (const p of normalized) {
          if (!p?.id) continue;
          labels[p.id] = { name: p.name || p.id, description: p.description || "" };
        }
        setPackageLabels(labels);
        setLockedPackageIds(normalized.filter((p) => p.isDefault).map((p) => p.id));
      })
      .catch(() => {
        setPackageCategories(buildPackageCategories());
        setPackageLabels({});
        setLockedPackageIds([]);
      });
  }, []);

  // This page covers VMs & stacks — Kubernetes create lives under Provisioning → Kubernetes.
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
          diskMounts: form.diskMounts,
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
        info("Provisioning started", "Follow live progress in the deployment monitor.", {
          actions: [{ key: "view", label: "Open deployments", href: `/deployments?tab=running&job=${encodeURIComponent(result.job.id)}` }],
        });
        window.dispatchEvent(new CustomEvent("forge:open-deployment-monitor", { detail: { jobId: result.job.id } }));
      } else if (result?.request?.id) {
        // High-config request paused for approval — pop the monitor so the user
        // sees it on hold until an admin approves it.
        setRequestNotice(`Request ${result.request.id} exceeds the size policy — it's on hold in the deployment monitor awaiting admin approval.`);
        warn("Awaiting approval", `Request ${result.request.id} exceeds the size policy and is on hold.`);
        window.dispatchEvent(new CustomEvent("forge:open-deployment-monitor", { detail: { requestId: result.request.id } }));
      }
    } catch (e) {
      const msg = e.response?.data?.error || e.message;
      toastError("Provisioning failed", msg);
      alert({ title: "Provisioning failed", message: msg, tone: "danger" });
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
    <div className={embedded ? "provision-catalog" : "page provision-catalog"}>
      {!embedded && (
        <div className="page-head">
          <div className="eyebrow">Catalog</div>
          <h1>Virtual machines &amp; stacks</h1>
          <p>Pick a template to configure and launch — or download an IaC file to provision it from your own tool.</p>
        </div>
      )}

      <ProviderStatusBanner
        providerLabel="Proxmox"
        checking={proxmox.checking}
        blocked={proxmox.blocked}
        message={proxmox.message}
        error={proxmox.error}
        onRetry={proxmox.refresh}
      />

      <div className={`tpl-toolbar ${proxmox.blocked ? "is-disabled" : ""}`}>
        <div className="tpl-search-wrap">
          <span className="tpl-search-icon" aria-hidden="true">⌕</span>
          <input
            className="control-input tpl-search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by name, id, or description…"
            aria-label="Search catalog"
          />
        </div>
        <div className="tpl-filters" role="group" aria-label="Filter by category">
          <button
            type="button"
            className={`tpl-filter ${kindFilter === "all" ? "active" : ""}`}
            aria-pressed={kindFilter === "all"}
            onClick={() => setKindFilter("all")}
          >
            All <span className="tpl-filter-n">{rows.length}</span>
          </button>
          {CATEGORY_ORDER.map((cat) => (
            <button
              key={cat}
              type="button"
              className={`tpl-filter ${kindFilter === cat ? "active" : ""}`}
              aria-pressed={kindFilter === cat}
              onClick={() => setKindFilter((cur) => (cur === cat ? "all" : cat))}
            >
              {CATEGORY_META[cat].label} <span className="tpl-filter-n">{categoryCounts[cat]}</span>
            </button>
          ))}
        </div>
      </div>

      {(favoriteRows.length > 0 || recentRows.length > 0) && (
        <div className="tpl-pins">
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
                    disabled={proxmox.blocked}
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
                    disabled={proxmox.blocked}
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
      ) : filteredRows.length === 0 ? (
        <EmptyState
          icon="⌕"
          title="No matches"
          description="Nothing in the catalog matches your search or filters. Clear filters to see all templates."
          actionLabel="Clear filters"
          onAction={() => { setQuery(""); setKindFilter("all"); }}
        />
      ) : (
        <div className={`tpl-grid tpl-grid-v2 ${proxmox.blocked ? "is-disabled" : ""}`}>
          {filteredRows.map((row) => {
            const category = categoryOf(row);
            const isSelected = selected && selected.kind === row.kind && selected.item.id === row.item.id;
            const key = tplKey(row.kind, row.item.id);
            const isFav = favorites.includes(key);
            const logo = resolveTemplateLogo({
              name: row.item.name,
              id: row.item.id,
              kind: category === "stack" ? "stack" : row.kind,
            });
            return (
              <article
                key={key}
                className={`tpl-card tpl-card-v2 tpl-tone-${logo.tone} ${isSelected ? "tpl-card-active" : ""} ${proxmox.blocked ? "tpl-card-disabled" : ""}`}
                style={{ "--tpl-accent": logo.accent }}
              >
                <button
                  type="button"
                  className={`tpl-fav-btn ${isFav ? "on" : ""}`}
                  title={isFav ? "Remove from favorites" : "Add to favorites"}
                  aria-label={isFav ? "Remove from favorites" : "Add to favorites"}
                  onClick={(e) => toggleFavorite(row, e)}
                >
                  {isFav ? "★" : "☆"}
                </button>

                <div className="tpl-card-logo-wrap">
                  <TemplateLogoMark
                    name={row.item.name}
                    id={row.item.id}
                    kind={category === "stack" ? "stack" : row.kind}
                  />
                </div>

                <h3 className="tpl-card-name">{row.item.name}</h3>
                <div className="tpl-card-kind">
                  <span className="tpl-card-kind-dot" aria-hidden="true" />
                  <span>{CATEGORY_META[category]?.short || KIND_LABELS[row.kind]}</span>
                  {row.item.provider === "internal" && <span className="tpl-card-kind-extra">Internal</span>}
                </div>

                {!!row.item.description && (
                  <p className="tpl-card-desc">{row.item.description}</p>
                )}

                <div className="tpl-card-foot-v2">
                  <IacExport kind={row.kind} id={row.item.id} />
                  <button
                    type="button"
                    className="btn btn-primary tpl-card-cta"
                    onClick={() => openTemplate(row)}
                    disabled={proxmox.blocked}
                    title={proxmox.blocked ? proxmox.message : undefined}
                  >
                    Provision
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      )}

      {selected && (
        <div className="provision-modal-backdrop">
          <div className="provision-modal-shell">
            <ProvisionForm
              selected={selected}
              environments={environments}
              templateDefaults={templateDefaults}
              costRates={costRates}
              packageCategories={packageCategories}
              packageLabels={packageLabels}
              lockedPackageIds={lockedPackageIds}
              busy={busy}
              onSubmit={submit}
              onClose={() => setSelected(null)}
            />
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
