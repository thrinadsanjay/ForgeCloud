import { prisma, fireAndForget } from "../db/client.js";
import { getTemplateMappings, getNetworkMappings } from "./mappingStore.js";
import { shortEnvCode } from "./envCode.js";

const INTERNAL_STAGES = ["Preparation", "Provisioning", "Post actions"];
const HOSTNAME_FORMAT_KEY = "HOSTNAME_FORMAT";
const HOSTNAME_SEQ_KEY = "HOSTNAME_SEQ";
const HOSTNAME_APPS_KEY = "HOSTNAME_APPLICATIONS";
export const DEFAULT_HOSTNAME_FORMAT = "{os}-{app}-{rand4}";
export const DEFAULT_HOSTNAME_APPLICATIONS = ["web", "db", "docker", "api", "cache", "queue", "app", "worker"];

let packages = [];
let applicationRoles = [];
let containerTemplates = [];
let stackTemplates = [];
let workflowTemplates = [];
let templateDefaults = {};
let instanceSizes = [];
let hostnameFormat = DEFAULT_HOSTNAME_FORMAT;
let hostnameSeq = 1;
let hostnameApplications = [...DEFAULT_HOSTNAME_APPLICATIONS];

export async function hydrateCatalog() {
  const [pkgRows, roleRows, tplRows, wfRows, defRows, sizeRows] = await Promise.all([
    prisma.package.findMany({ orderBy: { sortOrder: "asc" } }),
    prisma.applicationRole.findMany({ orderBy: { sortOrder: "asc" } }),
    prisma.catalogTemplate.findMany({ where: { enabled: true } }),
    prisma.workflowTemplate.findMany({
      where: { enabled: true },
      include: { steps: { orderBy: { sortOrder: "asc" } } },
    }),
    prisma.templateDefault.findMany(),
    prisma.instanceSize.findMany({ orderBy: { sortOrder: "asc" } }),
  ]);

  packages = pkgRows;
  applicationRoles = roleRows.map(normalizeRoleRow);
  containerTemplates = tplRows.filter((t) => t.kind === "container");
  stackTemplates = tplRows.filter((t) => t.kind === "stack");
  workflowTemplates = wfRows;
  templateDefaults = {};
  for (const row of defRows) templateDefaults[row.presetKey] = row.items;
  instanceSizes = sizeRows;
  await hydrateHostnameFormat();
}

function normalizeRoleRow(row) {
  const options = Array.isArray(row.options)
    ? row.options.map(String)
    : (typeof row.options === "string" ? JSON.parse(row.options || "[]") : []);
  return {
    id: row.id,
    label: row.label,
    selection: row.selection || "multi",
    allowMultiOverride: !!row.allowMultiOverride,
    defaultOptionId: row.defaultOptionId || null,
    options,
    enabled: row.enabled !== false,
    sortOrder: row.sortOrder || 0,
  };
}

export function listInstanceSizes() {
  return instanceSizes.filter((s) => s.enabled);
}

/** Resolve a size key to its { cpu, memoryGB }, or null if unknown/custom. */
export function resolveInstanceSize(key) {
  if (!key) return null;
  const s = instanceSizes.find((x) => x.key === String(key).toLowerCase() && x.enabled);
  return s ? { cpu: s.cpu, memoryGB: s.memoryGB } : null;
}

export function listPackageIds() {
  return packages.filter((p) => p.enabled).map((p) => p.id);
}

export function listPackages() {
  return packages.filter((p) => p.enabled);
}

export function listCatalogPackages() {
  return listPackages().map((p) => ({
    id: p.id,
    name: p.name,
    category: p.category || "Uncategorized",
    description: p.description || null,
    installPkg: p.installPkg || p.id,
    hostnameCode: p.hostnameCode || null,
    isDefault: !!p.isDefault,
  }));
}

export function listApplicationRoles() {
  return applicationRoles.filter((r) => r.enabled);
}

export function getApplicationRole(id) {
  if (!id) return null;
  return applicationRoles.find((r) => r.id === id) || null;
}

/**
 * Resolve the hostname {app} token from role + selected role packages.
 * Exactly one selected option with hostnameCode → that code; else role id.
 */
export function resolveApplicationAppToken(roleId, selectedPackageIds = []) {
  const role = getApplicationRole(roleId) || { id: roleId || "", options: [] };
  const roleOpts = new Set(role.options || []);
  const picked = (Array.isArray(selectedPackageIds) ? selectedPackageIds : [])
    .map(String)
    .filter((id) => roleOpts.has(id));
  if (picked.length === 1) {
    const pkg = packageById(picked[0]);
    const code = (pkg?.hostnameCode || "").trim();
    if (code) return code;
  }
  return role.id || roleId || "";
}

/**
 * Resolve {app} for hostname suggestion from wizard selections:
 * 1) Application-role package (hostnameCode) when exactly one role option is picked
 * 2) Single blueprint / stack id when exactly one is selected
 * 3) Single extra package with hostnameCode
 * 4) Application role id
 * 5) First blueprint id, else first package hostnameCode/id
 */
export function resolveHostnameAppToken({
  roleId = "",
  rolePackages = [],
  packages = [],
  apps = [],
} = {}) {
  const roleToken = roleId ? resolveApplicationAppToken(roleId, rolePackages) : "";
  const role = getApplicationRole(roleId);
  const roleOpts = new Set(role?.options || []);
  const rolePicked = (Array.isArray(rolePackages) ? rolePackages : [])
    .map(String)
    .filter((id) => roleOpts.has(id));

  // Prefer a concrete package code from the application role (page 1).
  if (rolePicked.length === 1) {
    const code = (packageById(rolePicked[0])?.hostnameCode || "").trim();
    if (code) return code;
  }

  const blueprintIds = (Array.isArray(apps) ? apps : []).map(String).filter(Boolean);
  if (blueprintIds.length === 1) return slugPart(blueprintIds[0], blueprintIds[0]);

  const pkgIds = (Array.isArray(packages) ? packages : [])
    .map(String)
    .filter((id) => id && !roleOpts.has(id));
  const coded = pkgIds
    .map((id) => ({ id, code: (packageById(id)?.hostnameCode || "").trim() }))
    .filter((x) => x.code);
  if (coded.length === 1) return coded[0].code;

  if (roleToken) return roleToken;
  if (blueprintIds.length) return slugPart(blueprintIds[0], blueprintIds[0]);
  if (coded.length) return coded[0].code;
  if (pkgIds.length) return slugPart(pkgIds[0], pkgIds[0]);
  return "";
}

export function getDefaultPackages() {
  return listPackages().filter((p) => p.isDefault);
}

export function resolveInstallPkg(packageId) {
  const p = packages.find((x) => x.id === packageId);
  return p?.installPkg || packageId;
}

export function packageById(packageId) {
  return packages.find((x) => x.id === packageId) || null;
}

/** @deprecated use getDefaultPackages() */
export function listBaselines() {
  return getDefaultPackages().map((p) => ({
    id: p.id,
    name: p.name,
    pkg: p.installPkg || p.id,
    enabled: p.enabled,
  }));
}

/** @deprecated use getDefaultPackages() */
export function getDefaultAgents() {
  return getDefaultPackages().map((p) => ({
    id: p.id,
    name: p.name,
    pkg: resolveInstallPkg(p.id),
  }));
}

export function getDefaultPackagesLabel() {
  const names = getDefaultPackages().map((p) => p.name);
  if (!names.length) return "Default packages";
  return `Default packages — ${names.join(", ")}`;
}

export function listContainerTemplates() {
  return containerTemplates.map(templateRowToCatalog);
}

export function listStackTemplates() {
  return stackTemplates.map(templateRowToCatalog);
}

function templateRowToCatalog(row) {
  const config = row.config || {};
  return {
    id: row.id,
    name: row.name,
    vmid: row.vmid,
    type: row.type || row.kind,
    defaultUser: row.defaultUser,
    osFamily: row.osFamily,
    description: config.description || "",
    ...config,
  };
}

export function resolveVmTemplate(templateId) {
  if (typeof templateId === "string" && /^tpl-\d+$/.test(templateId)) {
    const vmid = templateId.slice(4);
    const m = getTemplateMappings()[vmid];
    if (m) return { id: templateId, vmid: Number(vmid), name: m.osName || `template-${vmid}`, osName: m.osName };
  }
  const internal = workflowTemplates.find((t) => t.id === templateId);
  if (internal) return { id: internal.id, name: internal.name, osName: internal.osName };
  return null;
}

export function findVmTemplate(templateId) {
  return resolveVmTemplate(templateId);
}

export function findContainerTemplate(id) {
  return listContainerTemplates().find((t) => t.id === id) || null;
}

export function findStack(id) {
  return listStackTemplates().find((s) => s.id === id) || null;
}

export function findInternalTemplate(id) {
  const wf = workflowTemplates.find((t) => t.id === id);
  if (!wf) return null;
  return workflowToInternalTemplate(wf);
}

export function isInternalTemplateId(id) {
  return typeof id === "string" && (id.startsWith("internal-") || workflowTemplates.some((w) => w.id === id));
}

function workflowToInternalTemplate(wf) {
  const workflow = (wf.steps || []).map((s) => ({
    key: s.key,
    stage: s.stage,
    label: s.label,
    via: s.via,
    system: s.system,
    kind: s.kind,
  }));
  const stages = [...new Set(workflow.map((s) => s.stage))];
  return {
    id: wf.id,
    name: wf.name,
    provider: wf.provider || "internal",
    osName: wf.osName,
    description: wf.description,
    workflow,
    stages: stages.length ? stages : INTERNAL_STAGES,
  };
}

export function internalVmTemplates() {
  return [];
}

// VM templates exposed to users are driven by admin template mappings.
export function mappedVmTemplates() {
  const map = getTemplateMappings();
  return Object.entries(map)
    .filter(([, m]) => m.osName && String(m.osName).trim())
    .map(([vmid, m]) => ({
      id: `tpl-${vmid}`,
      vmid: Number(vmid),
      name: m.osName,
      osName: m.osName,
      type: "vm",
      defaultUser: m.credUser || "root",
      connectivity: m.connectivity || "ssh",
      port: m.port || null,
      packageManager: m.packageManager || null,
      cloudInitFile: m.cloudInitFile || null,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function getTemplateDefaults() {
  return templateDefaults;
}

export function defaultsForTemplate(tpl = {}) {
  const defaults = templateDefaults;
  const cands = [tpl.name, tpl.id, tpl.osName].filter(Boolean).map((s) => String(s).toLowerCase());
  for (const [key, val] of Object.entries(defaults)) {
    if (key === "default" || key === "*") continue;
    const k = key.toLowerCase();
    if (cands.some((c) => c === k || c.includes(k) || k.includes(c))) {
      return Array.isArray(val) ? val : [];
    }
  }
  const fallback = defaults.default || defaults["*"];
  return Array.isArray(fallback) ? fallback : [];
}

export function withTemplateDefaults(list) {
  return list.map((t) => ({ ...t, defaultPackages: defaultsForTemplate(t) }));
}

// --- Admin CRUD ---

function badRequest(message) {
  return Object.assign(new Error(message), { status: 400 });
}

/** Validate hostnameCode uniqueness across packages (excluding packageId). */
async function assertUniqueHostnameCode(code, packageId) {
  if (!code) return;
  const clash = await prisma.package.findFirst({
    where: {
      hostnameCode: code,
      NOT: { id: packageId },
    },
    select: { id: true, name: true },
  });
  if (clash) {
    throw badRequest(
      `Hostname code “${code}” is already used by package “${clash.id}”. Each code must be unique.`,
    );
  }
}

/**
 * Validate application role options against the package catalog.
 * @param {{ options: string[], defaultOptionId: string|null, enabled: boolean, selection: string }} role
 */
async function assertValidRolePackages(role) {
  const options = [...new Set((role.options || []).map((x) => String(x).trim()).filter(Boolean))];
  if (role.enabled && options.length === 0) {
    throw badRequest("Enabled roles need at least one package option.");
  }
  if (!options.length) return options;

  const rows = await prisma.package.findMany({
    where: { id: { in: options } },
    select: { id: true, enabled: true },
  });
  const found = new Map(rows.map((r) => [r.id, r]));
  const unknown = options.filter((id) => !found.has(id));
  if (unknown.length) {
    throw badRequest(`Unknown package id(s): ${unknown.join(", ")}. Add them under Packages first.`);
  }
  const disabled = options.filter((id) => found.get(id) && !found.get(id).enabled);
  if (disabled.length) {
    throw badRequest(`Disabled package id(s) cannot be role options: ${disabled.join(", ")}.`);
  }
  if (role.defaultOptionId && !options.includes(role.defaultOptionId)) {
    throw badRequest(`Default option “${role.defaultOptionId}” must be one of the role options.`);
  }
  if (role.selection === "single" && role.defaultOptionId && options.length === 0) {
    throw badRequest("Single-select roles need options before setting a default.");
  }
  return options;
}

/** Catalog health checks for admin UI (non-blocking warnings). */
export async function validateCatalog() {
  const [pkgs, roles] = await Promise.all([
    prisma.package.findMany({ select: { id: true, name: true, enabled: true, hostnameCode: true } }),
    prisma.applicationRole.findMany(),
  ]);
  const issues = [];
  const byCode = new Map();
  for (const p of pkgs) {
    const code = (p.hostnameCode || "").trim().toLowerCase();
    if (!code) continue;
    if (!byCode.has(code)) byCode.set(code, []);
    byCode.get(code).push(p.id);
  }
  for (const [code, ids] of byCode) {
    if (ids.length > 1) {
      issues.push({
        severity: "error",
        code: "duplicate_hostname_code",
        message: `Hostname code “${code}” is shared by: ${ids.join(", ")}`,
        packageIds: ids,
      });
    }
  }

  const pkgMap = new Map(pkgs.map((p) => [p.id, p]));
  for (const role of roles) {
    const opts = Array.isArray(role.options) ? role.options : [];
    const options = opts.map((x) => String(x)).filter(Boolean);
    if (role.enabled && options.length === 0) {
      issues.push({
        severity: "error",
        code: "empty_role_options",
        message: `Role “${role.id}” is enabled but has no package options`,
        roleId: role.id,
      });
    }
    const unknown = options.filter((id) => !pkgMap.has(id));
    if (unknown.length) {
      issues.push({
        severity: "error",
        code: "unknown_role_packages",
        message: `Role “${role.id}” references unknown packages: ${unknown.join(", ")}`,
        roleId: role.id,
        packageIds: unknown,
      });
    }
    const disabled = options.filter((id) => pkgMap.get(id) && !pkgMap.get(id).enabled);
    if (disabled.length) {
      issues.push({
        severity: "warn",
        code: "disabled_role_packages",
        message: `Role “${role.id}” references disabled packages: ${disabled.join(", ")}`,
        roleId: role.id,
        packageIds: disabled,
      });
    }
    if (role.defaultOptionId && options.length && !options.includes(role.defaultOptionId)) {
      issues.push({
        severity: "error",
        code: "invalid_default_option",
        message: `Role “${role.id}” default “${role.defaultOptionId}” is not in its options`,
        roleId: role.id,
      });
    }
  }

  return {
    ok: !issues.some((i) => i.severity === "error"),
    issueCount: issues.length,
    issues,
  };
}

export async function adminListPackages() {
  return prisma.package.findMany({ orderBy: { sortOrder: "asc" } });
}

export async function adminUpsertPackage(data) {
  const payload = {
    id: String(data.id || "").trim(),
    name: String(data.name || data.id || "").trim(),
    category: data.category != null ? String(data.category).trim() || null : undefined,
    description: data.description != null ? (String(data.description).trim() || null) : undefined,
    installPkg: data.installPkg != null ? (String(data.installPkg).trim() || null) : undefined,
    installCmd: data.installCmd != null ? (String(data.installCmd).trim() || null) : undefined,
    hostnameCode: data.hostnameCode != null ? (String(data.hostnameCode).trim().toLowerCase() || null) : undefined,
    isDefault: data.isDefault != null ? !!data.isDefault : undefined,
    enabled: data.enabled != null ? !!data.enabled : undefined,
    sortOrder: data.sortOrder != null ? Number(data.sortOrder) : undefined,
  };
  if (!payload.id) throw badRequest("Package id is required");
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(payload.id)) {
    throw badRequest("Package id must be alphanumeric (plus . _ -), max 64 chars.");
  }
  if (payload.hostnameCode != null) {
    await assertUniqueHostnameCode(payload.hostnameCode, payload.id);
  }
  const create = {
    id: payload.id,
    name: payload.name || payload.id,
    category: payload.category ?? "Uncategorized",
    description: payload.description ?? null,
    installPkg: payload.installPkg ?? null,
    installCmd: payload.installCmd ?? null,
    hostnameCode: payload.hostnameCode ?? null,
    isDefault: payload.isDefault ?? false,
    enabled: payload.enabled ?? true,
    sortOrder: Number.isFinite(payload.sortOrder) ? payload.sortOrder : 0,
  };
  const update = {};
  for (const [k, v] of Object.entries(payload)) {
    if (k === "id") continue;
    if (v !== undefined) update[k] = v;
  }
  const row = await prisma.package.upsert({
    where: { id: payload.id },
    create,
    update,
  });
  await hydrateCatalog();
  return row;
}

export async function adminDeletePackage(id) {
  const pkgId = String(id);
  const roles = await prisma.applicationRole.findMany({ select: { id: true, options: true } });
  const usedBy = roles
    .filter((r) => Array.isArray(r.options) && r.options.map(String).includes(pkgId))
    .map((r) => r.id);
  if (usedBy.length) {
    throw badRequest(
      `Cannot remove “${pkgId}” — it is used by App role(s): ${usedBy.join(", ")}. Remove it from those roles first.`,
    );
  }
  await prisma.package.delete({ where: { id: pkgId } });
  await hydrateCatalog();
}

export async function adminListApplicationRoles() {
  const rows = await prisma.applicationRole.findMany({ orderBy: { sortOrder: "asc" } });
  return rows.map(normalizeRoleRow);
}

export async function adminUpsertApplicationRole(data) {
  const id = String(data.id || "").trim().toLowerCase();
  if (!id) throw badRequest("Role id is required");
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(id)) {
    throw badRequest("Role id must start with a letter and use a-z, 0-9, _ or - (max 32).");
  }
  const selection = String(data.selection || "multi").toLowerCase();
  if (!["single", "multi", "bundle", "suggest"].includes(selection)) {
    throw badRequest("selection must be single, multi, bundle, or suggest");
  }
  const rawOptions = Array.isArray(data.options)
    ? data.options.map((x) => String(x).trim()).filter(Boolean)
    : String(data.options || "").split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean);
  const enabled = data.enabled !== false;
  const defaultOptionId = data.defaultOptionId ? String(data.defaultOptionId).trim() : null;
  const options = await assertValidRolePackages({
    options: rawOptions,
    defaultOptionId,
    enabled,
    selection,
  });
  const payload = {
    id,
    label: String(data.label || id).trim(),
    selection,
    allowMultiOverride: !!data.allowMultiOverride,
    defaultOptionId,
    options,
    enabled,
    sortOrder: Number.isFinite(Number(data.sortOrder)) ? Number(data.sortOrder) : 0,
  };
  const row = await prisma.applicationRole.upsert({
    where: { id },
    create: payload,
    update: payload,
  });
  await hydrateCatalog();
  await syncHostnameApplicationsFromRoles();
  return normalizeRoleRow(row);
}

export async function adminDeleteApplicationRole(id) {
  await prisma.applicationRole.delete({ where: { id: String(id) } });
  await hydrateCatalog();
  await syncHostnameApplicationsFromRoles();
}

export async function adminListBaselines() {
  return prisma.securityBaselineAgent.findMany({ orderBy: { sortOrder: "asc" } });
}

export async function adminUpsertBaseline(data) {
  const row = await prisma.securityBaselineAgent.upsert({
    where: { id: data.id },
    create: data,
    update: data,
  });
  await hydrateCatalog();
  return row;
}

export async function adminDeleteBaseline(id) {
  await prisma.securityBaselineAgent.delete({ where: { id } });
  await hydrateCatalog();
}

export async function adminListWorkflows() {
  return prisma.workflowTemplate.findMany({
    include: { steps: { orderBy: { sortOrder: "asc" } } },
  });
}

export async function adminUpsertWorkflow({ id, name, provider, description, osName, enabled, steps = [] }) {
  await prisma.workflowStep.deleteMany({ where: { workflowId: id } });
  const row = await prisma.workflowTemplate.upsert({
    where: { id },
    create: { id, name, provider, description, osName, enabled: enabled !== false },
    update: { name, provider, description, osName, enabled: enabled !== false },
  });
  if (steps.length) {
    await prisma.workflowStep.createMany({
      data: steps.map((s, i) => ({
        id: s.id || `${id}-${s.key}`,
        workflowId: id,
        key: s.key,
        stage: s.stage,
        label: s.label,
        via: s.via || null,
        system: s.system || null,
        kind: s.kind || null,
        sortOrder: s.sortOrder ?? i,
      })),
    });
  }
  await hydrateCatalog();
  return row;
}

export async function adminDeleteWorkflow(id) {
  await prisma.workflowTemplate.delete({ where: { id } });
  await hydrateCatalog();
}

export async function adminListCatalogTemplates(kind) {
  return prisma.catalogTemplate.findMany({
    where: kind ? { kind } : undefined,
    orderBy: { name: "asc" },
  });
}

export async function adminUpsertCatalogTemplate(data) {
  const row = await prisma.catalogTemplate.upsert({
    where: { id: data.id },
    create: data,
    update: data,
  });
  await hydrateCatalog();
  return row;
}

export async function adminDeleteCatalogTemplate(id) {
  await prisma.catalogTemplate.delete({ where: { id } });
  await hydrateCatalog();
}

export async function adminListTemplateDefaults() {
  return prisma.templateDefault.findMany();
}

export async function adminUpsertTemplateDefault(presetKey, items) {
  const row = await prisma.templateDefault.upsert({
    where: { presetKey },
    create: { presetKey, items },
    update: { items },
  });
  await hydrateCatalog();
  return row;
}

export async function adminDeleteTemplateDefault(presetKey) {
  await prisma.templateDefault.delete({ where: { presetKey } });
  await hydrateCatalog();
}

export async function adminListInstanceSizes() {
  return prisma.instanceSize.findMany({ orderBy: { sortOrder: "asc" } });
}

export async function adminUpsertInstanceSize(data) {
  const key = String(data.key).toLowerCase().trim();
  const payload = {
    key,
    label: data.label || key,
    cpu: Number(data.cpu) || 1,
    memoryGB: Number(data.memoryGB) || 1,
    sortOrder: Number(data.sortOrder) || 0,
    enabled: data.enabled !== false,
  };
  const row = await prisma.instanceSize.upsert({
    where: { key },
    create: payload,
    update: payload,
  });
  await hydrateCatalog();
  return row;
}

export async function adminDeleteInstanceSize(key) {
  await prisma.instanceSize.delete({ where: { key: String(key).toLowerCase() } });
  await hydrateCatalog();
}

// --- Hostname format (Admin → Catalog → Hostname) ---

export async function hydrateHostnameFormat() {
  const [fmt, seq, apps] = await Promise.all([
    prisma.setting.findUnique({ where: { key: HOSTNAME_FORMAT_KEY } }),
    prisma.setting.findUnique({ where: { key: HOSTNAME_SEQ_KEY } }),
    prisma.setting.findUnique({ where: { key: HOSTNAME_APPS_KEY } }),
  ]);
  const nextFmt = String(fmt?.value || DEFAULT_HOSTNAME_FORMAT).trim();
  hostnameFormat = nextFmt || DEFAULT_HOSTNAME_FORMAT;
  const n = Number(seq?.value);
  hostnameSeq = Number.isFinite(n) && n > 0 ? Math.floor(n) : 1;
  hostnameApplications = parseApplicationList(apps?.value);
}

function parseApplicationList(raw) {
  const list = String(raw || "")
    .split(/[,;\n]+/)
    .map((s) => slugPart(s.trim(), ""))
    .filter(Boolean);
  const unique = [...new Set(list)];
  return unique.length ? unique : [...DEFAULT_HOSTNAME_APPLICATIONS];
}

export function getHostnameApplications() {
  return [...hostnameApplications];
}

export function getHostnameFormat() {
  return hostnameFormat || DEFAULT_HOSTNAME_FORMAT;
}

export function getHostnameFormatInfo() {
  const roleApps = listApplicationRoles().map((r) => r.id);
  return {
    format: getHostnameFormat(),
    defaultFormat: DEFAULT_HOSTNAME_FORMAT,
    applications: getHostnameApplications(),
    defaultApplications: [...DEFAULT_HOSTNAME_APPLICATIONS],
    roleApplications: roleApps,
    tokens: [
      { token: "{os}", meaning: "OS / template slug (e.g. ubuntu)" },
      { token: "{app}", meaning: "Application role (web, db, docker, …) — synced from App roles when roles change" },
      { token: "{kind}", meaning: "vm, ct, or stack" },
      { token: "{user}", meaning: "Requester username" },
      { token: "{env}", meaning: "Short environment code (≤3 chars: production→prd, staging→stg, …)" },
      { token: "{envFull}", meaning: "Full environment / network label (slug)" },
      { token: "{rand}", meaning: "Random 4-char suffix" },
      { token: "{rand4}", meaning: "Random 4-char suffix" },
      { token: "{rand6}", meaning: "Random 6-char suffix" },
      { token: "{n}", meaning: "Sequential number (1, 2, …)" },
      { token: "{nn}", meaning: "Sequential, 2-digit padded" },
      { token: "{nnn}", meaning: "Sequential, 3-digit padded" },
    ],
  };
}

/** Keep hostname {app} options aligned with enabled Application roles. */
export async function syncHostnameApplicationsFromRoles() {
  const roles = await prisma.applicationRole.findMany({
    where: { enabled: true },
    orderBy: { sortOrder: "asc" },
    select: { id: true },
  });
  const ids = roles.map((r) => String(r.id).trim().toLowerCase()).filter(Boolean);
  if (!ids.length) return getHostnameFormatInfo();
  const value = ids.join(",");
  await prisma.setting.upsert({
    where: { key: HOSTNAME_APPS_KEY },
    create: { key: HOSTNAME_APPS_KEY, value },
    update: { value },
  });
  hostnameApplications = [...ids];
  return getHostnameFormatInfo();
}

export async function setHostnameFormat(format, { applications } = {}) {
  const cleaned = String(format || "").trim() || DEFAULT_HOSTNAME_FORMAT;
  // Keep hostnames DNS-safe-ish: letters, digits, hyphen, underscore, tokens
  if (!/^[-a-zA-Z0-9_{}]+$/.test(cleaned)) {
    const err = new Error("Format may only use letters, digits, hyphens, underscores, and {tokens}");
    err.status = 400;
    throw err;
  }
  await prisma.setting.upsert({
    where: { key: HOSTNAME_FORMAT_KEY },
    create: { key: HOSTNAME_FORMAT_KEY, value: cleaned },
    update: { value: cleaned },
  });
  hostnameFormat = cleaned;

  if (applications != null) {
    const list = Array.isArray(applications)
      ? applications.map((a) => slugPart(String(a), "")).filter(Boolean)
      : parseApplicationList(applications);
    const unique = [...new Set(list)];
    const value = (unique.length ? unique : DEFAULT_HOSTNAME_APPLICATIONS).join(",");
    await prisma.setting.upsert({
      where: { key: HOSTNAME_APPS_KEY },
      create: { key: HOSTNAME_APPS_KEY, value },
      update: { value },
    });
    hostnameApplications = parseApplicationList(value);
  }

  return getHostnameFormatInfo();
}

function slugPart(value, fallback = "host") {
  const s = String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
  return s || fallback;
}

function randomChars(len) {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < len; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

function takeHostnameSeq(width) {
  const n = hostnameSeq++;
  fireAndForget(
    prisma.setting.upsert({
      where: { key: HOSTNAME_SEQ_KEY },
      create: { key: HOSTNAME_SEQ_KEY, value: String(hostnameSeq) },
      update: { value: String(hostnameSeq) },
    }),
    "hostname-seq"
  );
  return String(n).padStart(width, "0");
}

function resolveEnvLabel(env) {
  const raw = String(env || "").trim();
  if (!raw) return "dev";
  try {
    const nets = getNetworkMappings() || {};
    if (nets[raw]?.label) return String(nets[raw].label).trim() || raw;
    const hit = Object.values(nets).find((m) => String(m.label || "").toLowerCase() === raw.toLowerCase());
    if (hit?.label) return String(hit.label).trim();
  } catch {
    /* mappings not hydrated yet */
  }
  return raw;
}

/**
 * Build a hostname from the admin format.
 * ctx: { os, kind, user, env, app, templateId, templateName }
 */
export function formatHostname(ctx = {}, format = getHostnameFormat()) {
  const kind = slugPart(ctx.kind || "vm", "vm");
  const os = slugPart(ctx.os || ctx.templateName || ctx.templateId || kind, kind);
  const user = slugPart(ctx.user || "user", "user");
  const envRaw = resolveEnvLabel(ctx.env || ctx.environment || "dev");
  const envFull = slugPart(envRaw, "dev");
  const env = shortEnvCode(envRaw);
  const app = slugPart(ctx.app || ctx.application || "", "");
  let out = String(format || DEFAULT_HOSTNAME_FORMAT);
  out = out.replace(/\{rand6\}/gi, () => randomChars(6));
  out = out.replace(/\{rand4\}/gi, () => randomChars(4));
  out = out.replace(/\{rand\}/gi, () => randomChars(4));
  out = out.replace(/\{nnn\}/gi, () => takeHostnameSeq(3));
  out = out.replace(/\{nn\}/gi, () => takeHostnameSeq(2));
  out = out.replace(/\{n\}/gi, () => takeHostnameSeq(1));
  out = out.replace(/\{os\}/gi, os);
  out = out.replace(/\{app\}/gi, app);
  out = out.replace(/\{application\}/gi, app);
  out = out.replace(/\{kind\}/gi, kind === "container" ? "ct" : kind);
  out = out.replace(/\{user\}/gi, user);
  out = out.replace(/\{envFull\}/gi, envFull);
  out = out.replace(/\{env\}/gi, env);
  out = out.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "");
  return out.slice(0, 63) || `${os}-${app || "host"}-${randomChars(4)}`;
}

/** Preview without consuming the sequential counter. */
export function previewHostname(format, ctx = {}) {
  const kind = slugPart(ctx.kind || "vm", "vm");
  const os = slugPart(ctx.os || "ubuntu", "ubuntu");
  const user = slugPart(ctx.user || "admin", "admin");
  const envRaw = resolveEnvLabel(ctx.env || ctx.environment || "dev");
  const envFull = slugPart(envRaw, "dev");
  const env = shortEnvCode(envRaw);
  const app = slugPart(ctx.app || ctx.application || "", "");
  let out = String(format || DEFAULT_HOSTNAME_FORMAT);
  out = out.replace(/\{rand6\}/gi, "x7k2p9");
  out = out.replace(/\{rand4\}/gi, "a3f9");
  out = out.replace(/\{rand\}/gi, "a3f9");
  out = out.replace(/\{nnn\}/gi, String(hostnameSeq).padStart(3, "0"));
  out = out.replace(/\{nn\}/gi, String(hostnameSeq).padStart(2, "0"));
  out = out.replace(/\{n\}/gi, String(hostnameSeq));
  out = out.replace(/\{os\}/gi, os);
  out = out.replace(/\{app\}/gi, app);
  out = out.replace(/\{application\}/gi, app);
  out = out.replace(/\{kind\}/gi, kind === "container" ? "ct" : kind);
  out = out.replace(/\{user\}/gi, user);
  out = out.replace(/\{envFull\}/gi, envFull);
  out = out.replace(/\{env\}/gi, env);
  return out.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "").slice(0, 63);
}
