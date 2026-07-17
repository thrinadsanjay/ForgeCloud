import { prisma, fireAndForget } from "../db/client.js";
import { getTemplateMappings } from "./mappingStore.js";

const INTERNAL_STAGES = ["Preparation", "Provisioning", "Post actions"];
const HOSTNAME_FORMAT_KEY = "HOSTNAME_FORMAT";
const HOSTNAME_SEQ_KEY = "HOSTNAME_SEQ";
const HOSTNAME_APPS_KEY = "HOSTNAME_APPLICATIONS";
export const DEFAULT_HOSTNAME_FORMAT = "{os}-{app}-{rand4}";
export const DEFAULT_HOSTNAME_APPLICATIONS = ["web", "db", "docker", "api", "cache", "queue", "app", "worker"];

let packages = [];
let containerTemplates = [];
let stackTemplates = [];
let workflowTemplates = [];
let templateDefaults = {};
let instanceSizes = [];
let hostnameFormat = DEFAULT_HOSTNAME_FORMAT;
let hostnameSeq = 1;
let hostnameApplications = [...DEFAULT_HOSTNAME_APPLICATIONS];

export async function hydrateCatalog() {
  const [pkgRows, tplRows, wfRows, defRows, sizeRows] = await Promise.all([
    prisma.package.findMany({ orderBy: { sortOrder: "asc" } }),
    prisma.catalogTemplate.findMany({ where: { enabled: true } }),
    prisma.workflowTemplate.findMany({
      where: { enabled: true },
      include: { steps: { orderBy: { sortOrder: "asc" } } },
    }),
    prisma.templateDefault.findMany(),
    prisma.instanceSize.findMany({ orderBy: { sortOrder: "asc" } }),
  ]);

  packages = pkgRows;
  containerTemplates = tplRows.filter((t) => t.kind === "container");
  stackTemplates = tplRows.filter((t) => t.kind === "stack");
  workflowTemplates = wfRows;
  templateDefaults = {};
  for (const row of defRows) templateDefaults[row.presetKey] = row.items;
  instanceSizes = sizeRows;
  await hydrateHostnameFormat();
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
    category: p.category,
    installPkg: p.installPkg || p.id,
    isDefault: !!p.isDefault,
  }));
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

export async function adminListPackages() {
  return prisma.package.findMany({ orderBy: { sortOrder: "asc" } });
}

export async function adminUpsertPackage(data) {
  const row = await prisma.package.upsert({
    where: { id: data.id },
    create: data,
    update: data,
  });
  await hydrateCatalog();
  return row;
}

export async function adminDeletePackage(id) {
  await prisma.package.delete({ where: { id } });
  await hydrateCatalog();
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
  return {
    format: getHostnameFormat(),
    defaultFormat: DEFAULT_HOSTNAME_FORMAT,
    applications: getHostnameApplications(),
    defaultApplications: [...DEFAULT_HOSTNAME_APPLICATIONS],
    tokens: [
      { token: "{os}", meaning: "OS / template slug (e.g. ubuntu)" },
      { token: "{app}", meaning: "Application role (web, db, docker, …)" },
      { token: "{kind}", meaning: "vm, ct, or stack" },
      { token: "{user}", meaning: "Requester username" },
      { token: "{env}", meaning: "Environment / network name" },
      { token: "{rand}", meaning: "Random 4-char suffix" },
      { token: "{rand4}", meaning: "Random 4-char suffix" },
      { token: "{rand6}", meaning: "Random 6-char suffix" },
      { token: "{n}", meaning: "Sequential number (1, 2, …)" },
      { token: "{nn}", meaning: "Sequential, 2-digit padded" },
      { token: "{nnn}", meaning: "Sequential, 3-digit padded" },
    ],
  };
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

/**
 * Build a hostname from the admin format.
 * ctx: { os, kind, user, env, app, templateId, templateName }
 */
export function formatHostname(ctx = {}, format = getHostnameFormat()) {
  const kind = slugPart(ctx.kind || "vm", "vm");
  const os = slugPart(ctx.os || ctx.templateName || ctx.templateId || kind, kind);
  const user = slugPart(ctx.user || "user", "user");
  const env = slugPart(ctx.env || "dev", "dev");
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
  out = out.replace(/\{env\}/gi, env);
  out = out.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "");
  return out.slice(0, 63) || `${os}-${app || "host"}-${randomChars(4)}`;
}

/** Preview without consuming the sequential counter. */
export function previewHostname(format, ctx = {}) {
  const kind = slugPart(ctx.kind || "vm", "vm");
  const os = slugPart(ctx.os || "ubuntu", "ubuntu");
  const user = slugPart(ctx.user || "admin", "admin");
  const env = slugPart(ctx.env || "dev", "dev");
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
  out = out.replace(/\{env\}/gi, env);
  return out.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "").slice(0, 63);
}
