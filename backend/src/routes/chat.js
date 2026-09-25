import { Router } from "express";
import { chatWithAssist, formatAiProviderError, isAiConfigured } from "../services/aiChatService.js";
import { requireAuth } from "../middleware/auth.js";
import { getChat, saveChat, clearChat, listSessions, getSession, createSession, saveSession, deleteSession, clearAllSessions } from "../services/chatStore.js";
import {
  listPackageIds,
  listContainerTemplates,
  listStackTemplates,
  findContainerTemplate,
  findStack,
  findVmTemplate,
  listInstanceSizes,
  resolveInstanceSize,
  mappedVmTemplates,
  internalVmTemplates,
  formatHostname,
} from "../services/catalogService.js";
import { logAudit } from "../services/auditService.js";
import * as pve from "../services/proxmoxService.js";
import { removeOwner, getOwner } from "../services/ownershipStore.js";
import { submitProvisionRequest } from "../services/requestStore.js";
import { canSeeTags } from "../services/visibility.js";
import { parseTags } from "../services/tags.js";
import { getCostRates } from "../services/settingsStore.js";
import { getNetworkMappings } from "../services/mappingStore.js";
import { checkTeamQuotas } from "../services/quotaService.js";
import { looksLikeProvisionIntent, runGuidedProvision } from "../services/guidedProvision.js";

const router = Router();
router.use(requireAuth);

// --- Chat sessions (Option A: clean active chat + accessible history) ---
router.get("/chat/sessions", (req, res) => {
  res.json({ sessions: listSessions(req.user.username) });
});

router.post("/chat/sessions", (req, res) => {
  const title = typeof req.body?.title === "string" ? req.body.title : undefined;
  const session = createSession(req.user.username, { title });
  res.status(201).json({ session });
});

router.get("/chat/sessions/:id", (req, res) => {
  const session = getSession(req.user.username, req.params.id);
  if (!session) return res.status(404).json({ error: "Session not found" });
  res.json({ session });
});

router.put("/chat/sessions/:id", (req, res) => {
  const { messages, title } = req.body || {};
  if (messages != null && !Array.isArray(messages)) {
    return res.status(400).json({ error: "messages must be an array" });
  }
  const session = saveSession(req.user.username, req.params.id, { messages, title });
  if (!session) return res.status(404).json({ error: "Session not found" });
  res.json({ session });
});

router.delete("/chat/sessions/:id", (req, res) => {
  const ok = deleteSession(req.user.username, req.params.id);
  if (!ok) return res.status(404).json({ error: "Session not found" });
  res.json({ deleted: true });
});

router.delete("/chat/sessions", (req, res) => {
  clearAllSessions(req.user.username);
  res.json({ cleared: true });
});

// Legacy single-thread history (maps to newest session) — kept for compatibility.
router.get("/chat/history", (req, res) => {
  res.json({ messages: getChat(req.user.username) });
});

router.put("/chat/history", (req, res) => {
  const { messages } = req.body;
  if (!Array.isArray(messages)) {
    return res.status(400).json({ error: "messages array required" });
  }
  const saved = saveChat(req.user.username, messages);
  res.json({ messages: saved });
});

router.delete("/chat/history", (req, res) => {
  clearChat(req.user.username);
  res.json({ cleared: true });
});

const DEFAULTS = { cpu: 2, memoryGB: 2, diskGB: 50 };

const RESOURCE_ACTIONS = {
  vm: {
    reboot: pve.rebootVm,
    shutdown: pve.shutdownVm,
    delete: pve.deleteVm,
  },
  container: {
    reboot: pve.rebootContainer,
    shutdown: pve.shutdownContainer,
    delete: pve.deleteContainer,
  },
};

const WORKLOAD_PROFILES = [
  {
    re: /\b(llm|large language model|ai model|inference|finetune|fine-tune|embedding|vector db|gpu)\b/i,
    vm: { cpu: 8, memoryGB: 24, diskGB: 150 },
    container: { cpu: 6, memoryGB: 16, diskGB: 100 },
    stack: { cpu: 8, memoryGB: 24, diskGB: 150 },
  },
  {
    re: /\b(stress|load\s*test|performance\s*test|benchmark)\b/i,
    vm: { cpu: 6, memoryGB: 12, diskGB: 80 },
    container: { cpu: 4, memoryGB: 8, diskGB: 60 },
    stack: { cpu: 6, memoryGB: 12, diskGB: 100 },
  },
  {
    re: /\b(database|postgres|mysql|mariadb|mongodb|redis|elastic)\b/i,
    vm: { cpu: 4, memoryGB: 8, diskGB: 120 },
    container: { cpu: 3, memoryGB: 6, diskGB: 90 },
    stack: { cpu: 4, memoryGB: 8, diskGB: 120 },
  },
];

// Map free-text use cases to the packages a workload usually needs, so the
// proposal arrives with the right boxes pre-checked (e.g. a React app -> nodejs,
// yarn, nginx, git). Every package name here must exist in the frontend
// PACKAGE_OPTIONS list so the checkbox can render it. Matches accumulate, so
// "django app behind nginx with postgres" pulls packages from all three rules.
const PACKAGE_PROFILES = [
  { re: /\b(react|reactjs|vue|vuejs|angular|svelte|next\s?\.?\s?js|nextjs|nuxt|node\s?\.?\s?js|nodejs|express|frontend|front-end|spa|web\s?app|website|javascript|typescript|npm)\b/i, packages: ["nodejs", "yarn", "nginx", "git"] },
  { re: /\b(python|django|flask|fastapi|pandas|numpy)\b/i, packages: ["python", "git"] },
  { re: /\b(llm|large language model|ai model|inference|finetune|fine-tune|embedding|machine learning|\bml\b|pytorch|tensorflow)\b/i, packages: ["python", "docker", "git"] },
  { re: /\b(java|spring|spring\s?boot)\b/i, packages: ["openjdk", "maven", "git"] },
  { re: /(\.net|dotnet|c#|asp\.net)/i, packages: ["dotnet-sdk", "git"] },
  { re: /\b(php|laravel|symfony|wordpress)\b/i, packages: ["php", "nginx", "git"] },
  { re: /\b(go|golang)\b/i, packages: ["go", "git"] },
  { re: /\b(postgres|postgresql)\b/i, packages: ["postgres"] },
  { re: /\b(mysql|mariadb)\b/i, packages: ["mysql"] },
  { re: /\b(mongo|mongodb)\b/i, packages: ["mongodb"] },
  { re: /\b(redis|caching)\b/i, packages: ["redis"] },
  { re: /\b(rabbitmq|message queue|amqp)\b/i, packages: ["rabbitmq"] },
  { re: /\b(docker|dockeri[sz]ed|container|containers|containeri[sz]ed|microservices?|podman)\b/i, packages: ["docker", "docker-compose", "git"] },
  { re: /\b(kubernetes|k8s|k3s|helm)\b/i, packages: ["kubectl", "helm", "docker"] },
  { re: /\b(terraform|infrastructure as code|iac|ansible)\b/i, packages: ["terraform", "ansible", "git"] },
  { re: /\b(grafana|prometheus|monitoring|observability|metrics)\b/i, packages: ["grafana", "prometheus"] },
  { re: /\b(nginx|reverse proxy|load balancer|web server)\b/i, packages: ["nginx"] },
  { re: /\b(aws|s3|ec2|cloud cli)\b/i, packages: ["awscli"] },
];

// Keyword fallback for when the model doesn't return packages. Kept only as a
// safety net — the primary source is the model's own package selection, which
// understands the full conversation.
function inferPackages(message) {
  const text = message || "";
  const set = new Set();
  for (const profile of PACKAGE_PROFILES) {
    if (profile.re.test(text)) profile.packages.forEach((pkg) => set.add(pkg));
  }
  return Array.from(set);
}

// Final package list for a proposal: trust the model's selection (filtered to
// the catalog), and only fall back to keyword inference if it returned nothing.
function resolvePackages(resultArgs, message) {
  const allowed = new Set(listPackageIds());
  const raw = Array.isArray(resultArgs?.packages)
    ? resultArgs.packages.map((pkg) => String(pkg).toLowerCase().trim()).filter(Boolean)
    : [];
  const fromModel = raw.filter((pkg) => allowed.has(pkg));
  const rejected = raw.filter((pkg) => !allowed.has(pkg));
  const packages = fromModel.length ? fromModel : inferPackages(message);
  return {
    packages: Array.from(new Set(packages)),
    rejected: Array.from(new Set(rejected)),
  };
}

function suggestHostname(kind, resultArgs = {}, username = "") {
  const template =
    kind === "container" ? findContainerTemplate(resultArgs.templateId)
    : kind === "stack" ? findStack(resultArgs.stackId)
    : findVmTemplate(resultArgs.templateId);
  return formatHostname({
    kind: kind === "container" ? "ct" : kind || "vm",
    os: template?.osName || template?.name || resultArgs.templateId || kind || "vm",
    templateId: resultArgs.templateId || resultArgs.stackId,
    templateName: template?.name,
    user: username,
    env: resultArgs.environment,
    app: resultArgs.app || resultArgs.application || "",
  });
}

function hasExplicitResourceDetails(message) {
  return /\b\d+\s*(cpu|vcpu|vcpu|cores?|ram|memory|disk|gb)\b/i.test(message)
    || /\b(hostname|name|template|stack|container|lxc|vm)\b/i.test(message) && /\b\d+\b/.test(message)
    || /\b(redhat|rhel|alpine)\b/i.test(message) && /\b(cpu|ram|memory|disk|hostname)\b/i.test(message);
}

function inferRequestedKind(message) {
  const text = (message || "").toLowerCase();
  if (/\bstack\b/.test(text)) return "stack";
  if (/\b(container|lxc)\b/.test(text)) return "container";
  if (/\b(vm|virtual machine)\b/.test(text)) return "vm";
  return null;
}

function mergeIntent(args = {}, message) {
  const requestedKind = inferRequestedKind(message);
  if (!requestedKind || args.kind === requestedKind) {
    return args;
  }

  if (requestedKind === "container") {
    return {
      ...args,
      kind: "container",
      stackId: undefined,
      stackName: undefined,
      hostnamePrefix: undefined,
      diskGB: undefined,
    };
  }

  if (requestedKind === "stack") {
    return {
      ...args,
      kind: "stack",
      templateId: undefined,
      templateName: undefined,
      hostname: undefined,
    };
  }

  return {
    ...args,
    kind: "vm",
    stackId: undefined,
    stackName: undefined,
    hostnamePrefix: undefined,
  };
}

function availableVmTemplates() {
  return [...mappedVmTemplates(), ...internalVmTemplates()];
}

// Pick a catalog stack whose id/name/description best matches the message.
function inferStackFromMessage(message) {
  const stacks = listStackTemplates();
  if (!stacks.length) return null;
  const text = (message || "").toLowerCase();
  for (const stack of stacks) {
    if (stack.id && text.includes(String(stack.id).toLowerCase())) return stack.id;
  }
  for (const stack of stacks) {
    const name = String(stack.name || "").toLowerCase();
    if (name && text.includes(name)) return stack.id;
    for (const token of name.split(/[\s_-]+/).filter((t) => t.length > 2)) {
      if (new RegExp(`\\b${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(message || "")) {
        return stack.id;
      }
    }
    const desc = String(stack.description || "").toLowerCase();
    if (desc) {
      for (const token of desc.split(/[\s,_-]+/).filter((t) => t.length > 3)) {
        if (text.includes(token)) return stack.id;
      }
    }
  }
  return null;
}

function fallbackStackToVm(args, vmTemplates) {
  const templateId = args.templateId && findVmTemplate(args.templateId)
    ? args.templateId
    : vmTemplates[0]?.id;
  const next = { ...args, kind: "vm", templateId };
  delete next.stackId;
  delete next.stackName;
  delete next.hostnamePrefix;
  return next;
}

function normalizeTemplateSelection(args = {}, message = "") {
  const requestedKind = inferRequestedKind(message);
  const vmTemplates = availableVmTemplates();
  const containerTemplates = listContainerTemplates();
  const stacks = listStackTemplates();
  const kind = args.kind || requestedKind || "vm";

  if (kind === "stack") {
    if (findStack(args.stackId)) return { ...args, kind, stackId: args.stackId };
    const inferredId = inferStackFromMessage(message);
    if (inferredId && findStack(inferredId)) {
      return { ...args, kind, stackId: inferredId };
    }
    // User explicitly asked for a stack and we have catalog entries — pick the first.
    if (requestedKind === "stack" && stacks.length) {
      return { ...args, kind, stackId: stacks[0].id };
    }
    // Single-service requests (e.g. "host k3s") are VMs unless a matching stack exists.
    if (vmTemplates.length) return fallbackStackToVm(args, vmTemplates);
    return { ...args, kind };
  }

  if (kind === "container") {
    if (findContainerTemplate(args.templateId)) return { ...args, kind };
    if (requestedKind === "container" && containerTemplates.length) {
      return { ...args, kind, templateId: containerTemplates[0].id };
    }
    if (vmTemplates.length) {
      return {
        ...args,
        kind: "vm",
        templateId: args.templateId && findVmTemplate(args.templateId) ? args.templateId : vmTemplates[0].id,
      };
    }
    return { ...args, kind };
  }

  if (kind === "vm") {
    if (findVmTemplate(args.templateId)) return { ...args, kind };
    const inferredStack = inferStackFromMessage(message);
    if (inferredStack && findStack(inferredStack)) {
      return { ...args, kind: "stack", stackId: inferredStack };
    }
    if (vmTemplates.length) return { ...args, kind, templateId: vmTemplates[0].id };
  }

  return { ...args, kind };
}

function listEnvironmentOptions() {
  const nets = getNetworkMappings();
  return Object.entries(nets)
    .filter(([, m]) => m.label && String(m.label).trim())
    .map(([iface, m]) => ({ iface, label: m.label, type: m.type || "bridge" }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

// Coerce a model-supplied number; treat 0 / NaN / empty as "not set".
function positiveNumber(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

// Accept only a real network iface (or match a known label). Reject model
// placeholders like "(empty, wait for answer on network)".
function resolveEnvironment(value) {
  const envs = listEnvironmentOptions();
  if (!envs.length) return null;
  const raw = String(value || "").trim();
  if (!raw) return null;
  const byIface = envs.find((e) => e.iface.toLowerCase() === raw.toLowerCase());
  if (byIface) return byIface.iface;
  const byLabel = envs.find((e) => e.label.toLowerCase() === raw.toLowerCase());
  if (byLabel) return byLabel.iface;
  const lower = raw.toLowerCase();
  const partial = envs.find((e) => lower.includes(e.label.toLowerCase()) || e.label.toLowerCase().includes(lower));
  if (partial && raw.length < 80) return partial.iface;
  return null;
}

// Match a network label or iface mentioned in free text to its Proxmox iface.
function inferEnvironmentFromMessage(message) {
  return resolveEnvironment(inferEnvironmentFromMessageRaw(message));
}

function inferEnvironmentFromMessageRaw(message) {
  const envs = listEnvironmentOptions();
  if (!envs.length) return null;
  for (const env of envs) {
    const iface = env.iface.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`\\b${iface}\\b`, "i").test(message || "")) return env.iface;
  }
  const text = (message || "").toLowerCase();
  for (const env of envs) {
    const label = String(env.label || "").toLowerCase();
    if (label && text.includes(label)) return env.iface;
  }
  return null;
}

function applyNetworkFromMessage(args = {}, message = "") {
  const kind = args.kind || "vm";
  if (kind !== "vm") return args;
  const envs = listEnvironmentOptions();
  // Prefer an explicit valid choice from the model or the user's message.
  let environment = resolveEnvironment(args.environment) || inferEnvironmentFromMessage(message);
  // Only one labelled network exists — use it (no need to ask).
  if (!environment && envs.length === 1) environment = envs[0].iface;
  // User said "you decide" / "any" / "default" with multiple networks.
  if (!environment && envs.length > 1 && /\b(you decide|any|default|doesn't matter|doesnt matter|pick one|whichever)\b/i.test(message || "")) {
    environment = envs[0].iface;
  }
  if (!environment) {
    const next = { ...args };
    delete next.environment;
    return next;
  }
  return { ...args, environment };
}

function getSizingDefaults(message, kind) {
  const profile = WORKLOAD_PROFILES.find((p) => p.re.test(message || ""));
  if (!profile) return DEFAULTS;
  if (kind === "stack") return profile.stack;
  if (kind === "container") return profile.container;
  return profile.vm;
}

// Detect an admin-defined size named in the message (by key or label word),
// e.g. "give me a large vm" -> "large".
function inferSizeKey(message) {
  const text = (message || "").toLowerCase();
  // If the user names a light size alongside a heavy workload, do not treat that
  // size word as authoritative — the model (or workload defaults) should decide.
  const heavy = /\b(llm|large language model|ai model|inference|finetune|fine-tune|gpu|nfs|database|postgres|mysql|mongodb|elasticsearch|kubernetes|k8s|k3s)\b/i.test(text);
  const lightAsk = /\b(micro|mini|small)\b/.test(text);
  if (heavy && lightAsk) return null;

  if (/\b(extra[\s-]?large|x-?large|xl)\b/.test(text)) {
    const xl = listInstanceSizes().find((s) => s.key === "xl");
    if (xl) return "xl";
  }
  for (const s of listInstanceSizes()) {
    const key = s.key.toLowerCase();
    const label = String(s.label || "").toLowerCase();
    if (new RegExp(`\\b${key}\\b`).test(text) || (label && new RegExp(`\\b${label}\\b`).test(text))) {
      return s.key;
    }
  }
  return null;
}

// The smallest enabled size (prefer "micro"), used as the baseline when the
// user gives no size, no explicit CPU/RAM, and the workload has no special
// footprint — so proposals default to a named size instead of "Custom".
function defaultSizeKey() {
  const sizes = listInstanceSizes();
  if (!sizes.length) return null;
  const micro = sizes.find((s) => s.key === "micro");
  return (micro || sizes[0]).key;
}

function applySmartDefaults(args = {}, message) {
  const defaults = getSizingDefaults(message, args.kind);
  const profileMatched = WORKLOAD_PROFILES.some((p) => p.re.test(message || ""));
  const explicitCpu = positiveNumber(args.cpu, null);
  const explicitMem = positiveNumber(args.memoryGB, null);
  const explicitNumbers = explicitCpu != null || explicitMem != null;
  // A size (from the model or inferred from the message) sets CPU + RAM unless
  // the user gave explicit core/memory numbers. With nothing to go on, fall
  // back to the smallest size (micro) rather than raw defaults.
  let sizeKey = args.size || inferSizeKey(message);
  if (sizeKey && !resolveInstanceSize(sizeKey)) sizeKey = null;
  if (!sizeKey && !explicitNumbers && !profileMatched) {
    sizeKey = defaultSizeKey();
  }
  const sized = resolveInstanceSize(sizeKey);
  const cpu = explicitCpu ?? sized?.cpu ?? defaults.cpu ?? DEFAULTS.cpu;
  const memoryGB = explicitMem ?? sized?.memoryGB ?? defaults.memoryGB ?? DEFAULTS.memoryGB;
  // Keep the T-shirt size label only if it still matches the resolved CPU/RAM
  // (an explicit override, e.g. "make it 16 GB", drops it back to Custom).
  const size = sized && sized.cpu === cpu && sized.memoryGB === memoryGB ? sizeKey : null;
  return {
    ...args,
    size,
    cpu,
    memoryGB,
    additionalDiskGB: Number(args.additionalDiskGB) > 0 ? Math.round(Number(args.additionalDiskGB)) : 0,
  };
}

// Convert a previously-returned proposal back into resolver args, so a chat
// follow-up ("make it 16 GB", "add redis", "use large") can refine it instead
// of starting from scratch.
function proposalToArgs(p) {
  if (!p || typeof p !== "object") return null;
  const args = {
    action: "propose",
    kind: p.kind,
    templateId: p.templateId,
    stackId: p.stackId,
    hostname: p.hostname,
    hostnamePrefix: p.hostnamePrefix,
    size: p.size || undefined,
    cpu: p.cpu,
    memoryGB: p.memoryGB,
    additionalDiskGB: p.additionalDiskGB || undefined,
    environment: p.environment || undefined,
    username: p.username || undefined,
    sudoAccess: p.sudoAccess ?? undefined,
    packages: Array.isArray(p.packages) ? p.packages : undefined,
    rationale: p.rationale || undefined,
    sizeReason: p.sizeReason || undefined,
    packageNotes: p.packageNotes || undefined,
    storageNote: p.storageNote || undefined,
    ttlDays: p.ttlDays || undefined,
    permanent: p.permanent || undefined,
  };
  Object.keys(args).forEach((k) => args[k] === undefined && delete args[k]);
  return args;
}

// Merge the model's new args over the previous proposal. Fields the model
// didn't restate are carried forward; a change of resource kind starts fresh.
function applyPreviousProposal(args = {}, lastProposal) {
  const prev = proposalToArgs(lastProposal);
  if (!prev) return args;
  const kind = args.kind || prev.kind;
  if (args.kind && prev.kind && args.kind !== prev.kind) {
    return { ...args, kind };
  }
  // If the user changed CPU/RAM explicitly but not the size, drop the stale
  // size label so it doesn't contradict the new numbers.
  const next = { ...prev, ...args, kind };
  if ((args.cpu || args.memoryGB) && !args.size) delete next.size;
  return next;
}

// Monthly cost estimate for a proposal, using the admin-configured rates. The
// OS disk is included with the template; only an optional additional data disk
// adds a storage line.
function computeCost(proposal) {
  const rates = getCostRates();
  const cpu = Number(proposal.cpu) || 0;
  const memoryGB = Number(proposal.memoryGB) || 0;
  const extraDisk = proposal.kind === "container" ? 0 : (Number(proposal.additionalDiskGB) || 0);
  const cpuCost = cpu * (rates.perCpu || 0);
  const ramCost = memoryGB * (rates.perGbRam || 0);
  const storageCost = extraDisk * (rates.perGbStorage || 0);
  return {
    currency: rates.currency || "INR",
    perCpu: rates.perCpu || 0,
    perGbRam: rates.perGbRam || 0,
    perGbStorage: rates.perGbStorage || 0,
    cpuCost,
    ramCost,
    storageCost,
    total: cpuCost + ramCost + storageCost,
    hasStorage: extraDisk > 0,
  };
}

function sanitizeAdvice(text, maxLen = 600) {
  const s = String(text || "").trim().replace(/\s+/g, " ");
  if (!s) return "";
  return s.length > maxLen ? `${s.slice(0, maxLen - 1)}…` : s;
}

// Parse "for 2 days" / "1 week" / "permanent" from free text.
function inferTtlFromMessage(message) {
  const text = message || "";
  if (/\b(permanent|no expiry|indefinite|forever)\b/i.test(text)) {
    return { permanent: true, ttlDays: null };
  }
  const m = text.match(/\b(?:for|ttl|lifetime|lasting|keep(?:\s+it)?)\s+(\d+)\s*(days?|weeks?|months?|years?)\b/i)
    || text.match(/\b(\d+)\s*(days?|weeks?|months?|years?)\b/i);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = m[2].toLowerCase();
  const mult = /^day/.test(unit) ? 1
    : /^week/.test(unit) ? 7
    : /^month/.test(unit) ? 30
    : /^year/.test(unit) ? 365
    : 1;
  return { permanent: false, ttlDays: Math.min(3650, Math.max(1, Math.round(n * mult))) };
}

function applyTtl(args = {}, message = "") {
  if (args.permanent === true) return { ...args, permanent: true, ttlDays: null };
  const fromArgs = Number(args.ttlDays);
  if (Number.isFinite(fromArgs) && fromArgs > 0) {
    return { ...args, permanent: false, ttlDays: Math.min(3650, Math.round(fromArgs)) };
  }
  const inferred = inferTtlFromMessage(message);
  if (!inferred) return args;
  return { ...args, ...inferred };
}

/** Strip trailing SUGGESTIONS: a | b | c line for tap-to-reply chips. */
function extractSuggestedReplies(text) {
  if (!text) return { reply: "", suggestedReplies: [] };
  const lines = String(text).split(/\n/);
  const kept = [];
  let suggestedReplies = [];
  for (const line of lines) {
    const m = line.match(/^\s*SUGGESTIONS:\s*(.+?)\s*$/i);
    if (m) {
      suggestedReplies = m[1]
        .split("|")
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, 6);
      continue;
    }
    kept.push(line);
  }
  return { reply: kept.join("\n").trim(), suggestedReplies };
}

function attachAdvice(proposal, resultArgs = {}) {
  const rationale = sanitizeAdvice(resultArgs.rationale, 800);
  const sizeReason = sanitizeAdvice(resultArgs.sizeReason, 400);
  const packageNotes = sanitizeAdvice(resultArgs.packageNotes, 500);
  const storageNote = sanitizeAdvice(resultArgs.storageNote, 400);
  if (rationale) proposal.rationale = rationale;
  if (sizeReason) proposal.sizeReason = sizeReason;
  if (packageNotes) proposal.packageNotes = packageNotes;
  if (storageNote) proposal.storageNote = storageNote;
  // Prefer model advice as the card description when present.
  if (rationale) proposal.description = rationale;
  return proposal;
}

/** Append a cost trade-off hint for larger sizes when the model omitted it. */
function attachCostHint(proposal) {
  const cost = proposal.cost;
  if (!cost) return proposal;
  const key = String(proposal.size || "").toLowerCase();
  const heavy =
    /^(large|xl|2xl|xxl|x-?large)/.test(key) ||
    Number(proposal.cpu) >= 8 ||
    Number(proposal.memoryGB) >= 16;
  if (!heavy) return proposal;
  const money = formatMoney(cost.total, cost.currency);
  const alreadyMentionsCost = /₹|\/\s*mo|\/month|per month|approx/i.test(
    `${proposal.sizeReason || ""} ${proposal.rationale || ""}`
  );
  if (alreadyMentionsCost) return proposal;
  const hint = `At about ${money}/month this is on the higher side — Modify down if this is only a short test.`;
  proposal.sizeReason = [proposal.sizeReason, hint].filter(Boolean).join(" ");
  return proposal;
}

function attachCapabilityNotes(proposal, { rejectedPackages = [], substitutions = [] } = {}) {
  const notes = [];
  if (rejectedPackages.length) {
    notes.push(
      `Not in the package catalog (skipped): ${rejectedPackages.join(", ")}. Only listed package ids can be installed automatically.`
    );
  }
  for (const s of substitutions) {
    if (s) notes.push(s);
  }
  if (notes.length) proposal.capabilityNotes = notes.join(" ");
  return proposal;
}

function buildProposal(resultArgs = {}, message = "", { substitutions = [], username = "" } = {}) {
  const kind = resultArgs.kind;
  const { packages, rejected } = resolvePackages(resultArgs, message);
  const size = resultArgs.size || null;
  const additionalDiskGB = Number(resultArgs.additionalDiskGB) > 0 ? Math.round(Number(resultArgs.additionalDiskGB)) : 0;
  const ttl = applyTtl(resultArgs, message);
  const permanent = !!ttl.permanent;
  const ttlDays = permanent ? null : (Number(ttl.ttlDays) > 0 ? Math.round(Number(ttl.ttlDays)) : null);
  let proposal;

  if (kind === "stack") {
    const stack = findStack(resultArgs.stackId);
    proposal = {
      kind,
      stackId: resultArgs.stackId || "",
      stackName: stack?.name || resultArgs.stackId || "",
      description: stack?.description || "",
      hostnamePrefix: resultArgs.hostnamePrefix || suggestHostname("stack", resultArgs, username),
      size,
      cpu: positiveNumber(resultArgs.cpu, DEFAULTS.cpu),
      memoryGB: positiveNumber(resultArgs.memoryGB, DEFAULTS.memoryGB),
      additionalDiskGB,
      ttlDays,
      permanent,
      packages,
    };
  } else if (kind === "container") {
    const template = findContainerTemplate(resultArgs.templateId);
    proposal = {
      kind,
      templateId: resultArgs.templateId || "",
      templateName: template?.name || resultArgs.templateId || "",
      description: template?.description || "",
      hostname: resultArgs.hostname || suggestHostname("container", resultArgs, username),
      size,
      cpu: positiveNumber(resultArgs.cpu, DEFAULTS.cpu),
      memoryGB: positiveNumber(resultArgs.memoryGB, DEFAULTS.memoryGB),
      ttlDays,
      permanent,
      packages,
    };
  } else {
    const template = findVmTemplate(resultArgs.templateId);
    proposal = {
      kind: "vm",
      templateId: resultArgs.templateId || "",
      templateName: template?.name || resultArgs.templateId || "",
      description: template?.description || "",
      hostname: resultArgs.hostname || suggestHostname("vm", resultArgs, username),
      size,
      cpu: positiveNumber(resultArgs.cpu, DEFAULTS.cpu),
      memoryGB: positiveNumber(resultArgs.memoryGB, DEFAULTS.memoryGB),
      additionalDiskGB,
      environment: resolveEnvironment(resultArgs.environment) || "",
      username: resultArgs.username || "",
      sudoAccess: !!resultArgs.sudoAccess,
      ttlDays,
      permanent,
      packages,
    };
  }

  attachAdvice(proposal, resultArgs);
  proposal.cost = computeCost(proposal);
  attachCostHint(proposal);
  attachCapabilityNotes(proposal, { rejectedPackages: rejected, substitutions });
  return proposal;
}

function formatMoney(amount, currency = "INR") {
  const value = Number.isFinite(amount) ? amount : 0;
  if (currency === "INR") return `₹${value.toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
  const sym = { EUR: "€", USD: "$", GBP: "£" }[currency] || "";
  return `${sym}${value.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

// One-line spec summary shown under the assistant's reply.
function proposalSummary(proposal) {
  const sizeLabel = proposal.size ? `${proposal.size} (${proposal.cpu} CPU · ${proposal.memoryGB} GB)` : `${proposal.cpu} CPU · ${proposal.memoryGB} GB`;
  const disk = proposal.additionalDiskGB > 0 ? ` · +${proposal.additionalDiskGB} GB data disk` : "";
  return `${sizeLabel}${disk}`;
}

function formatLifetimeLabel(proposal) {
  if (proposal?.permanent) return "Permanent";
  const days = Number(proposal?.ttlDays);
  if (!Number.isFinite(days) || days <= 0) return null;
  if (days === 1) return "1 day";
  if (days % 365 === 0) return `${days / 365} year${days / 365 === 1 ? "" : "s"}`;
  if (days % 30 === 0) return `${days / 30} month${days / 30 === 1 ? "" : "s"}`;
  if (days % 7 === 0) return `${days / 7} week${days / 7 === 1 ? "" : "s"}`;
  return `${days} days`;
}

function proposalReply(proposal, { refined = false } = {}) {
  const name = proposal.kind === "stack" ? proposal.stackName : proposal.templateName;
  const kindWord = proposal.kind === "stack" ? "stack" : proposal.kind === "container" ? "container" : "VM";
  const cost = proposal.cost ? ` Estimated ${formatMoney(proposal.cost.total, proposal.cost.currency)}/month.` : "";
  const envLabel = (() => {
    if (proposal.kind !== "vm" || !proposal.environment) return "";
    const match = listEnvironmentOptions().find((e) => e.iface === proposal.environment);
    return ` Network: ${match?.label || proposal.environment}.`;
  })();
  const life = formatLifetimeLabel(proposal);
  const lifeLabel = life ? ` Lifetime: ${life}.` : "";
  const capability = proposal.capabilityNotes ? ` Note: ${proposal.capabilityNotes}` : "";
  const advice = proposal.rationale
    ? ` ${proposal.rationale}`
    : ` Here's a ${refined ? "updated " : ""}plan for the ${name || "requested"} ${kindWord} — ${proposalSummary(proposal)}.`;
  const sizeBit = proposal.sizeReason ? ` ${proposal.sizeReason}` : "";
  const pkgBit = proposal.packageNotes ? ` ${proposal.packageNotes}` : "";
  const storageBit = proposal.storageNote ? ` ${proposal.storageNote}` : "";
  return `${advice.trim()}${sizeBit}${pkgBit}${storageBit}${capability}${envLabel}${lifeLabel}${cost} Review the estimate below, then Approve to build or Modify to adjust.`.replace(/\s+/g, " ").trim();
}

function buildProvisionPayload(resultArgs = {}, message = "", username = "") {
  const kind = resultArgs.kind;
  const { packages } = resolvePackages(resultArgs, message);
  const extraDisk = Number(resultArgs.additionalDiskGB) > 0 ? Math.round(Number(resultArgs.additionalDiskGB)) : 0;
  const ttl = applyTtl(resultArgs, message);
  const permanent = !!ttl.permanent;
  const ttlDays = permanent ? undefined : (Number(ttl.ttlDays) > 0 ? Math.round(Number(ttl.ttlDays)) : undefined);

  if (kind === "stack") {
    return {
      kind,
      stackId: resultArgs.stackId,
      hostnamePrefix: resultArgs.hostnamePrefix || suggestHostname("stack", resultArgs, username),
      cpu: resultArgs.cpu || DEFAULTS.cpu,
      memoryGB: resultArgs.memoryGB || DEFAULTS.memoryGB,
      additionalDiskGB: extraDisk,
      diskGB: extraDisk,
      ttlDays,
      permanent,
      packages,
    };
  }

  if (kind === "container") {
    return {
      kind,
      templateId: resultArgs.templateId,
      hostname: resultArgs.hostname || suggestHostname("container", resultArgs, username),
      cpu: resultArgs.cpu || DEFAULTS.cpu,
      memoryGB: resultArgs.memoryGB || DEFAULTS.memoryGB,
      ttlDays,
      permanent,
      packages,
    };
  }

  return {
    kind: "vm",
    templateId: resultArgs.templateId,
    hostname: resultArgs.hostname || suggestHostname("vm", resultArgs, username),
    cpu: resultArgs.cpu || DEFAULTS.cpu,
    memoryGB: resultArgs.memoryGB || DEFAULTS.memoryGB,
    additionalDiskGB: extraDisk,
    diskGB: extraDisk,
    ttlDays,
    permanent,
    packages,
  };
}

async function startProvisioning(jobKind, payload, username) {
  const units = jobKind === "stack"
    ? Math.max(1, (payload.nodes || payload.services || payload.vms || []).length || 1)
    : 1;
  const quota = await checkTeamQuotas(username, {
    kind: jobKind,
    cpu: payload.cpu,
    memoryGB: payload.memoryGB,
    units,
  });
  if (!quota.ok) {
    const err = new Error(quota.reason);
    err.status = 403;
    throw err;
  }

  const { request, job } = await submitProvisionRequest({
    kind: jobKind,
    payload,
    requestedBy: username,
    source: "chat",
  });

  if (jobKind === "vm") {
    logAudit({ actor: { username }, action: "vm.request", target: payload.hostname, detail: { via: "chat", requestId: request.id, jobId: job?.id || null } });
  } else if (jobKind === "container") {
    logAudit({ actor: { username }, action: "container.request", target: payload.hostname, detail: { via: "chat", requestId: request.id, jobId: job?.id || null } });
  } else {
    logAudit({ actor: { username }, action: "stack.request", target: payload.hostnamePrefix, detail: { via: "chat", requestId: request.id, jobId: job?.id || null } });
  }

  return { request, job };
}

// Tag-based visibility (matches the Resources view): admins see all; others
// see resources tagged with their user tag or a group tag.
function filterByVisibility(items, user) {
  if (user.role === "admin") return items;
  return items.filter((i) => canSeeTags(i.tags, user));
}

async function listResourcesForChat(user) {
  const [allVms, allContainers] = await Promise.all([
    pve.listAllVms({}),
    pve.listAllContainers({}),
  ]);

  const norm = (item, type) => ({
    vmid: item.vmid,
    name: item.name,
    type,
    status: item.status,
    owner: getOwner(item.vmid)?.username || null,
    tags: parseTags(item.tags),
  });

  const combined = [
    ...allVms.map((v) => norm(v, "vm")),
    ...allContainers.map((c) => norm(c, "container")),
  ];

  return filterByVisibility(combined, user).sort((a, b) => a.vmid - b.vmid);
}

function resolveResourceTarget(resources, args = {}) {
  const wantedType = args.type === "vm" || args.type === "container" ? args.type : null;
  const wantedVmid = Number.isFinite(Number(args.vmid)) ? Number(args.vmid) : null;
  const wantedName = (args.name || "").trim().toLowerCase();

  let candidates = resources;
  if (wantedType) candidates = candidates.filter((r) => r.type === wantedType);
  if (wantedVmid !== null) candidates = candidates.filter((r) => r.vmid === wantedVmid);
  if (wantedName) {
    candidates = candidates.filter((r) => (r.name || "").toLowerCase() === wantedName);
    if (candidates.length === 0) {
      candidates = resources.filter((r) => (r.name || "").toLowerCase().includes(wantedName));
      if (wantedType) candidates = candidates.filter((r) => r.type === wantedType);
    }
  }

  return candidates;
}

/**
 * Build the same proposal / network-ask JSON the AI path returns, from resolver args.
 */
function respondWithProvisioningArgs(req, res, rawArgs, message, { refining = false } = {}) {
  const resolvedArgs = mergeIntent(rawArgs, message);
  const normalizedArgs = normalizeTemplateSelection(resolvedArgs, message);
  const withNetwork = applyNetworkFromMessage(normalizedArgs, message);
  let finalArgs = applySmartDefaults(withNetwork, message);
  const envOptions = listEnvironmentOptions();
  const substitutions = [];

  if (finalArgs.kind === "stack" && !findStack(finalArgs.stackId) && availableVmTemplates().length) {
    const before = finalArgs.stackId || "requested stack";
    finalArgs = fallbackStackToVm(finalArgs, availableVmTemplates());
    finalArgs = applySmartDefaults(finalArgs, message);
    const tplName = findVmTemplate(finalArgs.templateId)?.name || finalArgs.templateId;
    substitutions.push(`No matching stack "${before}" in the catalog — proposing VM "${tplName}" instead.`);
  } else if (finalArgs.kind === "container" && !findContainerTemplate(finalArgs.templateId) && availableVmTemplates().length) {
    const before = finalArgs.templateId || "requested container";
    finalArgs = fallbackStackToVm({ ...finalArgs, kind: "vm" }, availableVmTemplates());
    finalArgs = applySmartDefaults(finalArgs, message);
    const tplName = findVmTemplate(finalArgs.templateId)?.name || finalArgs.templateId;
    substitutions.push(`Container template "${before}" isn't available — proposing VM "${tplName}" instead.`);
  } else if (finalArgs.kind === "vm" && !findVmTemplate(finalArgs.templateId) && availableVmTemplates().length) {
    finalArgs = { ...finalArgs, templateId: availableVmTemplates()[0].id };
  }
  finalArgs = applyNetworkFromMessage(finalArgs, message);

  if (finalArgs.kind === "vm" && !finalArgs.environment) {
    if (!envOptions.length) {
      return res.json({
        reply: "No networks are labelled yet. Ask an admin to label a network under Mappings, then try again.",
        job: null,
        proposal: null,
        guidedDraft: null,
      });
    }
    const names = envOptions.map((e) => e.label).join(", ");
    return res.json({
      reply: `Which network should this VM use? Available: ${names}. Reply with the name (e.g. "${envOptions[0].label}").`,
      suggestedReplies: envOptions.map((e) => e.label).slice(0, 6),
      job: null,
      proposal: null,
      guidedDraft: {
        active: true,
        waiting: "network",
        kind: "vm",
        size: finalArgs.size || null,
        sizeConfirmed: !!finalArgs.size,
        templateId: finalArgs.templateId || null,
        packages: Array.isArray(finalArgs.packages) ? finalArgs.packages : [],
        packagesConfirmed: true,
        additionalDiskGB: Number(finalArgs.additionalDiskGB) || 0,
        diskConfirmed: true,
        username: finalArgs.username || null,
        usernameConfirmed: !!finalArgs.username,
        environment: null,
        ttlDays: finalArgs.ttlDays ?? null,
        permanent: !!finalArgs.permanent,
        ttlConfirmed: !!(finalArgs.permanent || finalArgs.ttlDays),
        purpose: String(message || "").slice(0, 240),
        defaultUsername: finalArgs.username || "",
      },
    });
  }

  const proposal = buildProposal(finalArgs, message, { substitutions, username: req.user.username });
  if (!proposal.templateName && !proposal.stackName && proposal.kind === "vm") {
    return res.json({
      reply: "No VM templates are configured in the catalog yet. Ask an admin to map templates in Mappings, then try again.",
      job: null,
      guidedDraft: null,
    });
  }
  const ttlChips =
    !proposal.permanent && !(Number(proposal.ttlDays) > 0)
      ? ["2 days", "1 week", "30 days", "Permanent"]
      : [];
  return res.json({
    reply: proposalReply(proposal, { refined: refining }),
    proposal,
    suggestedReplies: ttlChips,
    job: null,
    guidedDraft: null,
  });
}

function respondGuided(req, res, guided, message, lastProposal) {
  if (!guided) return null;
  if (guided.proposeArgs) {
    const refining = !!lastProposal;
    const args = refining ? applyPreviousProposal(guided.proposeArgs, lastProposal) : guided.proposeArgs;
    return respondWithProvisioningArgs(req, res, args, message, { refining });
  }
  return res.json({
    reply: guided.reply || "Could you share a bit more detail?",
    suggestedReplies: guided.suggestedReplies || [],
    guidedDraft: guided.guidedDraft || null,
    job: null,
    proposal: null,
  });
}

async function handleChatPost(req, res) {
  const { message, history, lastProposal, guidedDraft } = req.body || {};
  if (!message || typeof message !== "string") {
    return res.status(400).json({ error: "message is required" });
  }

  // Continue an in-progress guided (non-AI) clarify flow — same chips + proposal UX.
  if (guidedDraft?.active) {
    const guided = runGuidedProvision({
      message,
      guidedDraft,
      user: req.user,
      force: true,
    });
    return respondGuided(req, res, guided, message, lastProposal);
  }

  const aiReady = isAiConfigured();

  // AI off → guided clarify for provision intents (identical question style).
  if (!aiReady) {
    const guided = runGuidedProvision({
      message,
      guidedDraft: null,
      user: req.user,
      force: looksLikeProvisionIntent(message),
    });
    if (guided) return respondGuided(req, res, guided, message, lastProposal);
    return res.json({
      reply:
        "AI assistant isn’t configured right now. Describe what you want to run (e.g. “I want a VM for a web server”) and I’ll ask about size, OS, apps, disk, and user — same as the usual plan flow. Or use the shortcuts for day-2 actions.",
      suggestedReplies: ["I want a VM for a web server", "Show my resources", "What's expiring?"],
      job: null,
      guidedDraft: null,
    });
  }

  let result;
  try {
    result = await chatWithAssist({ message, history: history || [] });
  } catch (err) {
    // AI failed → fall through to the same guided clarify path (not a hard error for provision).
    const guided = runGuidedProvision({
      message,
      guidedDraft: null,
      user: req.user,
      force: looksLikeProvisionIntent(message),
    });
    if (guided) return respondGuided(req, res, guided, message, lastProposal);
    return res.status(502).json({
      error: `AI assistant request failed: ${formatAiProviderError(err)}`,
    });
  }

  if (!result.functionCall) {
    const { reply, suggestedReplies } = extractSuggestedReplies(
      result.text || "I'm not sure how to help with that."
    );
    return res.json({ reply, suggestedReplies, job: null, guidedDraft: null });
  }

  const { name, args = {} } = result.functionCall;
  const explicitDetails = hasExplicitResourceDetails(message);
  // Carry forward the previous proposal so a chat follow-up refines it.
  const refining = name === "resolve_provisioning" && !!lastProposal;
  const mergedArgs = refining ? applyPreviousProposal(args, lastProposal) : args;
  const resolvedArgs = mergeIntent(mergedArgs, message);
  const normalizedArgs = normalizeTemplateSelection(resolvedArgs, message);
  const withNetwork = applyNetworkFromMessage(normalizedArgs, message);
  const sizedArgs = applySmartDefaults(withNetwork, message);

  try {
    if (name === "resolve_provisioning") {
      // VMs require an environment (network) and a login user that can only be
      // chosen in the editable proposal, so never provision a VM immediately —
      // always return a proposal. Containers/stacks need neither, so they can
      // provision straight away when the user gave explicit details.
      if (sizedArgs.action === "provision" && explicitDetails && sizedArgs.kind !== "vm") {
        const template = sizedArgs.kind === "stack"
          ? findStack(sizedArgs.stackId)
          : sizedArgs.kind === "container"
            ? findContainerTemplate(sizedArgs.templateId)
            : findVmTemplate(sizedArgs.templateId);
        if (!template) {
          const missingVmTemplates = sizedArgs.kind === "vm" && availableVmTemplates().length === 0;
          return res.json({
            reply: missingVmTemplates
              ? "You asked for a VM, but no VM templates are configured in the catalog yet."
              : sizedArgs.kind === "container"
              ? "You asked for a container, but no container templates are configured yet. I prepared a container proposal so you can review it after templates are added."
              : `I could not find the selected ${sizedArgs.kind === "stack" ? "stack" : "template"} in the catalog.`,
            proposal: buildProposal(sizedArgs, message, { username: req.user.username }),
            job: null,
            guidedDraft: null,
          });
        }

        const payload = buildProvisionPayload(sizedArgs, message, req.user.username);
        const result = await startProvisioning(sizedArgs.kind, payload, req.user.username);
        if (!result.job) {
          return res.json({
            reply: `Your request requires admin approval before provisioning. Track it in Requests with id ${result.request.id}.`,
            job: null,
            proposal: null,
            guidedDraft: null,
          });
        }
        return res.json({
          reply: sizedArgs.kind === "stack"
            ? `Provisioning stack "${findStack(sizedArgs.stackId)?.name || sizedArgs.stackId}" with prefix "${payload.hostnamePrefix}". Tracking as job ${result.job.id}.`
            : sizedArgs.kind === "container"
              ? `Provisioning a container (${findContainerTemplate(sizedArgs.templateId)?.name || sizedArgs.templateId}) named "${payload.hostname}". Tracking as job ${result.job.id}.`
              : `Provisioning a VM (${findVmTemplate(sizedArgs.templateId)?.name || sizedArgs.templateId}) named "${payload.hostname}". Tracking as job ${result.job.id}.`,
          job: result.job,
          proposal: null,
          guidedDraft: null,
        });
      }

      return respondWithProvisioningArgs(req, res, sizedArgs, message, { refining });
    }

    if (name === "manage_resources") {
      const action = args.action;
      const resources = await listResourcesForChat(req.user);

      if (action === "list_owned") {
        const filtered = args.type ? resources.filter((r) => r.type === args.type) : resources;
        if (filtered.length === 0) {
          return res.json({
            reply: args.type
              ? `You currently have no ${args.type === "vm" ? "VMs" : "containers"} assigned to you.`
              : "You currently have no VMs or containers assigned to you.",
            job: null,
          });
        }
        return res.json({
          reply: "Here are your assigned resources:",
          resourceList: filtered,
          job: null,
        });
      }

      if (action === "status") {
        const candidates = resolveResourceTarget(resources, args);
        if (candidates.length === 0) {
          return res.json({
            reply: "I could not find that resource assigned to you.",
            job: null,
          });
        }

        if (candidates.length > 1) {
          return res.json({
            reply: "I found multiple matching resources. Please specify a VMID:",
            resourceList: candidates.slice(0, 10),
            job: null,
          });
        }

        const target = candidates[0];
        return res.json({
          reply: `${target.name || "resource"} [${target.type}] VMID ${target.vmid} is currently ${target.status || "unknown"}.`,
          job: null,
        });
      }

      if (!["reboot", "shutdown", "delete"].includes(action)) {
        return res.json({ reply: `Unsupported resource action: ${action}`, job: null });
      }

      const candidates = resolveResourceTarget(resources, args);
      if (candidates.length === 0) {
        return res.json({
          reply: "I could not find a matching resource assigned to you. Ask for your assigned list first, then specify VMID or exact name.",
          job: null,
        });
      }

      if (candidates.length > 1) {
        return res.json({
          reply: "I found multiple matching resources. Please specify a VMID:",
          resourceList: candidates.slice(0, 10),
          job: null,
        });
      }

      const target = candidates[0];
      if (action === "delete" && req.user.role !== "admin") {
        return res.json({
          reply: "Only admins can delete resources. You can still reboot or shutdown your assigned resources.",
          job: null,
        });
      }

      const fn = RESOURCE_ACTIONS[target.type]?.[action];
      if (!fn) {
        return res.json({ reply: `Unsupported target type/action: ${target.type}/${action}`, job: null });
      }

      try {
        await fn({ vmid: target.vmid });
      } catch (err) {
        logAudit({
          actor: req.user,
          action: `${target.type}.${action}`,
          target: `${target.name || "resource"} (VMID ${target.vmid})`,
          status: "failure",
          detail: { via: "chat", error: err.message },
        });
        return res.json({
          reply: `Unable to ${action}, try again later or contact admin.`,
          job: null,
        });
      }

      if (action === "delete") {
        removeOwner(target.vmid);
      }

      logAudit({
        actor: req.user,
        action: `${target.type}.${action}`,
        target: `${target.name || "resource"} (VMID ${target.vmid})`,
        status: "success",
        detail: { via: "chat" },
      });

      return res.json({
        reply: `${action[0].toUpperCase() + action.slice(1)} requested for ${target.name || "resource"} (${target.type}, VMID ${target.vmid}).`,
        job: null,
      });
    }

    return res.json({ reply: `Model called an unknown function: ${name}`, job: null });
  } catch (err) {
    return res.status(500).json({ error: `Failed to process chat action: ${err.message}` });
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Progressive reveal of a finished reply over SSE (keeps chat feeling responsive). */
async function streamReplyChunks(res, reply, send) {
  const text = String(reply || "");
  if (!text) return;
  const chunkSize = text.length > 400 ? 24 : 12;
  for (let i = 0; i < text.length; i += chunkSize) {
    if (res.writableEnded) return;
    send("delta", { text: text.slice(i, i + chunkSize) });
    // Tiny pause so the UI can paint; keep total reveal under ~1.2s for long replies.
    await sleep(Math.min(28, Math.max(8, Math.floor(900 / Math.ceil(text.length / chunkSize)))));
  }
}

router.post("/chat", handleChatPost);

router.post("/chat/stream", async (req, res) => {
  const { message } = req.body || {};
  if (!message || typeof message !== "string") {
    return res.status(400).json({ error: "message is required" });
  }

  res.status(200);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  if (typeof res.flushHeaders === "function") res.flushHeaders();

  const send = (event, data) => {
    if (res.writableEnded) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  send("status", { text: "Thinking…" });

  let capturedStatus = 200;
  let capturedBody = null;
  const captureRes = {
    status(code) {
      capturedStatus = code;
      return this;
    },
    json(body) {
      capturedBody = body;
      return this;
    },
  };

  try {
    await handleChatPost(req, captureRes);
  } catch (err) {
    send("error", { error: err.message || "Chat stream failed" });
    return res.end();
  }

  if (capturedStatus >= 400 || !capturedBody) {
    send("error", { error: capturedBody?.error || "Chat request failed" });
    return res.end();
  }

  const hasExtras = !!(capturedBody.proposal || capturedBody.job || capturedBody.resourceList?.length);
  if (!hasExtras && capturedBody.reply) {
    await streamReplyChunks(res, capturedBody.reply, send);
  } else if (capturedBody.proposal) {
    send("status", { text: "Preparing plan…" });
  }

  send("done", capturedBody);
  return res.end();
});

export default router;
