import { useEffect, useMemo, useRef, useState } from "react";
import { getInstanceSizes, suggestHostname, previewCapacity, getApplicationRoles } from "../api/client.js";
import applicationProfilesFallback from "../data/applicationProfiles.json";

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
  { name: "Languages & runtimes", items: ["dotnet-sdk", "go", "java", "nodejs", "openjdk", "php", "python"] },
  { name: "Build tools", items: ["aqt", "maven", "yarn"] },
  { name: "Containers & orchestration", items: ["docker", "docker-compose", "helm", "kubectl"] },
  { name: "Databases & cache", items: ["mongodb", "mysql", "postgres", "redis"] },
  { name: "Messaging", items: ["rabbitmq"] },
  { name: "Web & proxy", items: ["nginx"] },
  { name: "DevOps & IaC", items: ["ansible", "terraform"] },
  { name: "Monitoring", items: ["grafana", "prometheus"] },
  { name: "CLI & utilities", items: ["awscli", "curl", "git", "htop", "jq", "postman", "tmux", "vim"] },
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
}) {
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const lockedSet = useMemo(() => new Set(locked), [locked]);
  const excludeSet = useMemo(() => new Set(exclude), [exclude]);

  const groups = categories
    .map((cat) => ({
      name: cat.name,
      items: cat.items.filter((pkg) => !excludeSet.has(pkg) && pkg.toLowerCase().includes(q)),
    }))
    .filter((cat) => cat.items.length > 0);

  const optionalSelected = selected.filter((p) => !lockedSet.has(p) && !excludeSet.has(p));

  return (
    <div className="pkg-picker">
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
                <span className="pkg-lock" aria-hidden="true">🔒</span> {pkg}
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
      />

      <div className="pkg-catalog" role="listbox" aria-label="Package options" aria-multiselectable="true">
        {groups.map((cat) => (
          <div key={cat.name} className="pkg-cat">
            <div className="pkg-cat-label">{cat.name}</div>
            <div className="pkg-cat-grid">
              {cat.items.map((pkg) => {
                const isLocked = lockedSet.has(pkg);
                const checked = selected.includes(pkg);
                return (
                  <button
                    type="button"
                    key={pkg}
                    className={`pkg-option ${checked ? "on" : ""} ${isLocked ? "locked" : ""}`}
                    onClick={() => !isLocked && onToggle(pkg)}
                    disabled={isLocked}
                    role="option"
                    aria-selected={checked}
                    title={isLocked ? "Default package — always installed" : undefined}
                  >
                    <span className="pkg-option-mark" aria-hidden="true">{isLocked ? "🔒" : checked ? "✓" : "+"}</span>
                    <span className="pkg-option-name">{pkg}</span>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
        {groups.length === 0 && <div className="muted pkg-empty">No matching packages</div>}
      </div>

      <div className="pkg-selected">
        <span className="pkg-selected-label">Will be installed</span>
        <div className="pkg-chips">
          {selected.map((pkg) => {
            const isLocked = lockedSet.has(pkg);
            return isLocked ? (
              <span key={pkg} className="pkg-locked-chip">{pkg}</span>
            ) : (
              <button type="button" key={pkg} className="pkg-selected-chip" onClick={() => onToggle(pkg)} title="Remove">
                {pkg}<span className="pkg-selected-x" aria-hidden="true">×</span>
              </button>
            );
          })}
          {selected.length === 0 && <span className="muted">No packages selected</span>}
        </div>
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
  const [requiredPackages, setRequiredPackages] = useState(() =>
    Array.from(new Set([...(initialPackages || []), ...lockedPackageIds]))
  );
  const [appRoles, setAppRoles] = useState(() => rolesFromFallbackJson());
  const [roleAllowMulti, setRoleAllowMulti] = useState(false);
  const [sizes, setSizes] = useState([]);
  const [sizeKey, setSizeKey] = useState("custom");
  const [hostnameBusy, setHostnameBusy] = useState(false);
  const [hostnameEditing, setHostnameEditing] = useState(false);
  const [capacity, setCapacity] = useState(null);
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
  const dbMultiWarning = activeRole?.id === "db" && rolePicks.length > 1;
  const sizeNudgeMultiDb = dbMultiWarning && (sizeKey === "micro" || sizeKey === "mini");

  useEffect(() => {
    let cancelled = false;
    getApplicationRoles()
      .then((rows) => {
        if (cancelled) return;
        if (Array.isArray(rows) && rows.length) setAppRoles(rows);
      })
      .catch(() => { /* keep fallback */ });
    return () => { cancelled = true; };
  }, []);

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

  // Auto-generate when the template is selected (or application / env changes), unless user edited hostname.
  useEffect(() => {
    if (hostnameTouchedRef.current) return undefined;
    const t = setTimeout(() => { applySuggestedHostname(); }, 50);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.id, selected.kind, form.application, envLabel, rolePicks.join("|")]);

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
  // Lifetime chosen via the unit dropdown (+ amount). "Permanent" means no
  // decommission date at all.
  const permanent = form.ttlUnit === "permanent";
  const ttlDays = permanent
    ? null
    : Math.round(Number(form.ttlValue) * (TTL_UNIT_DAYS[form.ttlUnit] || 1));
  const hasTtl = permanent || (Number.isFinite(ttlDays) && ttlDays >= 1 && ttlDays <= 3650);
  // VMs additionally require an environment and a username.
  const hasVmExtras = !isVm || (form.environment && form.username.trim().length > 0);
  const isFormValid = hasHostname && hasCpu && hasMemory && hasExtraDisk && hasTtl && hasVmExtras;

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

  return (
    <div className="card card-pad provision-config-panel provision-modal-card">
      <div className="provision-modal-head">
        <div className="provision-config-head">
          <div className="badge provision-kind-badge">{KIND_LABELS[selected.kind]}</div>
          <h3>{item.name}</h3>
          <p className="muted">{item.id}{item.vmid ? ` • VMID ${item.vmid}` : ""}</p>
        </div>
        <button className="close-btn" onClick={onClose} aria-label="Close">✕</button>
      </div>

      {item.description && <p className="muted provision-config-desc">{item.description}</p>}

      <div className={`cost-estimate cost-${costLevel}`} role="status" aria-live="polite">
        <div className="cost-estimate-head">
          <span className="cost-estimate-label">Estimated cost</span>
          <span className="cost-estimate-total">
            {formatMoney(cost.total, currency)}<span className="cost-estimate-period"> / month</span>
          </span>
        </div>
        <div className="cost-estimate-breakdown">
          <span>{form.cpu || 0} CPU × {formatMoney(costRates.perCpu, currency)} = {formatMoney(cost.cpuCost, currency)}</span>
          <span>{form.memoryGB || 0} GB RAM × {formatMoney(costRates.perGbRam, currency)} = {formatMoney(cost.ramCost, currency)}</span>
          {cost.hasStorage && (
            <span>{extraDiskGB} GB data disk × {formatMoney(costRates.perGbStorage, currency)} = {formatMoney(cost.storageCost, currency)}</span>
          )}
        </div>
      </div>

      {capacity && (capacity.blocking?.length > 0 || Object.values(capacity.resources || {}).some((r) => r.level === "amber" || r.level === "red")) && (
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
          <ul className="capacity-warn-list">
            {Object.values(capacity.resources || {}).map((r) => (
              <li key={r.label} className={`capacity-level-${r.level}`}>
                {r.label}: {Math.round(r.percentAfter)}% after
              </li>
            ))}
          </ul>
        </div>
      )}

      <form className="provision-form" onSubmit={(e) => {
        e.preventDefault();
        onSubmit({
          ...form,
          ttlDays,
          permanent,
          additionalDiskGB: extraDiskGB,
          size: customSize ? null : sizeKey,
          packages: effectivePackages,
          packageSelection: { required: effectivePackages, selected: effectivePackages, effective: effectivePackages },
        });
      }}>
        <div className="provision-form-body">
          <section className="provision-form-col">
            <div className="provision-col-title">Configuration</div>
            <div className="provision-field-grid">
              <div className="field provision-field-wide">
                <label>{isStack ? "Hostname prefix" : "Hostname"}</label>
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
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => setHostnameEditing(false)}
                    >
                      Done
                    </button>
                  </div>
                ) : (
                  <div className="hostname-display">
                    <code className="hostname-display-value">
                      {hostnameBusy && !form.hostname ? "Generating…" : (form.hostname || "—")}
                    </code>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => setHostnameEditing(true)}
                    >
                      Modify
                    </button>
                  </div>
                )}
              </div>
              <div className="field">
                <label>Size<Req /></label>
                <select value={sizeKey} onChange={onSizeChange}>
                  {sizes.map((s) => (
                    <option key={s.key} value={s.key}>{s.label} — {s.cpu} CPU · {s.memoryGB} GB</option>
                  ))}
                  <option value="custom">Custom…</option>
                </select>
              </div>
              {customSize ? (
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
              ) : null}
              {!isContainer && (
                <div className="field provision-field-wide provision-disk-field">
                  <div className="provision-disk-toggle">
                    <div>
                      <label className="provision-disk-label">Additional disk</label>
                    </div>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={!!form.additionalDisk}
                      className={`switch provision-sudo-switch ${form.additionalDisk ? "on" : ""}`}
                      onClick={() => setForm((f) => ({ ...f, additionalDisk: !f.additionalDisk }))}
                    >
                      <span className="switch-knob" />
                    </button>
                  </div>
                  {form.additionalDisk && (
                    <div className="provision-disk-size">
                      <label>Additional disk size (GB)<Req /></label>
                      <input type="number" min="5" max="2000" required value={form.additionalDiskGB} onChange={upd("additionalDiskGB")} />
                    </div>
                  )}
                </div>
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
              {isVm && (
                <div className="field provision-field-wide">
                  <label>Environment<Req /></label>
                  <select required value={form.environment} onChange={upd("environment")}>
                    <option value="">Select environment…</option>
                    {environments.map((e) => (
                      <option key={e.iface} value={e.iface}>{e.label}</option>
                    ))}
                  </select>
                </div>
              )}
              {isVm && (
                <>
                  <div className="field">
                    <label>Username<Req /></label>
                    <input required placeholder="e.g. appuser" value={form.username} onChange={upd("username")} autoComplete="off" />
                  </div>
                  <div className="field">
                    <label>Sudo access</label>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={form.sudoAccess}
                      className={`switch provision-sudo-switch ${form.sudoAccess ? "on" : ""}`}
                      onClick={() => setForm((f) => ({ ...f, sudoAccess: !f.sudoAccess }))}
                    >
                      <span className="switch-knob" />
                    </button>
                  </div>
                </>
              )}
            </div>

            <ul className="provision-form-notes">
              <li>🗓 {decommissionText}</li>
              {isVm && (
                <li>🔐 A strong password is generated automatically for this user and shown in the deployment summary.</li>
              )}
              {isVm && environments.length === 0 && (
                <li>⚠ No environments mapped yet — an admin must label a network in Mappings.</li>
              )}
            </ul>
          </section>

          <section className="provision-form-col provision-form-col-side">
            {isInternal ? (
              <>
                <div className="provision-col-title">Internal workflow</div>
                <p className="muted" style={{ marginTop: 0 }}>
                  This does not create a Proxmox VM. It runs our standard internal provisioning process and
                  calls each internal system in turn — watch it stream live in the deployment monitor:
                </p>
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
              </>
            ) : (
              <>
                <div className="provision-col-title">Software</div>
                <div className="field provision-app-field">
                  <label>Application <span className="muted" style={{ fontWeight: 400 }}>(optional)</span></label>
                  <select value={form.application || ""} onChange={onApplicationChange}>
                    <option value="">None — pick packages yourself</option>
                    {appRoles.map((a) => (
                      <option key={a.id} value={a.id}>{a.label}</option>
                    ))}
                  </select>
                  <p className="muted provision-app-hint">
                    Choose software for this role below. Add anything else under Additional software.
                  </p>
                </div>

                {activeRole && (activeRole.options || []).length > 0 && (
                  <div className="provision-role-panel">
                    <div className="provision-role-panel-head">
                      <span>For this role — {activeRole.label}</span>
                      {activeRole.selection === "bundle" && (
                        <span className="muted" style={{ fontSize: 12 }}>Selected together as a set</span>
                      )}
                    </div>
                    {activeRole.allowMultiOverride && activeRole.selection === "single" && (
                      <label className="provision-role-multi-toggle">
                        <input
                          type="checkbox"
                          checked={roleAllowMulti}
                          onChange={(e) => onAllowMultiChange(e.target.checked)}
                        />
                        Allow multiple database engines on this server
                      </label>
                    )}
                    <div className="provision-role-options">
                      {(activeRole.options || []).map((pkgId) => {
                        const checked = rolePicks.includes(pkgId);
                        const singleMode = activeRole.selection === "single" && !roleAllowMulti;
                        return (
                          <label key={pkgId} className={`provision-role-option ${checked ? "on" : ""}`}>
                            <input
                              type={singleMode ? "radio" : "checkbox"}
                              name={`role-pkg-${activeRole.id}`}
                              checked={checked}
                              onChange={() => {
                                if (singleMode) setRolePickSingle(checked ? null : pkgId);
                                else toggleRolePick(pkgId);
                              }}
                            />
                            <span>{pkgId}</span>
                          </label>
                        );
                      })}
                    </div>
                    {dbMultiWarning && (
                      <p className="provision-role-warn">
                        Unusual on one VM — fine for labs or migration; prefer one engine in production.
                      </p>
                    )}
                    {sizeNudgeMultiDb && (
                      <p className="provision-role-warn">
                        Micro/Mini may be tight for multiple database engines — consider a larger size.
                      </p>
                    )}
                  </div>
                )}

                <PackagePicker
                  categories={packageCategories}
                  selected={requiredPackages}
                  locked={lockedPackageIds}
                  exclude={[...roleOptionSet]}
                  title="Additional software"
                  onToggle={toggleRequiredPackage}
                  onClear={clearRequiredPackages}
                  templateDefaults={stackDefaultPackages}
                />
              </>
            )}
          </section>
        </div>

        <div className="provision-modal-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy || !isFormValid}>{busy ? "Submitting..." : "Provision"}</button>
        </div>
      </form>
    </div>
  );
}
