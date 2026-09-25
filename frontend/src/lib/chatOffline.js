/**
 * Non-AI chat assist — keyword intents + quick actions that call portal APIs
 * directly (works when the LLM is down or unused).
 */

import {
  getResources,
  resourceAction,
  extendResource,
  getExpiringResources,
  getJobs,
  retryJob,
  createK8sNamespace,
  getK8sNamespaces,
} from "../api/client.js";

/** Always-visible chips above the chat composer. */
export const QUICK_ACTIONS = [
  { id: "list", label: "My resources", text: "Show my resources" },
  { id: "expiring", label: "Expiring soon", text: "What's expiring?" },
  { id: "failed", label: "Failed jobs", text: "Show failed deployments" },
  { id: "help", label: "Help", text: "help" },
];

const HELP_TEXT = [
  "**I can help without AI** using these commands:",
  "",
  "- **Show my resources** / `list` — inventory you can manage",
  "- **Status of name** — power state for a VM/container",
  "- **Reboot name** — reboot a running guest",
  "- **What's expiring?** — renewals due in the next 30 days",
  "- **Extend name** / **Renew name** — add 7 days",
  "- **Show failed deployments** — retry or open logs",
  "- **Create namespace name** — create a K3s namespace",
  "- **List namespaces** — namespaces you can see",
  "",
  "For a **VM**, describe the workload and I'll ask size / OS / apps (AI when available). **Containers / K8s** use Provisioning → Kubernetes or Docker — not the VM wizard.",
].join("\n");

function normalize(text) {
  return String(text || "").trim().replace(/\s+/g, " ");
}

function findResource(resources, query) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return null;
  if (/^\d+$/.test(q)) {
    return resources.find((r) => String(r.vmid) === q) || null;
  }
  const exact = resources.find((r) => (r.name || "").toLowerCase() === q);
  if (exact) return exact;
  const hits = resources.filter((r) => (r.name || "").toLowerCase().includes(q));
  return hits.length === 1 ? hits[0] : hits[0] || null;
}

function formatResourceLine(r) {
  const bits = [
    r.name || `VMID ${r.vmid}`,
    `#${r.vmid}`,
    r.type === "container" ? "CT" : "VM",
    r.status || "unknown",
  ];
  if (r.ip) bits.push(r.ip);
  if (r.expiresAt) {
    bits.push(r.expired ? "expired" : `${r.daysLeft}d left`);
  }
  return bits.join(" · ");
}

/**
 * @returns {{ type: string, target?: string, days?: number } | null}
 */
export function matchOfflineIntent(raw) {
  const text = normalize(raw);
  if (!text) return null;
  const lower = text.toLowerCase();

  if (/^(help|\?|commands|what can you do)\b/.test(lower) || lower === "help") {
    return { type: "help" };
  }

  if (
    /^(show|list|my)\b.*\b(resources?|vms?|machines?|inventory)\b/.test(lower)
    || /^(show|list)\s+my\s+resources?\b/.test(lower)
    || lower === "show my resources"
    || lower === "list"
    || lower === "my resources"
    || lower === "my vms"
  ) {
    return { type: "list" };
  }

  if (
    /^(what'?s|what is|show|list)\b.*\bexpir/.test(lower)
    || /\bexpiring\b/.test(lower)
    || lower === "expiring soon"
    || lower === "renewals"
  ) {
    return { type: "expiring" };
  }

  if (
    /^(show|list)\b.*\b(failed|failing)\b.*\b(job|deploy)/.test(lower)
    || /\bfailed\s+(jobs?|deployments?)\b/.test(lower)
    || lower === "failed jobs"
    || lower === "show failed deployments"
  ) {
    return { type: "failed_jobs" };
  }

  // K8s namespaces — never treat as VM provision
  if (
    /^(list|show)\s+(my\s+)?(k8s\s+|kubernetes\s+|k3s\s+)?namespaces?\b/.test(lower)
    || lower === "list namespaces"
    || lower === "show namespaces"
  ) {
    return { type: "list_namespaces" };
  }

  let m = lower.match(
    /^(?:create|add|make)\s+(?:a\s+)?(?:new\s+)?(?:k8s\s+|kubernetes\s+|k3s\s+)?namespace\s+([a-z0-9]([-a-z0-9]*[a-z0-9])?)$/
  );
  if (m) return { type: "create_namespace", name: m[1] };

  m = lower.match(
    /^create\s+(?:a\s+)?(?:new\s+)?namespace\s+(?:called\s+|named\s+)?([a-z0-9]([-a-z0-9]*[a-z0-9])?)$/
  );
  if (m) return { type: "create_namespace", name: m[1] };

  // Soft match for container/K8s deploy phrasing — redirect, don't provision a VM
  if (
    (/\b(deploy|run|launch)\b.+\b(container|pod|deployment)\b/.test(lower)
      || /\b(nginx|redis|postgres)\s+container\b/.test(lower))
    && !/\b(vm|virtual machine|lxc)\b/.test(lower)
  ) {
    return { type: "container_redirect", text };
  }

  if (/\bnamespaces?\b/.test(lower) && /\b(create|add|make|new)\b/.test(lower)) {
    const nameMatch = lower.match(/\bnamespace\s+([a-z0-9]([-a-z0-9]*[a-z0-9])?)\b/);
    if (nameMatch?.[1] && nameMatch[1] !== "namespace" && nameMatch[1] !== "new") {
      return { type: "create_namespace", name: nameMatch[1] };
    }
    return { type: "create_namespace_prompt" };
  }

  m = lower.match(/^(?:status|state)\s+(?:of\s+)?(.+)$/);
  if (m) return { type: "status", target: m[1].trim() };

  m = lower.match(/^(?:reboot|restart)\s+(.+)$/);
  if (m) return { type: "reboot", target: m[1].trim() };

  m = lower.match(/^(?:extend|renew)\s+(.+?)(?:\s+by\s+(\d+)\s*d(?:ays?)?)?$/);
  if (m) {
    return {
      type: "extend",
      target: m[1].replace(/\s+by\s+\d+\s*d(?:ays?)?$/i, "").trim(),
      days: m[2] ? Number(m[2]) : 7,
    };
  }

  if (lower === "extend lifetime by 7 days") {
    return { type: "extend_ready" };
  }

  return null;
}

async function loadResources() {
  const data = await getResources();
  return Array.isArray(data) ? data : [];
}

/**
 * Run a matched offline intent. Returns a chat message object (assistant).
 */
export async function runOfflineIntent(intent, { readyResources = [] } = {}) {
  if (!intent) return null;

  if (intent.type === "help") {
    return {
      role: "assistant",
      text: HELP_TEXT,
      suggestedReplies: QUICK_ACTIONS.map((a) => a.text).filter((t) => t !== "help"),
      offline: true,
    };
  }

  if (intent.type === "list") {
    const resources = await loadResources();
    if (!resources.length) {
      return {
        role: "assistant",
        text: "You don't have any VMs or containers yet. Ask me to propose one, or open **Provision**.",
        suggestedReplies: ["Propose a small API server", "I want to host a website"],
        offline: true,
      };
    }
    return {
      role: "assistant",
      text: `Here are **${resources.length}** resource(s) you can manage:`,
      resourceList: resources.map((r) => ({
        vmid: r.vmid,
        name: r.name,
        type: r.type,
        status: r.status,
        ip: r.ip,
        expiresAt: r.expiresAt,
        daysLeft: r.daysLeft,
        expired: r.expired,
      })),
      listActions: true,
      offline: true,
    };
  }

  if (intent.type === "status") {
    const resources = await loadResources();
    const r = findResource(resources, intent.target);
    if (!r) {
      return {
        role: "assistant",
        text: `I couldn't find a resource matching **${intent.target}**. Try **Show my resources**.`,
        suggestedReplies: ["Show my resources"],
        offline: true,
      };
    }
    return {
      role: "assistant",
      text: `**${r.name || `VMID ${r.vmid}`}** is **${r.status || "unknown"}**.`,
      resourceList: [r],
      listActions: true,
      offline: true,
    };
  }

  if (intent.type === "reboot") {
    const resources = await loadResources();
    const r = findResource(resources, intent.target);
    if (!r) {
      return {
        role: "assistant",
        text: `I couldn't find **${intent.target}** to reboot.`,
        suggestedReplies: ["Show my resources"],
        offline: true,
      };
    }
    if ((r.status || "").toLowerCase() !== "running") {
      return {
        role: "assistant",
        text: `**${r.name || r.vmid}** is ${r.status || "not running"} — reboot needs a running guest.`,
        resourceList: [r],
        listActions: true,
        offline: true,
      };
    }
    await resourceAction(r.type || "vm", r.vmid, "reboot");
    return {
      role: "assistant",
      text: `Reboot started for **${r.name || `VMID ${r.vmid}`}**.`,
      offline: true,
    };
  }

  if (intent.type === "extend" || intent.type === "extend_ready") {
    const days = intent.days || 7;
    let targets = [];
    if (intent.type === "extend_ready") {
      targets = readyResources;
    } else {
      const resources = await loadResources();
      const r = findResource(resources, intent.target);
      if (!r) {
        return {
          role: "assistant",
          text: `I couldn't find **${intent.target}** to extend.`,
          suggestedReplies: ["What's expiring?", "Show my resources"],
          offline: true,
        };
      }
      targets = [r];
    }
    if (!targets.length) {
      return {
        role: "assistant",
        text: "Nothing to extend. Open **What's expiring?** or list your resources first.",
        suggestedReplies: ["What's expiring?", "Show my resources"],
        offline: true,
      };
    }
    const results = await Promise.allSettled(
      targets.map((r) => extendResource(r.type || "vm", r.vmid, days)),
    );
    const ok = results.filter((x) => x.status === "fulfilled").length;
    const failed = results.length - ok;
    return {
      role: "assistant",
      text: failed
        ? `Extended **${ok}** resource(s) by ${days} days; **${failed}** failed.`
        : `Extended lifetime by **${days} days** for ${ok} resource(s).`,
      offline: true,
    };
  }

  if (intent.type === "expiring") {
    const items = await getExpiringResources(30);
    const list = Array.isArray(items) ? items : [];
    if (!list.length) {
      return {
        role: "assistant",
        text: "Nothing is expiring in the next **30 days**.",
        offline: true,
      };
    }
    return {
      role: "assistant",
      text: `**${list.length}** resource(s) expiring in the next 30 days:`,
      expiringList: list,
      offline: true,
    };
  }

  if (intent.type === "failed_jobs") {
    const jobs = await getJobs();
    const failed = (Array.isArray(jobs) ? jobs : [])
      .filter((j) => j.status === "failed")
      .sort((a, b) => new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0))
      .slice(0, 12);
    if (!failed.length) {
      return {
        role: "assistant",
        text: "No failed deployments right now. Nice work.",
        suggestedReplies: ["Show my resources"],
        offline: true,
      };
    }
    return {
      role: "assistant",
      text: `**${failed.length}** failed deployment(s):`,
      jobList: failed.map((j) => ({
        id: j.id,
        name: j.payload?.hostname || j.payload?.name || j.message || j.id,
        kind: j.kind || j.payload?.kind || "job",
        status: j.status,
        error: j.error || j.message || "",
        updatedAt: j.updatedAt || j.createdAt,
      })),
      offline: true,
    };
  }

  if (intent.type === "list_namespaces") {
    const list = await getK8sNamespaces();
    const rows = Array.isArray(list) ? list : [];
    if (!rows.length) {
      return {
        role: "assistant",
        text: "No Kubernetes namespaces visible yet. Create one with **Create namespace my-app**.",
        suggestedReplies: ["Create namespace demo"],
        offline: true,
      };
    }
    const lines = rows.slice(0, 30).map((ns) => {
      const name = ns.name || ns.metadata?.name || "—";
      const status = ns.status || ns.phase || "";
      return `- **${name}**${status ? ` (${status})` : ""}`;
    });
    return {
      role: "assistant",
      text: `**${rows.length}** namespace(s):\n${lines.join("\n")}`,
      suggestedReplies: ["Create namespace demo"],
      offline: true,
    };
  }

  if (intent.type === "create_namespace_prompt") {
    return {
      role: "assistant",
      text: "What should the Kubernetes namespace be called? Reply like **Create namespace my-app** (lowercase, digits, hyphens).",
      suggestedReplies: ["Create namespace demo", "Create namespace test-ns", "List namespaces"],
      offline: true,
    };
  }

  if (intent.type === "create_namespace") {
    const name = String(intent.name || "").trim().toLowerCase();
    if (!/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(name) || name.length > 63) {
      return {
        role: "assistant",
        text: "Namespace names must be lowercase letters/numbers/hyphens, start and end alphanumeric, max 63 chars.",
        suggestedReplies: ["Create namespace demo", "List namespaces"],
        offline: true,
      };
    }
    try {
      const created = await createK8sNamespace({ name });
      const createdName = created?.name || created?.metadata?.name || name;
      return {
        role: "assistant",
        text: `Created Kubernetes namespace **${createdName}**. Open **Provisioning → Kubernetes** to deploy workloads into it.`,
        suggestedReplies: ["List namespaces", "Show my resources"],
        offline: true,
      };
    } catch (err) {
      const errText = err.response?.data?.error || err.message || "Create failed";
      const timeout = /timeout/i.test(errText);
      return {
        role: "assistant",
        text: timeout
          ? `Couldn't create namespace **${name}**: the **K3s API timed out** (API server at the configured URL is slow or not responding). Check the cluster node / Admin → Settings → Kubernetes (Test connection), then retry.`
          : `Couldn't create namespace **${name}**: ${errText}`,
        suggestedReplies: ["List namespaces", `Create namespace ${name}`],
        offline: true,
        isError: true,
      };
    }
  }

  if (intent.type === "container_redirect") {
    return {
      role: "assistant",
      text:
        "That sounds like a **container / Kubernetes** request, not a Proxmox VM.\n\n"
        + "- **K3s**: create a namespace (`Create namespace my-app`), then deploy from **Provisioning → Kubernetes**\n"
        + "- **Docker**: use **Provisioning → Docker**\n"
        + "- **VM with nginx**: say **I want a VM with nginx**",
      suggestedReplies: ["Create namespace demo", "List namespaces", "I want a VM with nginx"],
      offline: true,
    };
  }

  return null;
}

export async function renewExpiringItem(item, days = 7) {
  return extendResource(item.type || "vm", item.vmid, days);
}

export async function retryFailedJob(jobId) {
  return retryJob(jobId);
}

export { formatResourceLine, findResource };
