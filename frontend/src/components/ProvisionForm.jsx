import { useEffect, useMemo, useRef, useState } from "react";
import { getInstanceSizes, suggestHostname, previewCapacity, getApplicationRoles, getApps, previewApps, getMyQuotas } from "../api/client.js";
import applicationProfilesFallback from "../data/applicationProfiles.json";
import Toggle from "./Toggle.jsx";

function rolesFromFallbackJson() {
  return Object.entries(applicationProfilesFallback).map(([id, meta], i) => ({
    id,
    label: meta.label || id,
    selection: id === "db" ? "single" : (id === "docker" || id === "cache" || id === "queue" ? "bundle" : id === "app" ? "suggest" : "multi"),
    allowMultiOverride: id === "db",
    defaultOptionId: id === "db" ? "postgres" : null,
    options: Array.isArray(meta.packages) ? meta.packages : [],
    enabled: true,
    sortOrder: i,
  }));
}

/** Initial packages to apply when a role is selected. */
export function initialPackagesForRole(role, { allowMulti = false } = {}) {
  if (!role) return [];
  const opts = Array.isArray(role.options) ? role.options : [];
  if (role.selection === "bundle") return [...opts];
  if (role.selection === "suggest") return [...opts];
  if (role.selection === "single" && !allowMulti) {
    const def = role.defaultOptionId && opts.includes(role.defaultOptionId)
      ? role.defaultOptionId
      : null;
    return def ? [def] : [];
  }
  // multi, or single+allowMulti: nothing pre-checked (except optional default for multi)
  if (role.selection === "multi" && role.defaultOptionId && opts.includes(role.defaultOptionId)) {
    return [role.defaultOptionId];
  }
  return [];
}

// Sensible fallbacks so the estimate renders even before the rates load.
export const DEFAULT_COST_RATES = { perCpu: 1800, perGbRam: 85, perGbStorage: 12, currency: "INR" };

const CURRENCY_SYMBOLS = { INR: "₹", EUR: "€", USD: "$", GBP: "£" };

export function formatMoney(amount, currency = "INR") {
  const value = Number.isFinite(amount) ? amount : 0;
  if (currency === "INR") {
    return `₹${value.toLocaleString("en-IN", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
  }
  const symbol = CURRENCY_SYMBOLS[currency] || "";
  return `${symbol}${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** `/data/logs` → `lv_data_logs` (preview only; server is source of truth). */
function pathToLvPreview(mountPath) {
  const cleaned = String(mountPath || "")
    .trim()
    .replace(/^\/+/, "")
    .replace(/\/+/g, "_")
    .replace(/[^a-zA-Z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
  return cleaned ? `lv_${cleaned}` : "lv_data";
}

function newMountRow() {
  return { id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, path: "", sizeGB: 10 };
}

// Cost-estimate thresholds (per month, in INR): amber past the first, red past the second.
const COST_AMBER_AT = 8000;
const COST_RED_AT = 16000;

// Days-per-unit for the "Required for" lifetime dropdown.
const TTL_UNIT_DAYS = { days: 1, months: 30, years: 365 };

// Red asterisk marking a mandatory field.
function Req() {
  return <span className="req" aria-hidden="true"> *</span>;
}

// A template's default packages. Prefer the list the backend already attached
// to the template (so it always travels with it); otherwise fall back to a
// tolerant lookup in the defaults map (match name/id, case-insensitive, and
// forgiving of extra wording like "MERN Stack").
export function defaultPackagesFor(item, defaultsMap) {
  if (Array.isArray(item?.defaultPackages)) return item.defaultPackages;
  if (!item || !defaultsMap) return [];
  const cands = [item.name, item.id].filter(Boolean).map((k) => String(k).toLowerCase());
  const entry = Object.entries(defaultsMap).find(([k]) => {
    const key = k.toLowerCase();
    return cands.some((c) => c === key || c.includes(key) || key.includes(c));
  });
  return Array.isArray(entry?.[1]) ? entry[1] : [];
}

// Normalize a default-package entry to a display name (entries may be objects
// like { letter, name } or plain strings).
export function pkgName(p) {
  return typeof p === "string" ? p : (p?.name || p?.letter || "");
}

export const KIND_LABELS = {
  vm: "Virtual Machine",
  container: "Container",
  stack: "Stack",
};

// Group selectable packages for the picker. Known ids are bucketed; anything
// else from the API lands in "Other".
const PACKAGE_CATEGORY_DEFS = [
  { name: "Languages", items: ["dotnet-sdk", "go", "java", "nodejs", "openjdk", "php", "python", "ruby", "rust"] },
  { name: "Containers", items: ["docker", "docker-compose", "podman", "helm", "kubectl"] },
  { name: "Databases", items: ["mongodb", "mysql", "postgres", "redis", "mariadb"] },
  { name: "DevOps", items: ["ansible", "terraform", "git", "awscli", "curl", "jq", "htop", "vim", "wget"] },
  { name: "Monitoring", items: ["grafana", "prometheus", "telegraf"] },
  { name: "Networking", items: ["net-tools", "tcpdump", "nmap"] },
  { name: "Utilities", items: ["zip", "unzip", "tree", "tmux", "screen", "nano"] },
  { name: "Build tools", items: ["aqt", "maven", "yarn"] },
  { name: "Messaging", items: ["rabbitmq"] },
  { name: "Web & proxy", items: ["nginx"] },
];

/** Display-only enrichment for blueprint cards (does not change provisioning). */
const BLUEPRINT_UI = {
  docker: {
    mark: "Dk",
    tint: "#2496ed",
    components: ["Docker Engine", "Docker Compose v2", "Portainer"],
    eta: "5–8 min",
  },
  k3s: {
    mark: "K3",
    tint: "#326ce5",
    components: ["K3s", "Helm", "kubectl"],
    eta: "8–12 min",
  },
  "grafana-influx": {
    mark: "Gr",
    tint: "#f46800",
    components: ["Grafana", "InfluxDB", "Dashboards"],
    eta: "10–15 min",
  },
  "prometheus-stack": {
    mark: "Pr",
    tint: "#e6522c",
    components: ["Prometheus", "Grafana", "Alertmanager"],
    eta: "10–15 min",
  },
  lamp: {
    mark: "LP",
    tint: "#d54f28",
    components: ["Apache", "PHP", "MySQL"],
    eta: "6–10 min",
  },
  lemp: {
    mark: "LM",
    tint: "#009639",
    components: ["Nginx", "PHP-FPM", "MariaDB"],
    eta: "6–10 min",
  },
  jenkins: {
    mark: "Jk",
    tint: "#d33833",
    components: ["Jenkins", "Java", "Git"],
    eta: "10–15 min",
  },
  gitlab: {
    mark: "GL",
    tint: "#fc6d26",
    components: ["GitLab CE", "PostgreSQL", "Redis"],
    eta: "15–25 min",
  },
  "nginx-proxy": {
    mark: "Nx",
    tint: "#009639",
    components: ["Nginx", "Certbot", "SSL layout"],
    eta: "5–8 min",
  },
  elk: {
    mark: "EL",
    tint: "#00bfb3",
    components: ["Elasticsearch", "Logstash", "Kibana"],
    eta: "15–25 min",
  },
  "developer-essentials": {
    mark: "Dev",
    tint: "#5b6ee1",
    components: ["Git", "curl", "vim", "jq", "htop", "tmux"],
    eta: "3–5 min",
  },
  "docker-dev": {
    mark: "DD",
    tint: "#0db7ed",
    components: ["Docker", "Compose", "VS Code Server"],
    eta: "8–12 min",
  },
  grafana: {
    mark: "Gr",
    tint: "#f46800",
    components: ["Grafana", "Docker (auto)"],
    eta: "8–12 min",
  },
  influxdb: {
    mark: "In",
    tint: "#22adf6",
    components: ["InfluxDB", "Docker (auto)"],
    eta: "8–12 min",
  },
};

const WIZARD_STEPS = [
  { id: 1, label: "Configuration" },
  { id: 2, label: "Packages / Blueprints" },
  { id: 3, label: "Review & Launch" },
];

export const FALLBACK_PACKAGE_IDS = PACKAGE_CATEGORY_DEFS.flatMap((c) => c.items);

/** Build category groups from id list and/or package objects `{ id, category }`. */
export function buildPackageCategories(packageIdsOrRows = FALLBACK_PACKAGE_IDS) {
  const rows = Array.isArray(packageIdsOrRows) ? packageIdsOrRows : [];
  const asObjects = rows.length && typeof rows[0] === "object";
  if (asObjects) {
    const byCat = new Map();
    for (const p of rows) {
      const id = p.id || p;
      const cat = (p.category || "Uncategorized").trim() || "Uncategorized";
      if (!byCat.has(cat)) byCat.set(cat, []);
      byCat.get(cat).push(id);
    }
    const preferred = PACKAGE_CATEGORY_DEFS.map((c) => c.name);
    const groups = [];
    for (const name of preferred) {
      if (byCat.has(name)) {
        groups.push({ name, items: byCat.get(name) });
        byCat.delete(name);
      }
    }
    for (const [name, items] of byCat) {
      if (name !== "Uncategorized") groups.push({ name, items });
    }
    if (byCat.has("Uncategorized")) groups.push({ name: "Uncategorized", items: byCat.get("Uncategorized") });
    return groups.length ? groups : [{ name: "Packages", items: rows.map((p) => p.id) }];
  }

  const packageIds = rows;
  const available = new Set(packageIds);
  const used = new Set();
  const groups = PACKAGE_CATEGORY_DEFS.map((cat) => {
    const items = cat.items.filter((id) => available.has(id));
    items.forEach((id) => used.add(id));
    return { name: cat.name, items };
  }).filter((cat) => cat.items.length > 0);
  const other = packageIds.filter((id) => !used.has(id));
  if (other.length) groups.push({ name: "Other", items: other });
  return groups.length ? groups : [{ name: "Packages", items: [...packageIds] }];
}

// Match the current CPU/RAM to a defined size, or "custom" when nothing fits.
function matchSizeKey(sizes, cpu, memoryGB) {
  const hit = sizes.find((s) => s.cpu === Number(cpu) && s.memoryGB === Number(memoryGB));
  return hit ? hit.key : "custom";
}

// Always-visible package selector: a search box over a scrollable, category-
// grouped grid of clickable chips (click to toggle). Selected chips are
// highlighted and also listed in a summary strip so the choice stays visible
// while searching. The catalog area scrolls internally, so adding more packages
// never changes the form's height.
function PackagePicker({
  categories,
  selected,
  locked = [],
  onToggle,
  onClear,
  templateDefaults = [],
  exclude = [],
  title = "Select packages to install",
  labels = {},
}) {
  const [query, setQuery] = useState("");
  const [catFilter, setCatFilter] = useState("all");
  const q = query.trim().toLowerCase();
  const lockedSet = useMemo(() => new Set(locked), [locked]);
  const excludeSet = useMemo(() => new Set(exclude), [exclude]);
  const labelOf = (pkg) => labels[pkg]?.name || labels[pkg] || pkg;

  const groups = categories
    .map((cat) => ({
      name: cat.name,
      items: cat.items.filter((pkg) => {
        if (excludeSet.has(pkg)) return false;
        if (!q) return true;
        const label = String(labelOf(pkg)).toLowerCase();
        return pkg.toLowerCase().includes(q) || label.includes(q);
      }),
    }))
    .filter((cat) => cat.items.length > 0)
    .filter((cat) => catFilter === "all" || cat.name === catFilter);

  const optionalSelected = selected.filter((p) => !lockedSet.has(p) && !excludeSet.has(p));

  return (
    <div className="pkg-picker pv-pkg-picker">
      <div className="pkg-picker-head">
        <label>{title}</label>
        {optionalSelected.length > 0 && (
          <button type="button" className="pkg-clear" onClick={onClear}>
            Clear optional ({optionalSelected.length})
          </button>
        )}
      </div>

      {locked.length > 0 && (
        <div className="pkg-defaults">
          <span className="pkg-defaults-label">Default packages (always installed)</span>
          <div className="pkg-chips">
            {locked.map((pkg) => (
              <span key={pkg} className="pkg-locked-chip" title="Required — cannot be removed">
                <span className="pkg-lock" aria-hidden="true">🔒</span> {labelOf(pkg)}
              </span>
            ))}
          </div>
        </div>
      )}

      {templateDefaults.length > 0 && (
        <div className="pkg-defaults">
          <span className="pkg-defaults-label">Suggested for this template</span>
          <div className="pkg-chips">
            {templateDefaults.map((p, i) => (
              <span key={`${pkgName(p)}-${i}`} className="provision-inline-kind provision-inline-kind-fixed">{pkgName(p)}</span>
            ))}
          </div>
        </div>
      )}

      <input
        className="control-input pkg-search"
        placeholder="Search packages…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        aria-label="Search packages"
      />

      <div className="pv-pkg-cat-filters" role="tablist" aria-label="Package categories">
        <button
          type="button"
          role="tab"
          aria-selected={catFilter === "all"}
          className={`pv-pkg-cat-chip ${catFilter === "all" ? "on" : ""}`}
          onClick={() => setCatFilter("all")}
        >
          All
        </button>
        {categories.map((cat) => (
          <button
            key={cat.name}
            type="button"
            role="tab"
            aria-selected={catFilter === cat.name}
            className={`pv-pkg-cat-chip ${catFilter === cat.name ? "on" : ""}`}
            onClick={() => setCatFilter(cat.name)}
          >
            {cat.name}
          </button>
        ))}
      </div>

      <div className="pkg-catalog pv-pkg-catalog" role="listbox" aria-label="Package options" aria-multiselectable="true">
        {groups.map((cat) => (
          <div key={cat.name} className="pkg-cat">
            <div className="pkg-cat-label">{cat.name}</div>
            <div className="pkg-cat-grid pv-pkg-grid">
              {cat.items.map((pkg) => {
                const isLocked = lockedSet.has(pkg);
                const checked = selected.includes(pkg);
                return (
                  <button
                    type="button"
                    key={pkg}
                    className={`pkg-option pv-pkg-chip ${checked ? "on" : ""} ${isLocked ? "locked" : ""}`}
                    onClick={() => !isLocked && onToggle(pkg)}
                    disabled={isLocked}
                    role="option"
                    aria-selected={checked}
                    title={isLocked ? "Default package — always installed" : (labels[pkg]?.description || undefined)}
                  >
                    <span className="pkg-option-mark" aria-hidden="true">{isLocked ? "🔒" : checked ? "✓" : ""}</span>
                    <span className="pkg-option-name">{labelOf(pkg)}</span>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
        {groups.length === 0 && <div className="muted pkg-empty">No matching packages</div>}
      </div>
    </div>
  );
}

export default function ProvisionForm({
  selected,
  environments = [],
  templateDefaults = {},
  costRates = DEFAULT_COST_RATES,
  packageCategories = [],
  packageLabels = {},
  lockedPackageIds = [],
  initialValues = null,
  initialPackages = null,
  onSubmit,
  busy,
  onClose,
}) {
  const item = selected.item;
  const stackDefaultPackages = defaultPackagesFor(item, templateDefaults);
  const isInternal = item.provider === "internal";
  const isStack = selected.kind === "stack";
  const isContainer = selected.kind === "container";
  const isVm = selected.kind === "vm" && !isInternal;

  const makeInitialForm = () => ({
    hostname: initialValues?.hostname || "",
    application: initialValues?.application || "",
    cpu: initialValues?.cpu ?? 2,
    memoryGB: initialValues?.memoryGB ?? 2,
    additionalDisk: Number(initialValues?.additionalDiskGB) > 0,
    additionalDiskGB: Number(initialValues?.additionalDiskGB) > 0 ? Number(initialValues.additionalDiskGB) : 50,
    ttlUnit: initialValues?.ttlUnit || "days",
    ttlValue: initialValues?.ttlValue ?? 30,
    username: initialValues?.username || "",
    sudoAccess: initialValues?.sudoAccess ?? false,
    environment: initialValues?.environment || "",
  });

  const [form, setForm] = useState(makeInitialForm);
  const [diskMounts, setDiskMounts] = useState(() =>
    Array.isArray(initialValues?.diskMounts)
      ? initialValues.diskMounts.map((m) => ({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        path: m.path || "",
        sizeGB: Number(m.sizeGB) > 0 ? Number(m.sizeGB) : 10,
      }))
      : [],
  );
  const [requiredPackages, setRequiredPackages] = useState(() =>
    Array.from(new Set([...(initialPackages || []), ...lockedPackageIds]))
  );
  const [appRoles, setAppRoles] = useState(() => rolesFromFallbackJson());
  const [catalogApps, setCatalogApps] = useState([]);
  const [selectedApps, setSelectedApps] = useState([]);
  const [appPlan, setAppPlan] = useState([]);
  const [softwareTab, setSoftwareTab] = useState("blueprints"); // packages | blueprints
  const [wizardStep, setWizardStep] = useState(1);
  const [blueprintQuery, setBlueprintQuery] = useState("");
  const [customComposeEnabled, setCustomComposeEnabled] = useState(false);
  const [customComposeYaml, setCustomComposeYaml] = useState("");
  const [customComposeProject, setCustomComposeProject] = useState("custom");
  const [quotas, setQuotas] = useState(null);
  const [recentBlueprints, setRecentBlueprints] = useState(() => {
    try {
      const raw = JSON.parse(localStorage.getItem("forge.blueprints.recent") || "[]");
      return Array.isArray(raw) ? raw.filter((x) => typeof x === "string") : [];
    } catch {
      return [];
    }
  });
  const [roleAllowMulti, setRoleAllowMulti] = useState(false);
  const [sizes, setSizes] = useState([]);
  const [sizeKey, setSizeKey] = useState("custom");
  const [hostnameBusy, setHostnameBusy] = useState(false);
  const [hostnameEditing, setHostnameEditing] = useState(false);
  const [capacity, setCapacity] = useState(null);
  const [diskModalOpen, setDiskModalOpen] = useState(false);
  // Once the user manually edits the hostname, stop auto-regenerating until they click Reset.
  const hostnameTouchedRef = useRef(!!(initialValues?.hostname && String(initialValues.hostname).trim()));
  const suggestGenRef = useRef(0);
  const appPackagesRef = useRef([]);
  const capacityGenRef = useRef(0);

  const activeRole = useMemo(
    () => appRoles.find((r) => r.id === form.application) || null,
    [appRoles, form.application],
  );
  const roleOptionSet = useMemo(
    () => new Set(activeRole?.options || []),
    [activeRole],
  );
  const rolePicks = useMemo(
    () => requiredPackages.filter((p) => roleOptionSet.has(p)),
    [requiredPackages, roleOptionSet],
  );

  useEffect(() => {
    getMyQuotas().then(setQuotas).catch(() => setQuotas(null));
  }, []);

  useEffect(() => {
    let cancelled = false;
    getApplicationRoles()
      .then((rows) => {
        if (cancelled) return;
        if (Array.isArray(rows) && rows.length) setAppRoles(rows);
      })
      .catch(() => { /* keep fallback */ });
    getApps()
      .then((rows) => {
        if (cancelled) return;
        setCatalogApps(Array.isArray(rows) ? rows : []);
      })
      .catch(() => setCatalogApps([]));
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!selectedApps.length) {
      setAppPlan([]);
      return undefined;
    }
    previewApps(selectedApps)
      .then((data) => {
        if (!cancelled) setAppPlan(Array.isArray(data?.plan) ? data.plan : []);
      })
      .catch(() => {
        if (!cancelled) setAppPlan([]);
      });
    return () => { cancelled = true; };
  }, [selectedApps]);

  useEffect(() => {
    hostnameTouchedRef.current = !!(initialValues?.hostname && String(initialValues.hostname).trim());
    setHostnameEditing(false);
    setRoleAllowMulti(false);
    const initialApp = initialValues?.application || "";
    setForm(makeInitialForm());
    const base = Array.from(new Set([...(initialPackages || []), ...lockedPackageIds]));
    const role = appRoles.find((r) => r.id === initialApp);
    const appPkgs = initialPackagesForRole(role, { allowMulti: false });
    appPackagesRef.current = appPkgs;
    setRequiredPackages(Array.from(new Set([...base, ...appPkgs])));
    setSelectedApps([]);
    setWizardStep(1);
    setSoftwareTab("blueprints");
    setBlueprintQuery("");
  }, [selected.kind, item.id, lockedPackageIds.join("|")]);

  const envLabel = useMemo(() => {
    if (!form.environment) return "";
    const hit = environments.find((e) => e.iface === form.environment);
    return hit?.label || form.environment;
  }, [form.environment, environments]);

  const applySuggestedHostname = async ({ force = false } = {}) => {
    if (hostnameTouchedRef.current && !force) return;
    const gen = ++suggestGenRef.current;
    setHostnameBusy(true);
    try {
      const result = await suggestHostname({
        kind: selected.kind,
        templateId: item.id,
        stackId: item.id,
        application: form.application || undefined,
        rolePackages: appPackagesRef.current,
        packages: requiredPackages,
        apps: selectedApps,
        environment: envLabel || form.environment || undefined,
        os: item.osName || item.name,
      });
      if (gen !== suggestGenRef.current) return;
      if (result?.hostname) {
        if (force) hostnameTouchedRef.current = false;
        setForm((f) => ({ ...f, hostname: result.hostname }));
      }
    } catch {
      // Leave hostname as-is if suggestion fails.
    } finally {
      if (gen === suggestGenRef.current) setHostnameBusy(false);
    }
  };

  // Generate on review (after config + packages/blueprints), or immediately for internal templates.
  useEffect(() => {
    if (hostnameTouchedRef.current) return undefined;
    if (!isInternal && wizardStep !== 3) return undefined;
    const t = setTimeout(() => { applySuggestedHostname(); }, 50);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    item.id,
    selected.kind,
    form.application,
    envLabel,
    rolePicks.join("|"),
    requiredPackages.join("|"),
    selectedApps.join("|"),
    wizardStep,
    isInternal,
  ]);

  const applyRolePackages = (role, allowMulti) => {
    const nextAppPkgs = initialPackagesForRole(role, { allowMulti });
    const prevAppPkgs = new Set(appPackagesRef.current);
    const locked = new Set(lockedPackageIds);
    setRequiredPackages((prev) => {
      const kept = prev.filter((p) => locked.has(p) || !prevAppPkgs.has(p));
      return Array.from(new Set([...kept, ...nextAppPkgs]));
    });
    appPackagesRef.current = nextAppPkgs;
  };

  const onApplicationChange = (e) => {
    const application = e.target.value;
    setForm((f) => ({ ...f, application }));
    setRoleAllowMulti(false);
    const role = appRoles.find((r) => r.id === application) || null;
    applyRolePackages(role, false);
  };

  const setRolePickSingle = (pkgId) => {
    if (!activeRole) return;
    const prev = new Set(appPackagesRef.current);
    const locked = new Set(lockedPackageIds);
    const next = pkgId ? [pkgId] : [];
    setRequiredPackages((curr) => {
      const kept = curr.filter((p) => locked.has(p) || !prev.has(p));
      return Array.from(new Set([...kept, ...next]));
    });
    appPackagesRef.current = next;
  };

  const toggleRolePick = (pkgId) => {
    if (!activeRole) return;
    const locked = new Set(lockedPackageIds);
    if (locked.has(pkgId)) return;
    setRequiredPackages((prev) => {
      const inRole = prev.filter((p) => roleOptionSet.has(p));
      const outside = prev.filter((p) => !roleOptionSet.has(p));
      let nextRole;
      if (activeRole.selection === "single" && !roleAllowMulti) {
        nextRole = inRole.includes(pkgId) ? [] : [pkgId];
      } else if (activeRole.selection === "bundle") {
        // Bundle stays all-or-nothing via role reselect; allow unchecking individuals
        nextRole = inRole.includes(pkgId)
          ? inRole.filter((p) => p !== pkgId)
          : [...inRole, pkgId];
      } else {
        nextRole = inRole.includes(pkgId)
          ? inRole.filter((p) => p !== pkgId)
          : [...inRole, pkgId];
      }
      appPackagesRef.current = nextRole;
      return Array.from(new Set([...outside, ...nextRole]));
    });
  };

  const onAllowMultiChange = (checked) => {
    setRoleAllowMulti(checked);
    if (!checked && activeRole?.selection === "single") {
      // Collapse to default or first pick
      const keep = rolePicks[0] || activeRole.defaultOptionId || null;
      setRolePickSingle(keep && roleOptionSet.has(keep) ? keep : (activeRole.defaultOptionId || null));
    }
  };

  // Load admin-defined instance sizes, then pick the size that matches the
  // current CPU/RAM. When nothing matches and the caller didn't prefill exact
  // values, default to the smallest size (micro) instead of Custom.
  useEffect(() => {
    let cancelled = false;
    getInstanceSizes()
      .then((rows) => {
        if (cancelled) return;
        const list = Array.isArray(rows) ? rows : [];
        setSizes(list);
        if (!list.length) { setSizeKey("custom"); return; }
        const matched = matchSizeKey(list, form.cpu, form.memoryGB);
        if (matched !== "custom" || initialValues) {
          setSizeKey(matched);
          return;
        }
        const micro = list.find((s) => s.key === "micro") || list[0];
        setSizeKey(micro.key);
        setForm((f) => ({ ...f, cpu: micro.cpu, memoryGB: micro.memoryGB }));
      })
      .catch(() => {
        if (!cancelled) { setSizes([]); setSizeKey("custom"); }
      });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.id, selected.kind]);

  const upd = (k) => (e) => {
    const v = e.target.type === "number" ? Number(e.target.value)
      : e.target.type === "checkbox" ? e.target.checked
      : e.target.value;
    setForm((f) => ({ ...f, [k]: v }));
  };

  const onSizeChange = (e) => {
    const key = e.target.value;
    setSizeKey(key);
    if (key === "custom") return;
    const size = sizes.find((s) => s.key === key);
    if (size) setForm((f) => ({ ...f, cpu: size.cpu, memoryGB: size.memoryGB }));
  };

  const toggleRequiredPackage = (pkg) => {
    if (lockedPackageIds.includes(pkg)) return;
    setRequiredPackages((prev) => (prev.includes(pkg)
      ? prev.filter((p) => p !== pkg)
      : [...prev, pkg]));
  };

  const clearRequiredPackages = () => setRequiredPackages([...lockedPackageIds]);

  const effectivePackages = Array.from(new Set(requiredPackages));
  const customSize = sizeKey === "custom" || sizes.length === 0;
  const hasHostname = form.hostname.trim().length > 0;
  const hasCpu = Number.isFinite(form.cpu) && form.cpu >= 1 && form.cpu <= 128;
  const hasMemory = Number.isFinite(form.memoryGB) && form.memoryGB >= 1 && form.memoryGB <= 1024;
  // The OS disk comes from the template; only an optional extra data disk is
  // sized here (VMs/stacks only — containers have no separate disk).
  const wantsExtraDisk = !isContainer && !!form.additionalDisk;
  const hasExtraDisk = !wantsExtraDisk
    || (Number.isFinite(form.additionalDiskGB) && form.additionalDiskGB >= 5 && form.additionalDiskGB <= 2000);
  const extraDiskGB = wantsExtraDisk && Number.isFinite(form.additionalDiskGB) ? Math.max(0, form.additionalDiskGB) : 0;

  const mountAlloc = useMemo(() => {
    const rows = wantsExtraDisk ? diskMounts : [];
    const used = rows.reduce((n, r) => n + (Number(r.sizeGB) > 0 ? Math.round(Number(r.sizeGB)) : 0), 0);
    const free = extraDiskGB - used;
    const paths = rows.map((r) => String(r.path || "").trim());
    const pathErrors = [];
    const seen = new Set();
    for (const p of paths) {
      if (!p) continue;
      if (!p.startsWith("/") || p === "/") pathErrors.push(`“${p}” must be an absolute path (not /).`);
      if (seen.has(p)) pathErrors.push(`Duplicate mount: ${p}`);
      seen.add(p);
    }
    const incomplete = rows.some((r) => !String(r.path || "").trim() || !(Number(r.sizeGB) >= 1));
    const overBudget = rows.length > 0 && free < 1;
    return { used, free, pathErrors, incomplete, overBudget, maxAlloc: Math.max(0, extraDiskGB - 1) };
  }, [wantsExtraDisk, diskMounts, extraDiskGB]);

  const hasMountsOk = !wantsExtraDisk
    || diskMounts.length === 0
    || (!mountAlloc.incomplete && !mountAlloc.overBudget && mountAlloc.pathErrors.length === 0);
  // Lifetime chosen via the unit dropdown (+ amount). "Permanent" means no
  // decommission date at all.
  const permanent = form.ttlUnit === "permanent";
  const ttlDays = permanent
    ? null
    : Math.round(Number(form.ttlValue) * (TTL_UNIT_DAYS[form.ttlUnit] || 1));
  const hasTtl = permanent || (Number.isFinite(ttlDays) && ttlDays >= 1 && ttlDays <= 3650);
  // VMs additionally require an environment and a username.
  const hasVmExtras = !isVm || (form.environment && form.username.trim().length > 0);
  // Step 1 can advance without hostname — hostname is chosen/generated on Review.
  const isConfigValid = hasCpu && hasMemory && hasExtraDisk && hasMountsOk && hasTtl && hasVmExtras;
  const isFormValid = isConfigValid && hasHostname;

  // Live Proxmox headroom preview — warn when this request would push the node past amber/red.
  useEffect(() => {
    if (isInternal) {
      setCapacity(null);
      return undefined;
    }
    if (!hasCpu || !hasMemory) {
      setCapacity(null);
      return undefined;
    }
    const gen = ++capacityGenRef.current;
    const t = setTimeout(() => {
      previewCapacity({
        kind: selected.kind,
        cpu: form.cpu,
        memoryGB: form.memoryGB,
        additionalDiskGB: extraDiskGB,
        diskGB: extraDiskGB,
      })
        .then((impact) => {
          if (capacityGenRef.current === gen) setCapacity(impact);
        })
        .catch(() => {
          if (capacityGenRef.current === gen) setCapacity(null);
        });
    }, 350);
    return () => clearTimeout(t);
  }, [isInternal, hasCpu, hasMemory, form.cpu, form.memoryGB, extraDiskGB, selected.kind]);

  // Live monthly cost estimate — CPU + RAM always, plus the optional extra data
  // disk. The template's OS disk is included, so it isn't charged here.
  const cost = useMemo(() => {
    const cpu = Number.isFinite(form.cpu) ? Math.max(0, form.cpu) : 0;
    const memoryGB = Number.isFinite(form.memoryGB) ? Math.max(0, form.memoryGB) : 0;
    const diskGB = extraDiskGB;
    const cpuCost = cpu * (costRates.perCpu || 0);
    const ramCost = memoryGB * (costRates.perGbRam || 0);
    const storageCost = diskGB * (costRates.perGbStorage || 0);
    return { cpuCost, ramCost, storageCost, total: cpuCost + ramCost + storageCost, hasStorage: diskGB > 0 };
  }, [form.cpu, form.memoryGB, extraDiskGB, costRates]);
  const currency = costRates.currency || "INR";

  // Cost banner severity: amber past COST_AMBER_AT, red past COST_RED_AT.
  const costLevel = cost.total >= COST_RED_AT ? "red" : cost.total >= COST_AMBER_AT ? "amber" : "ok";

  // Human preview of when the resource will be decommissioned if not renewed.
  const decommissionText = useMemo(() => {
    if (permanent) return "Runs permanently — no automatic decommission.";
    if (!Number.isFinite(ttlDays) || ttlDays <= 0) return "Enter a positive amount.";
    const when = new Date(Date.now() + ttlDays * 86400_000);
    return `Decommissions on ${when.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })} unless renewed.`;
  }, [permanent, ttlDays]);

  // Estimated minutes for selected blueprints (display-only).
  const blueprintEtaMins = useMemo(() => {
    if (!appPlan.length) return 0;
    return appPlan.reduce((sum, p) => {
      const meta = BLUEPRINT_UI[p.id];
      if (!meta?.eta) return sum + 6;
      const m = String(meta.eta).match(/(\d+)/);
      return sum + (m ? Number(m[1]) : 6);
    }, 0);
  }, [appPlan]);

  const selectedPackageLabels = useMemo(() => {
    const labelOf = (pkg) => packageLabels[pkg]?.name || packageLabels[pkg] || pkg;
    return requiredPackages
      .filter((p) => !lockedPackageIds.includes(p))
      .map((p) => ({ id: p, name: labelOf(p) }));
  }, [requiredPackages, lockedPackageIds, packageLabels]);

  const filteredBlueprints = useMemo(() => {
    const q = blueprintQuery.trim().toLowerCase();
    if (!q) return catalogApps;
    return catalogApps.filter((app) => {
      const cat = app.category || app.defaultVars?.category || "";
      const hay = `${app.name} ${app.description || ""} ${cat}`.toLowerCase();
      return hay.includes(q);
    });
  }, [catalogApps, blueprintQuery]);

  const selectedCount = selectedPackageLabels.length + selectedApps.length;

  const goNext = () => {
    if (wizardStep === 1 && !isConfigValid) return;
    if (wizardStep === 1) setSoftwareTab("blueprints");
    // Fresh name when entering review from package/blueprint choices.
    if (wizardStep === 2) {
      hostnameTouchedRef.current = false;
      setHostnameEditing(false);
    }
    setWizardStep((s) => Math.min(3, s + 1));
  };
  const goBack = () => setWizardStep((s) => Math.max(1, s - 1));

  const clearSoftwareSelection = () => {
    clearRequiredPackages();
    setSelectedApps([]);
  };

  const buildSubmitPayload = () => {
    if (selectedApps.length) {
      try {
        const next = [...selectedApps, ...recentBlueprints.filter((id) => !selectedApps.includes(id))].slice(0, 12);
        localStorage.setItem("forge.blueprints.recent", JSON.stringify(next));
        setRecentBlueprints(next);
      } catch { /* ignore */ }
    }
    return {
      ...form,
      ttlDays,
      permanent,
      additionalDiskGB: extraDiskGB,
      diskMounts: wantsExtraDisk
        ? diskMounts
          .filter((r) => String(r.path || "").trim())
          .map((r) => ({ path: String(r.path).trim(), sizeGB: Math.round(Number(r.sizeGB)) }))
        : [],
      size: customSize ? null : sizeKey,
      packages: effectivePackages,
      packageSelection: { required: effectivePackages, selected: effectivePackages, effective: effectivePackages },
      apps: selectedApps,
      customCompose: customComposeEnabled && customComposeYaml.trim()
        ? { yaml: customComposeYaml, project: customComposeProject || "custom", name: "Custom compose" }
        : null,
    };
  };

  /** Explicit provision only — never auto-fires when entering Review. */
  const submitProvision = () => {
    if (busy || !isFormValid) return;
    onSubmit(buildSubmitPayload());
  };

  const envDisplay = useMemo(() => {
    const hit = environments.find((e) => e.iface === form.environment);
    return hit?.label || form.environment || "—";
  }, [environments, form.environment]);

  const sizeDisplay = customSize
    ? `${form.cpu} CPU · ${form.memoryGB} GB`
    : (sizes.find((s) => s.key === sizeKey)?.label || sizeKey);

  const durationDisplay = permanent
    ? "Permanent"
    : `${form.ttlValue} ${form.ttlUnit === "days" ? "Days" : form.ttlUnit === "months" ? "Months" : "Years"}`;

  const renderHostnameEditor = ({ showLabel = true } = {}) => (
    <div className="field pv-hostname-field">
      {showLabel && <label>{isStack ? "Hostname prefix" : "VM name / Hostname"}<Req /></label>}
      {hostnameEditing ? (
        <div className="hostname-edit-row">
          <input
            required
            autoFocus
            placeholder={isStack ? "myapp" : "hostname"}
            value={form.hostname}
            onChange={(e) => {
              hostnameTouchedRef.current = true;
              setForm((f) => ({ ...f, hostname: e.target.value }));
            }}
          />
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            disabled={hostnameBusy}
            onClick={() => {
              setHostnameEditing(false);
              applySuggestedHostname({ force: true });
            }}
          >
            Auto
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setHostnameEditing(false)}>
            Done
          </button>
        </div>
      ) : (
        <div className="hostname-display">
          <code className="hostname-display-value">
            {hostnameBusy && !form.hostname ? "Generating…" : (form.hostname || "—")}
          </code>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setHostnameEditing(true)}>
            Modify
          </button>
          {!isInternal && (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={hostnameBusy}
              title="Regenerate from OS, environment, packages, and blueprints"
              onClick={() => applySuggestedHostname({ force: true })}
            >
              Regenerate
            </button>
          )}
        </div>
      )}
    </div>
  );

  return (
    <div className="card card-pad provision-config-panel provision-modal-card pv-shell pv-shell-v2">
      <button type="button" className="close-btn pv-close" onClick={onClose} aria-label="Close">✕</button>

      <div className="pv-layout">
        <aside className="pv-rail">
          <div className="pv-rail-top">
            <div className="badge provision-kind-badge">{KIND_LABELS[selected.kind]}</div>
            <h3 className="pv-rail-title">{item.name}</h3>
            <p className="muted pv-rail-meta">{item.id}{item.vmid ? ` · VMID ${item.vmid}` : ""}</p>
          </div>

          <div className={`pv-rail-cost cost-${costLevel}`} role="status" aria-live="polite">
            <span className="pv-rail-cost-label">Estimated cost</span>
            <strong className="pv-rail-cost-value">
              {formatMoney(cost.total, currency)}
              <span> / month</span>
            </strong>
          </div>

          {!isInternal && (
            <nav className="pv-rail-steps" aria-label="Provisioning steps">
              {WIZARD_STEPS.map((s, i) => (
                <button
                  key={s.id}
                  type="button"
                  className={`pv-rail-step ${wizardStep === s.id ? "on" : ""} ${wizardStep > s.id ? "done" : ""}`}
                  onClick={() => {
                    if (s.id === 2 && !isConfigValid) return;
                    if (s.id === 3 && !isConfigValid) return;
                    if (s.id === 3) {
                      hostnameTouchedRef.current = false;
                      setHostnameEditing(false);
                    }
                    setWizardStep(s.id);
                    if (s.id === 2) setSoftwareTab("blueprints");
                  }}
                >
                  <span className="pv-rail-step-num" aria-hidden="true">
                    {wizardStep > s.id ? "✓" : i + 1}
                  </span>
                  <span className="pv-rail-step-label">{s.label}</span>
                </button>
              ))}
            </nav>
          )}
        </aside>

        <div className="pv-main">
          {capacity && wizardStep === 1 && (capacity.blocking?.length > 0 || Object.values(capacity.resources || {}).some((r) => r.level === "amber" || r.level === "red")) && (
            <div
              className={`capacity-warn capacity-warn-${capacity.canApprove === false ? "red" : "amber"}`}
              role="status"
            >
              <strong>{capacity.canApprove === false ? "Insufficient headroom" : "Capacity warning"}</strong>
              <p className="muted" style={{ margin: "4px 0 0", fontSize: 13 }}>
                {capacity.canApprove === false
                  ? `This size would push ${capacity.blocking.join(", ")} past 80% on the Proxmox node — approval will be blocked.`
                  : "Projected node usage is elevated after this provision."}
              </p>
            </div>
          )}

          {quotas?.teams?.some((t) => t.limited) && wizardStep === 1 && (
            <div className="capacity-warn capacity-warn-amber" role="status">
              <strong>Team quotas</strong>
              <ul style={{ margin: "6px 0 0", paddingLeft: 18, fontSize: 13 }}>
                {quotas.teams.filter((t) => t.limited).map((t) => (
                  <li key={t.name}>
                    <strong>{t.name}</strong>
                    {t.quotas.maxVms ? ` · VMs ${t.used.vms}/${t.quotas.maxVms}` : ""}
                    {t.quotas.maxCpu ? ` · CPU ${t.used.cpu}/${t.quotas.maxCpu}` : ""}
                    {t.quotas.maxMemoryGB ? ` · RAM ${t.used.memoryGB}/${t.quotas.maxMemoryGB} GB` : ""}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <form
            className="provision-form pv-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (isInternal) {
                submitProvision();
                return;
              }
              if (wizardStep < 3) goNext();
            }}
          >
            <div className="pv-main-scroll">
              {(isInternal || wizardStep === 1) && (
                <div className="pv-pane pv-pane-config">
                  <header className="pv-pane-head">
                    <h4>Configuration</h4>
                    <p className="muted">Size, lifetime, and access for this {isStack ? "stack" : isContainer ? "container" : "VM"}.</p>
                  </header>

                  <div className="pv-cfg-grid">
                    {isInternal && (
                      <div className="pv-cfg-span-2">{renderHostnameEditor()}</div>
                    )}

                    <div className="field">
                      <label>Size<Req /></label>
                      <select value={sizeKey} onChange={onSizeChange}>
                        {sizes.map((s) => (
                          <option key={s.key} value={s.key}>{s.label} — {s.cpu} CPU · {s.memoryGB} GB</option>
                        ))}
                        <option value="custom">Custom…</option>
                      </select>
                    </div>

                    {isVm ? (
                      <div className="field">
                        <label>Environment<Req /></label>
                        <select required value={form.environment} onChange={upd("environment")}>
                          <option value="">Select environment…</option>
                          {environments.map((e) => (
                            <option key={e.iface} value={e.iface}>{e.label}</option>
                          ))}
                        </select>
                      </div>
                    ) : <div className="field pv-cfg-spacer" aria-hidden="true" />}

                    {customSize && (
                      <>
                        <div className="field">
                          <label>CPU cores<Req /></label>
                          <input type="number" min="1" max="128" required value={form.cpu} onChange={upd("cpu")} />
                        </div>
                        <div className="field">
                          <label>Memory (GB)<Req /></label>
                          <input type="number" min="1" max="1024" required value={form.memoryGB} onChange={upd("memoryGB")} />
                        </div>
                      </>
                    )}

                    <div className="field">
                      <label>Required for<Req /></label>
                      <div className="ttl-field">
                        <select value={form.ttlUnit} onChange={upd("ttlUnit")}>
                          <option value="permanent">Permanent</option>
                          <option value="days">Days</option>
                          <option value="months">Months</option>
                          <option value="years">Years</option>
                        </select>
                        {!permanent && (
                          <input
                            className="ttl-value"
                            type="number"
                            min="1"
                            required
                            value={form.ttlValue}
                            onChange={upd("ttlValue")}
                            aria-label={`Number of ${form.ttlUnit}`}
                          />
                        )}
                      </div>
                    </div>

                    {isVm ? (
                      <div className="field">
                        <label>Username<Req /></label>
                        <div className="pv-input-with-toggle">
                          <input required placeholder="e.g. appuser" value={form.username} onChange={upd("username")} autoComplete="off" />
                          <div className="pv-inline-toggle" title="Sudo access">
                            <span className="pv-inline-toggle-label">Sudo</span>
                            <Toggle
                              variant="glow"
                              className="provision-sudo-switch"
                              checked={!!form.sudoAccess}
                              onChange={(v) => setForm((f) => ({ ...f, sudoAccess: v }))}
                            />
                          </div>
                        </div>
                      </div>
                    ) : <div className="field pv-cfg-spacer" aria-hidden="true" />}

                    {isVm && !isInternal ? (
                      <div className="field">
                        <label>Application <span className="muted" style={{ fontWeight: 400 }}>(optional)</span></label>
                        <select value={form.application || ""} onChange={onApplicationChange}>
                          <option value="">None — pick packages yourself</option>
                          {appRoles.map((a) => (
                            <option key={a.id} value={a.id}>{a.label}</option>
                          ))}
                        </select>
                      </div>
                    ) : !isContainer ? null : (
                      <div className="field pv-cfg-spacer" aria-hidden="true" />
                    )}

                    {!isContainer && (
                      <div className={`field pv-toggle-field ${isVm && !isInternal ? "" : "pv-cfg-span-2"}`}>
                        <label>Additional disk</label>
                        <div className="pv-toggle-row">
                          <Toggle
                            variant="glow"
                            className="provision-sudo-switch"
                            checked={!!form.additionalDisk}
                            onChange={(v) => {
                              setForm((f) => ({ ...f, additionalDisk: v }));
                              if (!v) {
                                setDiskMounts([]);
                                setDiskModalOpen(false);
                              } else setDiskModalOpen(true);
                            }}
                          />
                          {form.additionalDisk ? (
                            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setDiskModalOpen(true)}>
                              {extraDiskGB} GB · Configure
                            </button>
                          ) : (
                            <span className="muted">Optional data volume</span>
                          )}
                        </div>
                      </div>
                    )}

                    {activeRole && (activeRole.options || []).length > 0 && (
                      <div className="provision-role-panel pv-cfg-span-2">
                        <div className="provision-role-panel-head">
                          <span>For this role — {activeRole.label}</span>
                        </div>
                        {activeRole.allowMultiOverride && activeRole.selection === "single" && (
                          <div className="provision-role-multi-toggle">
                            <Toggle variant="square" size="sm" checked={roleAllowMulti} onChange={onAllowMultiChange} />
                            <span>Allow multiple options on this server</span>
                          </div>
                        )}
                        <div className="provision-role-options">
                          {(activeRole.options || []).map((pkgId) => {
                            const checked = rolePicks.includes(pkgId);
                            const singleMode = activeRole.selection === "single" && !roleAllowMulti;
                            const isBundle = activeRole.selection === "bundle";
                            const display = packageLabels[pkgId]?.name || packageLabels[pkgId] || pkgId;
                            return (
                              <div
                                key={pkgId}
                                className={`provision-role-option ${checked ? "on" : ""} ${isBundle ? "is-bundle" : ""}`}
                                title={packageLabels[pkgId]?.description || undefined}
                              >
                                <Toggle
                                  variant="glow"
                                  size="sm"
                                  checked={checked}
                                  disabled={isBundle}
                                  title={display}
                                  onChange={(v) => {
                                    if (isBundle) return;
                                    if (singleMode) setRolePickSingle(v ? pkgId : null);
                                    else toggleRolePick(pkgId);
                                  }}
                                />
                                <span>{display}</span>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </div>

                  {isInternal && (
                    <div className="pv-card" style={{ marginTop: 16 }}>
                      <div className="pv-card-title">Internal workflow</div>
                      <div className="pv-card-body">
                        <ol className="wf-track">
                          {(item.workflowSteps || []).map((label, i) => (
                            <li key={i} className="wf-track-step wf-track-pending">
                              <span className="wf-track-dot">{i + 1}</span>
                              <span className="wf-track-body">
                                <span className="wf-track-label">{label}</span>
                              </span>
                            </li>
                          ))}
                        </ol>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {!isInternal && wizardStep === 2 && (
                <div className="pv-pane pv-pane-software">
                  <header className="pv-pane-head pv-pane-head-row">
                    <div>
                      <h4>Packages &amp; Blueprints</h4>
                      <p className="muted">Optional software to install after the guest boots.</p>
                    </div>
                    {softwareTab === "blueprints" && (
                      <input
                        className="pv-soft-search"
                        type="search"
                        placeholder="Search blueprints…"
                        value={blueprintQuery}
                        onChange={(e) => setBlueprintQuery(e.target.value)}
                        aria-label="Search blueprints"
                      />
                    )}
                  </header>

                  <div className="pv-soft-tabs" role="tablist" aria-label="Software selection">
                    <button type="button" role="tab" aria-selected={softwareTab === "packages"} className={`pv-soft-tab ${softwareTab === "packages" ? "on" : ""}`} onClick={() => setSoftwareTab("packages")}>Packages</button>
                    <button type="button" role="tab" aria-selected={softwareTab === "blueprints"} className={`pv-soft-tab ${softwareTab === "blueprints" ? "on" : ""}`} onClick={() => setSoftwareTab("blueprints")}>Blueprints (Stacks)</button>
                  </div>

                  <div className="pv-soft-panel">
                    {softwareTab === "packages" && (
                      <PackagePicker
                        categories={packageCategories}
                        selected={requiredPackages}
                        locked={lockedPackageIds}
                        exclude={[...roleOptionSet]}
                        labels={packageLabels}
                        title="Additional packages"
                        onToggle={toggleRequiredPackage}
                        onClear={clearRequiredPackages}
                        templateDefaults={stackDefaultPackages}
                      />
                    )}

                    {softwareTab === "blueprints" && (
                      <div className="pv-blueprint-panel">
                        {recentBlueprints.length > 0 && (
                          <div className="tpl-pin-row" style={{ marginBottom: 10 }}>
                            <span className="tpl-pin-label">Recent</span>
                            <div className="tpl-pin-chips">
                              {recentBlueprints.map((id) => {
                                const app = catalogApps.find((a) => a.id === id);
                                if (!app) return null;
                                const on = selectedApps.includes(id);
                                return (
                                  <button
                                    key={id}
                                    type="button"
                                    className={`tpl-pin-chip ${on ? "" : "muted"}`}
                                    onClick={() => setSelectedApps((prev) => (on ? prev.filter((x) => x !== id) : [...prev, id]))}
                                  >
                                    {app.name}
                                  </button>
                                );
                              })}
                            </div>
                          </div>
                        )}
                        {filteredBlueprints.length === 0 ? (
                          <div className="muted pkg-empty">
                            {catalogApps.length === 0 ? "No blueprints available yet." : "No blueprints match your search."}
                          </div>
                        ) : (
                          <div className="pv-blueprint-grid">
                            {filteredBlueprints.map((app) => {
                              const on = selectedApps.includes(app.id);
                              const hardcoded = BLUEPRINT_UI[app.id] || {};
                              const apiComps = Array.isArray(app.components) && app.components.length
                                ? app.components
                                : (Array.isArray(app.defaultVars?.components) ? app.defaultVars.components : []);
                              const meta = {
                                mark: hardcoded.mark || String(app.name || "?").slice(0, 2).toUpperCase(),
                                tint: hardcoded.tint || "#6366f1",
                                components: apiComps.length ? apiComps : (hardcoded.components || [app.strategy || "ansible"]),
                                eta: app.eta || app.defaultVars?.eta || hardcoded.eta || "~10 min",
                              };
                              const comps = (meta.components || []).slice(0, 4);
                              return (
                                <button
                                  key={app.id}
                                  type="button"
                                  className={`pv-blueprint-card pv-blueprint-card-v2 ${on ? "on" : ""}`}
                                  onClick={() => setSelectedApps((prev) => (on ? prev.filter((x) => x !== app.id) : [...prev, app.id]))}
                                  aria-pressed={on}
                                >
                                  <span className={`pv-bp-check ${on ? "on" : ""}`} aria-hidden="true">{on ? "✓" : ""}</span>
                                  <span className="pv-blueprint-icon" style={{ background: `color-mix(in srgb, ${meta.tint} 18%, #fff)`, color: meta.tint }}>
                                    {meta.mark}
                                  </span>
                                  <h4 className="pv-blueprint-name">
                                    {app.name}
                                    {app.source === "custom" && (
                                      <span className="pv-bp-source" title="Onboarded from custom content">Custom</span>
                                    )}
                                  </h4>
                                  <ul className="pv-blueprint-comps">
                                    {comps.map((c) => <li key={c} className="pv-blueprint-comp">• {c}</li>)}
                                  </ul>
                                  <span className="pv-blueprint-eta muted">{meta.eta}</span>
                                </button>
                              );
                            })}
                          </div>
                        )}

                        <div className="pv-custom-compose">
                          <Toggle
                            variant="square"
                            size="sm"
                            checked={customComposeEnabled}
                            onChange={setCustomComposeEnabled}
                            label="Custom Compose on guest (Advanced)"
                            description="Paste a one-off docker-compose.yml to deploy after catalog blueprints (requires Docker)."
                          />
                          {customComposeEnabled && (
                            <div style={{ marginTop: 10 }}>
                              <label className="field">
                                <span>Project name</span>
                                <input
                                  className="control-input mono"
                                  value={customComposeProject}
                                  onChange={(e) => setCustomComposeProject(e.target.value.toLowerCase().replace(/[^a-z0-9-_]/g, ""))}
                                  placeholder="custom"
                                />
                              </label>
                              <label className="field">
                                <span>Compose YAML</span>
                                <textarea
                                  className="control-input mono"
                                  rows={10}
                                  value={customComposeYaml}
                                  onChange={(e) => setCustomComposeYaml(e.target.value)}
                                  placeholder={"services:\n  web:\n    image: nginx:alpine\n    ports:\n      - \"8080:80\""}
                                />
                              </label>
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                  </div>

                  {selectedCount > 0 && (
                    <div className="pv-selected-summary">
                      <div className="pv-selected-bar">
                        <div className="pv-selected-title">{selectedCount} item{selectedCount === 1 ? "" : "s"} selected</div>
                        <button type="button" className="btn btn-ghost btn-sm" onClick={clearSoftwareSelection}>Clear all</button>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {!isInternal && wizardStep === 3 && (
                <div className="pv-pane pv-pane-review">
                  <header className="pv-pane-head">
                    <h4>Review &amp; launch</h4>
                    <p className="muted">Confirm the generated name and summary, then provision.</p>
                  </header>

                  <div className="pv-review-layout">
                    <div className="pv-review-main">
                      <div className="pv-review-hostname">
                        <span className="pv-review-k">VM name / Hostname</span>
                        {renderHostnameEditor({ showLabel: false })}
                      </div>

                      <dl className="pv-review-dl">
                        <div><dt>Template</dt><dd>{item.name}</dd></div>
                        <div><dt>Duration</dt><dd>{durationDisplay}</dd></div>
                        <div><dt>Size</dt><dd>{sizeDisplay}{customSize ? ` (${form.cpu} CPU · ${form.memoryGB} GB)` : ""}</dd></div>
                        <div><dt>Packages</dt><dd>{selectedPackageLabels.length ? selectedPackageLabels.map((p) => p.name).join(", ") : "None"}</dd></div>
                        <div><dt>Environment</dt><dd>{envDisplay}</dd></div>
                        <div><dt>Blueprints</dt><dd>{appPlan.length ? appPlan.map((p) => p.name + (p.autoIncluded ? " (auto)" : "")).join(", ") : "None"}</dd></div>
                        <div><dt>User</dt><dd>{form.username || "—"}</dd></div>
                        <div><dt>Est. software install</dt><dd>{blueprintEtaMins > 0 ? `~${blueprintEtaMins} minutes` : "—"}</dd></div>
                        <div><dt>Sudo access</dt><dd>{form.sudoAccess ? "Enabled" : "Off"}</dd></div>
                        <div><dt>Lifetime</dt><dd>{decommissionText}</dd></div>
                        {wantsExtraDisk && (
                          <div className="pv-review-span-2">
                            <dt>Data disk</dt>
                            <dd>
                              {extraDiskGB} GB
                              {diskMounts.filter((r) => String(r.path || "").trim()).length === 0 ? " (raw / unused)" : ""}
                              {diskMounts.filter((r) => String(r.path || "").trim()).length > 0 && (
                                <ul className="provision-review-mounts">
                                  {diskMounts.filter((r) => String(r.path || "").trim()).map((r) => (
                                    <li key={r.id}>
                                      <span>{r.path}</span>
                                      <span>{Math.round(Number(r.sizeGB))} GB → {pathToLvPreview(r.path)}</span>
                                    </li>
                                  ))}
                                </ul>
                              )}
                            </dd>
                          </div>
                        )}
                      </dl>

                      <div className="pv-review-note">
                        Nothing has been provisioned yet. Click <strong>Provision</strong> below to start.
                      </div>
                    </div>

                    <aside className="pv-review-cost">
                      <span className="pv-rail-cost-label">Estimated monthly cost</span>
                      <strong className="pv-review-cost-value">{formatMoney(cost.total, currency)}</strong>
                      <div className="pv-review-included">
                        <span className="pv-rail-cost-label">What&apos;s included</span>
                        <ul>
                          <li>Compute resources</li>
                          <li>Base OS image</li>
                          <li>Selected blueprints</li>
                          <li>System updates</li>
                        </ul>
                      </div>
                    </aside>
                  </div>
                </div>
              )}
            </div>

            <div className="provision-modal-actions pv-actions">
              {isInternal ? (
                <>
                  <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
                  <button type="button" className="btn btn-primary" disabled={busy || !isFormValid} onClick={submitProvision}>
                    {busy ? "Submitting..." : "Provision"}
                  </button>
                </>
              ) : (
                <>
                  {wizardStep === 1 ? (
                    <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
                  ) : (
                    <button type="button" className="btn btn-ghost" onClick={goBack}>
                      {wizardStep === 2 ? "Back to configuration" : "Back"}
                    </button>
                  )}
                  {wizardStep < 3 ? (
                    <button type="button" className="btn btn-primary" disabled={wizardStep === 1 && !isConfigValid} onClick={goNext}>
                      {wizardStep === 1 ? "Next: Packages / Blueprints →" : "Next: Review & Launch →"}
                    </button>
                  ) : (
                    <button type="button" className="btn btn-primary" disabled={busy || !isFormValid} onClick={submitProvision}>
                      {busy ? "Submitting..." : "🚀 Provision"}
                    </button>
                  )}
                </>
              )}
            </div>
          </form>
        </div>
      </div>

      {diskModalOpen && form.additionalDisk && (
        <div
          className="modal-overlay provision-disk-modal-overlay"
          role="presentation"
          onClick={(e) => {
            if (e.target === e.currentTarget) setDiskModalOpen(false);
          }}
        >
          <div
            className="modal-card provision-disk-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="provision-disk-modal-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-header">
              <h3 id="provision-disk-modal-title">Additional disk</h3>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setDiskModalOpen(false)} aria-label="Close">✕</button>
            </div>
            <div className="modal-body">
              <div className="field provision-disk-size">
                <label>Disk size (GB)<Req /></label>
                <input type="number" min="5" max="2000" required value={form.additionalDiskGB} onChange={upd("additionalDiskGB")} />
              </div>
              <div className="provision-mounts">
                <div className="provision-mounts-head">
                  <div>
                    <div className="provision-mounts-title">Mount points</div>
                    <p className="provision-disk-hint">
                      Optional. Leave empty for a raw unused disk.
                      Keep at least 1 GB free ({mountAlloc.maxAlloc} GB max allocatable).
                    </p>
                  </div>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm provision-mounts-add"
                    onClick={() => setDiskMounts((rows) => [...rows, newMountRow()])}
                    title="Add mount point"
                    aria-label="Add mount point"
                  >
                    +
                  </button>
                </div>
                {diskMounts.length > 0 && (
                  <div className="provision-mounts-table" role="table" aria-label="Mount points">
                    <div className="provision-mounts-row provision-mounts-row-head" role="row">
                      <div role="columnheader">Mount point</div>
                      <div role="columnheader">Size (GB)</div>
                      <div role="columnheader">LV</div>
                      <div role="columnheader" />
                    </div>
                    {diskMounts.map((row) => {
                      const otherUsed = diskMounts
                        .filter((r) => r.id !== row.id)
                        .reduce((n, r) => n + (Number(r.sizeGB) > 0 ? Math.round(Number(r.sizeGB)) : 0), 0);
                      const maxForRow = Math.max(1, extraDiskGB - 1 - otherUsed);
                      return (
                        <div key={row.id} className="provision-mounts-row" role="row">
                          <input
                            className="control-input"
                            placeholder="/data"
                            value={row.path}
                            onChange={(e) => setDiskMounts((rows) => rows.map((r) => (r.id === row.id ? { ...r, path: e.target.value } : r)))}
                            aria-label="Mount point path"
                          />
                          <input
                            className="control-input"
                            type="number"
                            min="1"
                            max={maxForRow}
                            value={row.sizeGB}
                            onChange={(e) => {
                              const n = Math.round(Number(e.target.value));
                              setDiskMounts((rows) => rows.map((r) => (r.id === row.id ? { ...r, sizeGB: Number.isFinite(n) ? n : "" } : r)));
                            }}
                            aria-label="Mount size GB"
                          />
                          <code className="provision-mounts-lv muted">{pathToLvPreview(row.path)}</code>
                          <button
                            type="button"
                            className="btn btn-ghost btn-sm"
                            onClick={() => setDiskMounts((rows) => rows.filter((r) => r.id !== row.id))}
                            aria-label={`Remove ${row.path || "mount"}`}
                          >
                            ✕
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
                <div className={`provision-mounts-budget ${mountAlloc.overBudget ? "is-bad" : ""}`}>
                  <span>Allocated {mountAlloc.used} GB</span>
                  <span className="provision-mounts-dot" aria-hidden="true">·</span>
                  <span>{mountAlloc.free} GB free (need ≥ 1)</span>
                </div>
                {(mountAlloc.overBudget || mountAlloc.pathErrors.length > 0) && (
                  <p className="login-error provision-mounts-error" role="alert">
                    {mountAlloc.overBudget
                      ? `Total mount sizes leave less than 1 GB free on the ${extraDiskGB} GB disk.`
                      : mountAlloc.pathErrors[0]}
                  </p>
                )}
              </div>
              <div className="modal-actions">
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={mountAlloc.overBudget || mountAlloc.pathErrors.length > 0 || mountAlloc.incomplete}
                  onClick={() => setDiskModalOpen(false)}
                >
                  Done
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
