/**
 * Rule-based provision assistant — same UX as AI clarify → chips → proposal,
 * used when the LLM is disabled or unreachable.
 */

import {
  listInstanceSizes,
  listPackages,
  listPackageIds,
  mappedVmTemplates,
  internalVmTemplates,
  findVmTemplate,
  resolveInstanceSize,
} from "./catalogService.js";
import { getNetworkMappings } from "./mappingStore.js";

const APP_PRESETS = [
  { id: "static", label: "Static site", packages: ["nginx", "git"], re: /\b(static|html|website|web\s*site)\b/i },
  { id: "nodejs", label: "Node.js API", packages: ["nodejs", "yarn", "nginx", "git"], re: /\b(node|nodejs|express|react|next|vue|typescript)\b/i },
  { id: "wordpress", label: "WordPress", packages: ["php", "nginx", "mysql", "git"], re: /\b(wordpress|wp)\b/i },
  { id: "php", label: "PHP / Laravel", packages: ["php", "nginx", "git"], re: /\b(php|laravel|symfony)\b/i },
  { id: "python", label: "Python app", packages: ["python", "nginx", "git"], re: /\b(python|django|flask|fastapi)\b/i },
  { id: "docker", label: "Docker host", packages: ["docker", "docker-compose", "git"], re: /\b(docker|containeri[sz]e)\b/i },
  { id: "nginx", label: "nginx web server", packages: ["nginx"], re: /\b(nginx|web\s*server|webserver)\b/i },
  { id: "none", label: "OS only (no apps)", packages: [] },
];

function availableVmTemplates() {
  return [...mappedVmTemplates(), ...internalVmTemplates()];
}

function listEnvironmentOptions() {
  const nets = getNetworkMappings();
  return Object.entries(nets)
    .filter(([, m]) => m.label && String(m.label).trim())
    .map(([iface, m]) => ({ iface, label: m.label }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

function allowedPackageSet() {
  return new Set(listPackageIds());
}

function filterPackages(ids) {
  const allowed = allowedPackageSet();
  return (ids || []).map((p) => String(p).toLowerCase().trim()).filter((p) => allowed.has(p));
}

function sizeChipLabel(s) {
  return `${s.label || s.key} (${s.cpu} CPU · ${s.memoryGB} GB)`;
}

function inferSizeFromText(text) {
  const lower = String(text || "").toLowerCase();
  if (/\b(extra[\s-]?large|x-?large|xl)\b/.test(lower)) {
    const xl = listInstanceSizes().find((s) => s.key === "xl");
    if (xl) return xl.key;
  }
  for (const s of listInstanceSizes()) {
    const key = s.key.toLowerCase();
    const label = String(s.label || "").toLowerCase();
    const chip = sizeChipLabel(s).toLowerCase();
    if (lower === chip || lower === key || lower === label) return s.key;
    if (new RegExp(`\\b${key}\\b`).test(lower)) return s.key;
    if (label && new RegExp(`\\b${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(lower)) return s.key;
  }
  return null;
}

function inferTemplateFromText(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  const lower = raw.toLowerCase();
  const tpls = availableVmTemplates();
  const byId = tpls.find((t) => String(t.id).toLowerCase() === lower);
  if (byId) return byId.id;
  const byName = tpls.find((t) => String(t.name || "").toLowerCase() === lower);
  if (byName) return byName.id;
  const partial = tpls.filter((t) => {
    const name = String(t.name || "").toLowerCase();
    const os = String(t.osName || "").toLowerCase();
    return (name && lower.includes(name)) || (name && name.includes(lower)) || (os && lower.includes(os));
  });
  return partial.length === 1 ? partial[0].id : null;
}

function inferDiskFromText(text) {
  const raw = String(text || "").trim().toLowerCase();
  if (!raw) return null;
  if (/^(none|no|0|skip|no extra|no additional)\b/.test(raw) || /\bno\s+(extra|additional)\s+disk\b/.test(raw)) {
    return 0;
  }
  const m = raw.match(/(\d+)\s*(gb|g)?/);
  if (m) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n >= 0) return Math.min(4096, Math.round(n));
  }
  return null;
}

function inferTtlFromText(text) {
  const t = String(text || "");
  if (/\b(permanent|no expiry|indefinite|forever)\b/i.test(t)) {
    return { permanent: true, ttlDays: null };
  }
  const m = t.match(/\b(?:for|ttl|lifetime)?\s*(\d+)\s*(days?|weeks?|months?|years?)\b/i)
    || t.match(/\b(\d+)\s*(days?|weeks?|months?|years?)\b/i);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = m[2].toLowerCase();
  const mult = /^day/.test(unit) ? 1 : /^week/.test(unit) ? 7 : /^month/.test(unit) ? 30 : 365;
  return { permanent: false, ttlDays: Math.min(3650, Math.round(n * mult)) };
}

function inferNetworkFromText(text) {
  const envs = listEnvironmentOptions();
  const raw = String(text || "").trim();
  if (!raw || !envs.length) return null;
  const lower = raw.toLowerCase();
  const byIface = envs.find((e) => e.iface.toLowerCase() === lower);
  if (byIface) return byIface.iface;
  const byLabel = envs.find((e) => e.label.toLowerCase() === lower);
  if (byLabel) return byLabel.iface;
  const partial = envs.find((e) => lower.includes(e.label.toLowerCase()) || e.label.toLowerCase().includes(lower));
  return partial?.iface || null;
}

function inferAppPreset(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  const lower = raw.toLowerCase();
  for (const p of APP_PRESETS) {
    if (p.label.toLowerCase() === lower || p.id === lower) return p;
  }
  for (const p of APP_PRESETS) {
    if (p.re && p.re.test(raw)) return p;
  }
  // Free-text package ids / names
  const allowed = allowedPackageSet();
  const pkgByName = new Map(listPackages().map((p) => [String(p.name || "").toLowerCase(), p.id]));
  const tokens = lower.split(/[\s,+/]+/).filter(Boolean);
  const found = [];
  for (const tok of tokens) {
    if (allowed.has(tok)) found.push(tok);
    else if (pkgByName.has(tok)) found.push(pkgByName.get(tok));
  }
  if (found.length) return { id: "custom", label: "Custom", packages: found };
  return null;
}

function defaultUsername(user) {
  const raw = (user?.username || user?.displayName || user?.email || "").split("@")[0];
  const clean = String(raw || "").toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 20);
  if (!clean) return "clouduser";
  return /^[a-z]/.test(clean) ? clean : `u${clean}`;
}

function looksLikeUsername(text) {
  const t = String(text || "").trim();
  if (!t || /\s/.test(t)) return false;
  if (/^(use default|default|same as me|me)\b/i.test(t)) return true;
  return /^[a-zA-Z][a-zA-Z0-9._-]{0,31}$/.test(t);
}

/** K8s namespace / cluster / docker-pod style asks — must not enter the VM size wizard. */
export function looksLikeNonVmWorkload(message) {
  const t = String(message || "").trim();
  if (!t) return false;
  if (/\bnamespaces?\b/i.test(t)) return true;
  if (/\b(k3s|kubernetes|k8s)\b/i.test(t) && !/\b(vm|virtual machine)\b/i.test(t)) return true;
  // "deploy/run an nginx container" → container/K8s/Docker, not a Proxmox VM
  if (/\b(deploy|run|launch|create|start)\b.+\bcontainers?\b/i.test(t) && !/\b(lxc|proxmox)\b/i.test(t)) {
    return true;
  }
  if (/\bcontainers?\b/i.test(t) && !/\b(lxc|proxmox|vm|virtual machine)\b/i.test(t)) {
    return true;
  }
  if (/\b(pod|deployment|helm\s+chart|ingress)\b/i.test(t) && !/\b(vm|virtual machine)\b/i.test(t)) {
    return true;
  }
  return false;
}

/** True when the user is asking to build / size a new Proxmox VM (or explicit LXC/stack). */
export function looksLikeProvisionIntent(message) {
  const t = String(message || "").trim();
  if (!t) return false;
  if (/^(help|\?|commands)\b/i.test(t)) return false;
  if (looksLikeNonVmWorkload(t)) return false;
  if (/\b(show|list|status|reboot|shutdown|delete|extend|renew|expiring|failed)\b/i.test(t)
    && !/\b(want|need|create|provision|deploy|spin|launch|build|host|set\s*up)\b/i.test(t)) {
    return false;
  }
  return (
    /\b(want|need|create|provision|deploy|spin\s*up|launch|build|set\s*up|stand\s*up)\b/i.test(t)
    || /\b(vm|virtual machine|server|host|machine|instance|box|lxc|stack)\b/i.test(t)
    || /\b(web\s*server|webserver|website|database|postgres|mysql)\b/i.test(t)
    || /\b(for\s+(a\s+)?(web|api|app|site|db|test))\b/i.test(t)
  );
}

/** Explain non-VM asks instead of starting the VM clarify flow. */
export function nonVmWorkloadReply(message) {
  const t = String(message || "").trim();
  if (/\bnamespaces?\b/i.test(t)) {
    return {
      reply:
        "That is a **Kubernetes namespace**, not a VM. Try: **Create namespace my-name** (or open **Provisioning → Kubernetes**).",
      suggestedReplies: ["Create namespace test-ns", "List namespaces", "I want a VM for a web server"],
      guidedDraft: null,
      proposeArgs: null,
    };
  }
  if (/\b(pod|deployment|helm|ingress|k3s|kubernetes|k8s)\b/i.test(t)) {
    return {
      reply:
        "That sounds like a **Kubernetes** workload, not a Proxmox VM. Use **Provisioning → Kubernetes** to deploy into a namespace, or say **Create namespace my-name** first.",
      suggestedReplies: ["Create namespace demo", "List namespaces", "I want a VM instead"],
      guidedDraft: null,
      proposeArgs: null,
    };
  }
  return {
    reply:
      "You asked for a **container**, not a VM. Tell me which platform:\n"
      + "- **Kubernetes** — deploy into a K3s namespace (Provisioning → Kubernetes)\n"
      + "- **Docker** — run on a Docker host (Provisioning → Docker)\n"
      + "- **LXC** — Proxmox container (open Provision → Containers)\n"
      + "- **VM** — full virtual machine (say “I want a VM with nginx”)",
    suggestedReplies: ["Create namespace demo", "List namespaces", "I want a VM with nginx"],
    guidedDraft: null,
    proposeArgs: null,
  };
}

function startDraft(message, user) {
  const kind = /\b(container|lxc)\b/i.test(message) ? "container"
    : /\bstack\b/i.test(message) ? "stack"
    : "vm";
  const preset = inferAppPreset(message);
  const size = inferSizeFromText(message);
  const templateId = inferTemplateFromText(message);
  const disk = inferDiskFromText(message);
  const ttl = inferTtlFromText(message);
  const environment = inferNetworkFromText(message);
  // Vague "webserver" only hints packages — still ask. Named stacks confirm.
  const specificApp = !!(preset && ["nodejs", "wordpress", "php", "python", "docker", "static"].includes(preset.id));
  const draft = {
    active: true,
    kind,
    purpose: String(message || "").trim().slice(0, 240),
    size: size || null,
    sizeConfirmed: !!size,
    templateId: templateId || null,
    packages: preset ? filterPackages(preset.packages) : null,
    packagesConfirmed: specificApp,
    additionalDiskGB: disk,
    diskConfirmed: disk != null,
    username: null,
    usernameConfirmed: false,
    environment: environment || null,
    ttlDays: ttl?.ttlDays ?? null,
    permanent: ttl?.permanent || false,
    ttlConfirmed: !!ttl,
    defaultUsername: defaultUsername(user),
  };
  // Single network → auto-pick
  const envs = listEnvironmentOptions();
  if (!draft.environment && envs.length === 1) draft.environment = envs[0].iface;
  // Single template → soft-set but still ask if multiple naming styles? Prefer ask when >1
  if (!draft.templateId && availableVmTemplates().length === 1) {
    draft.templateId = availableVmTemplates()[0].id;
  }
  return draft;
}

function applyMessageToDraft(draft, message) {
  const next = { ...draft };
  const text = String(message || "").trim();
  if (!text) return next;

  // Answer whichever field we're currently waiting on first, then opportunistic fills.
  const waiting = nextMissingField(next);

  if (waiting === "size" || (!next.sizeConfirmed && inferSizeFromText(text))) {
    const s = inferSizeFromText(text);
    if (s) {
      next.size = s;
      next.sizeConfirmed = true;
    }
  }

  if (waiting === "os" || (!next.templateId && inferTemplateFromText(text))) {
    const tid = inferTemplateFromText(text);
    if (tid) next.templateId = tid;
  }

  if (waiting === "apps" || next.packages == null || !next.packagesConfirmed) {
    const preset = inferAppPreset(text);
    if (preset && (waiting === "apps" || /app|stack|package|nginx|node|python|docker|wordpress|php|static|os only/i.test(text))) {
      next.packages = filterPackages(preset.packages);
      next.packagesConfirmed = true;
    } else if (waiting === "apps" && /^(skip|none|no apps|os only)\b/i.test(text)) {
      next.packages = [];
      next.packagesConfirmed = true;
    }
  }

  if (waiting === "disk" || next.additionalDiskGB == null) {
    const d = inferDiskFromText(text);
    if (d != null && (waiting === "disk" || /\b(disk|gb|storage|none)\b/i.test(text))) {
      next.additionalDiskGB = d;
      next.diskConfirmed = true;
    }
  }

  if (waiting === "username" || !next.usernameConfirmed) {
    if (waiting === "username" || looksLikeUsername(text)) {
      if (/^(use default|default|same as me|me)\b/i.test(text)) {
        next.username = next.defaultUsername;
        next.usernameConfirmed = true;
      } else if (looksLikeUsername(text) && !inferSizeFromText(text) && !inferTemplateFromText(text)) {
        // Avoid treating size/OS chip labels as usernames
        const asUser = text.trim();
        if (!listInstanceSizes().some((s) => sizeChipLabel(s).toLowerCase() === asUser.toLowerCase())
          && !availableVmTemplates().some((t) => String(t.name).toLowerCase() === asUser.toLowerCase())
          && !APP_PRESETS.some((p) => p.label.toLowerCase() === asUser.toLowerCase())
          && !listEnvironmentOptions().some((e) => e.label.toLowerCase() === asUser.toLowerCase())) {
          next.username = asUser;
          next.usernameConfirmed = true;
        }
      }
    }
  }

  if (waiting === "network" || !next.environment) {
    const env = inferNetworkFromText(text);
    if (env) next.environment = env;
  }

  if (waiting === "ttl" || !next.ttlConfirmed) {
    const ttl = inferTtlFromText(text);
    if (ttl) {
      next.ttlDays = ttl.ttlDays;
      next.permanent = !!ttl.permanent;
      next.ttlConfirmed = true;
    }
  }

  return next;
}

function nextMissingField(draft) {
  if (!draft.sizeConfirmed || !draft.size) return "size";
  if (!draft.templateId) return "os";
  if (!draft.packagesConfirmed) return "apps";
  if (!draft.diskConfirmed) return "disk";
  if (!draft.usernameConfirmed) return "username";
  const envs = listEnvironmentOptions();
  if (draft.kind === "vm" && envs.length > 1 && !draft.environment) return "network";
  if (!draft.ttlConfirmed) return "ttl";
  return null;
}

function questionFor(field, draft) {
  if (field === "size") {
    const sizes = listInstanceSizes();
    const chips = sizes.slice(0, 6).map(sizeChipLabel);
    const purpose = draft.purpose ? ` for “${draft.purpose.slice(0, 80)}”` : "";
    return {
      reply: `What size should this VM be${purpose}? Pick a size from the catalog:`,
      suggestedReplies: chips.length ? chips : ["2 CPU · 4 GB", "4 CPU · 8 GB"],
    };
  }
  if (field === "os") {
    const tpls = availableVmTemplates();
    const chips = tpls.slice(0, 6).map((t) => t.name || t.id);
    return {
      reply: tpls.length
        ? "Which OS / template should I use?"
        : "No VM templates are configured yet. Ask an admin to map templates under Mappings, then try again.",
      suggestedReplies: chips,
    };
  }
  if (field === "apps") {
    const usable = APP_PRESETS.filter((p) => {
      if (p.id === "none") return true;
      return filterPackages(p.packages).length > 0;
    }).map((p) => p.label).slice(0, 6);
    const hint = Array.isArray(draft.packages) && draft.packages.length
      ? ` I can start with **${draft.packages.join(", ")}** — pick a stack or OS only.`
      : "";
    return {
      reply: `Which apps / stack should I install?${hint}`,
      suggestedReplies: usable,
    };
  }
  if (field === "disk") {
    return {
      reply: "Need an additional data disk beyond the OS disk? (NFS, DB data, media, etc.)",
      suggestedReplies: ["None", "50 GB", "100 GB", "200 GB"],
    };
  }
  if (field === "username") {
    const def = draft.defaultUsername || "forge";
    return {
      reply: `What login username should the VM use? (Default from your account: **${def}**)`,
      suggestedReplies: [`Use default`, def, "ubuntu", "admin"].filter((v, i, a) => a.indexOf(v) === i).slice(0, 4),
    };
  }
  if (field === "network") {
    const envs = listEnvironmentOptions();
    return {
      reply: `Which network should this VM use? Available: ${envs.map((e) => e.label).join(", ")}.`,
      suggestedReplies: envs.map((e) => e.label).slice(0, 6),
    };
  }
  if (field === "ttl") {
    return {
      reply: "How long should this stay up before auto-decommission?",
      suggestedReplies: ["2 days", "1 week", "30 days", "Permanent"],
    };
  }
  return { reply: "Could you share a bit more detail?", suggestedReplies: [] };
}

function draftToProposeArgs(draft) {
  const sized = resolveInstanceSize(draft.size);
  const tpl = findVmTemplate(draft.templateId);
  const packages = Array.isArray(draft.packages) ? draft.packages : [];
  const rationaleBits = [
    draft.purpose ? `Based on your request (“${draft.purpose.slice(0, 120)}”)` : "Based on your answers",
    tpl ? `I recommend ${tpl.name}` : "I put together a VM plan",
    sized ? `at size ${draft.size} (${sized.cpu} CPU · ${sized.memoryGB} GB RAM)` : null,
    packages.length ? `with ${packages.join(", ")}` : "with a clean OS",
    draft.additionalDiskGB > 0 ? `plus a ${draft.additionalDiskGB} GB data disk` : null,
  ].filter(Boolean);
  return {
    action: "propose",
    kind: draft.kind || "vm",
    templateId: draft.templateId,
    size: draft.size || undefined,
    cpu: sized?.cpu,
    memoryGB: sized?.memoryGB,
    additionalDiskGB: draft.additionalDiskGB > 0 ? draft.additionalDiskGB : 0,
    environment: draft.environment || undefined,
    username: draft.username || draft.defaultUsername || undefined,
    packages,
    permanent: !!draft.permanent,
    ttlDays: draft.permanent ? undefined : (draft.ttlDays || undefined),
    rationale: `${rationaleBits.join(" ")}. Review the plan and Approve or Modify.`,
    sizeReason: sized
      ? `${sized.label || draft.size} fits a typical ${draft.purpose ? "workload like this" : "general workload"} (${sized.cpu} CPU · ${sized.memoryGB} GB).`
      : "Sized from the catalog options you picked.",
    packageNotes: packages.length
      ? `Pre-selected packages: ${packages.join(", ")}.`
      : "No extra packages — OS only.",
    storageNote: draft.additionalDiskGB > 0
      ? `Additional ${draft.additionalDiskGB} GB data disk for workload data.`
      : "",
  };
}

/**
 * Continue or start guided provision.
 * @returns {{ reply, suggestedReplies, guidedDraft, proposeArgs } | null}
 *   null = not a guided turn (caller should use other handling)
 */
export function runGuidedProvision({
  message,
  guidedDraft = null,
  user = null,
  force = false,
}) {
  const hasDraft = guidedDraft && guidedDraft.active;
  // Never start (or force) the VM wizard for namespace / K8s / generic container asks.
  if (!hasDraft && looksLikeNonVmWorkload(message)) {
    return nonVmWorkloadReply(message);
  }
  if (!hasDraft && !force && !looksLikeProvisionIntent(message)) {
    return null;
  }
  if (!hasDraft && force && !looksLikeProvisionIntent(message)) {
    return null;
  }

  const draft = hasDraft
    ? applyMessageToDraft({
      ...guidedDraft,
      defaultUsername: guidedDraft.defaultUsername || defaultUsername(user),
    }, message)
    : startDraft(message, user);

  // No templates → stop early
  if (!availableVmTemplates().length) {
    return {
      reply: "No VM templates are configured in the catalog yet. Ask an admin to map templates under Mappings, then try again.",
      suggestedReplies: [],
      guidedDraft: null,
      proposeArgs: null,
    };
  }

  const missing = nextMissingField(draft);
  if (missing) {
    // Can't ask OS with empty catalog already handled
    if (missing === "os" && !availableVmTemplates().length) {
      return {
        reply: "No VM templates are configured yet.",
        suggestedReplies: [],
        guidedDraft: null,
        proposeArgs: null,
      };
    }
    const q = questionFor(missing, draft);
    return {
      reply: q.reply,
      suggestedReplies: q.suggestedReplies,
      guidedDraft: { ...draft, active: true, waiting: missing },
      proposeArgs: null,
    };
  }

  return {
    reply: null,
    suggestedReplies: [],
    guidedDraft: null,
    proposeArgs: draftToProposeArgs(draft),
  };
}
