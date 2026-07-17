import { AI_ASSISTANT_NAME, PRODUCT_NAME } from "../constants/brand.js";
import {
  listPackages,
  listContainerTemplates,
  listStackTemplates,
  listInstanceSizes,
  internalVmTemplates,
  mappedVmTemplates,
} from "./catalogService.js";
import { getNetworkMappings } from "./mappingStore.js";
import { getCostRates } from "./settingsStore.js";

/** OpenAI / Anthropic JSON Schema style tool definitions. */
export const OPENAI_TOOLS = [
  {
    type: "function",
    function: {
      name: "resolve_provisioning",
      description:
        "Return a provisioning proposal ONLY after you understand the workload well enough to recommend a solid plan. Prefer asking clarifying questions in plain text first when intent, stack, scale, or storage needs are unclear.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", description: "Must be one of: provision, propose. Prefer propose." },
          kind: { type: "string", description: "Must be one of: vm, container, stack." },
          templateId: { type: "string", description: "Template catalog id for vm/container proposals." },
          stackId: { type: "string", description: "Stack catalog id for stack proposals." },
          hostname: { type: "string", description: "Hostname for a vm/container proposal." },
          hostnamePrefix: { type: "string", description: "Hostname prefix for a stack proposal." },
          size: {
            type: "string",
            description:
              "T-shirt size key from the Available sizes list. Choose the size that fits the WORKLOAD, not whatever word the user casually used if that word is undersized.",
          },
          cpu: { type: "number", description: "Exact CPU cores only when the user gave an exact number; otherwise use size." },
          memoryGB: { type: "number", description: "Exact memory GB only when the user gave an exact amount; otherwise use size." },
          additionalDiskGB: {
            type: "number",
            description:
              "Optional extra data disk in GB (beyond the template OS disk). Use for NFS, file shares, databases, media, backups, or whenever the user needs dedicated storage.",
          },
          environment: {
            type: "string",
            description: "Network iface from Available networks only. Omit if unknown and multiple networks exist.",
          },
          username: { type: "string", description: "Login username only when the user specifies one." },
          packages: {
            type: "array",
            items: { type: "string" },
            description: "Package ids from the Allowed packages list that fit the chosen stack/workload.",
          },
          rationale: {
            type: "string",
            description:
              "Short plan summary (2–4 sentences) explaining what you are proposing and why it fits the user's goal.",
          },
          sizeReason: {
            type: "string",
            description: "One or two sentences explaining why this size (CPU/RAM) is appropriate for the workload.",
          },
          packageNotes: {
            type: "string",
            description:
              "Brief explanation of why the selected packages were chosen (group related packages together).",
          },
          storageNote: {
            type: "string",
            description:
              "If additionalDiskGB is set, explain why that data-disk size was chosen. Otherwise omit or leave empty.",
          },
          ttlDays: {
            type: "number",
            description: "Requested lifetime in days when the user said how long they need it (e.g. 2 days → 2). Omit if permanent or unknown.",
          },
          permanent: {
            type: "boolean",
            description: "True when the user asked for a permanent resource with no auto-decommission.",
          },
        },
        required: ["action", "kind", "rationale", "sizeReason"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "manage_resources",
      description: "List assigned resources or run lifecycle actions on a specific VM/container.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", description: "Must be one of: list_owned, status, reboot, shutdown, delete." },
          type: { type: "string", description: "Optional resource type filter/target: vm or container." },
          vmid: { type: "number", description: "Optional target VMID for action." },
          name: { type: "string", description: "Optional target resource name for action." },
        },
        required: ["action"],
      },
    },
  },
];

/** Gemini functionDeclarations (uppercase schema types). */
export const GEMINI_FUNCTION_DECLARATIONS = OPENAI_TOOLS.map((t) => {
  const fn = t.function;
  const params = JSON.parse(JSON.stringify(fn.parameters));
  const up = (node) => {
    if (!node || typeof node !== "object") return;
    if (typeof node.type === "string") node.type = node.type.toUpperCase();
    if (node.items) up(node.items);
    if (node.properties) Object.values(node.properties).forEach(up);
  };
  up(params);
  return { name: fn.name, description: fn.description, parameters: params };
});

/** Anthropic tools array. */
export const ANTHROPIC_TOOLS = OPENAI_TOOLS.map((t) => ({
  name: t.function.name,
  description: t.function.description,
  input_schema: t.function.parameters,
}));

export function buildSystemInstruction() {
  const vmList = [...mappedVmTemplates(), ...internalVmTemplates()]
    .map((t) => `  - id: "${t.id}", name: "${t.name}"`)
    .join("\n") || "  (none configured yet)";
  const containerList = listContainerTemplates().length
    ? listContainerTemplates().map((t) => `  - id: "${t.id}", name: "${t.name}"`).join("\n")
    : "  (none configured yet)";
  const stackList = listStackTemplates().map((s) => `  - id: "${s.id}", name: "${s.name}" — ${s.description || ""}`).join("\n") || "  (none configured yet)";
  const networkList = Object.entries(getNetworkMappings())
    .filter(([, m]) => m.label && String(m.label).trim())
    .map(([iface, m]) => `  - iface: "${iface}", label: "${m.label}"`)
    .join("\n") || "  (none configured yet)";
  const rates = getCostRates();
  const currency = rates.currency || "INR";
  const money = (n) => {
    const v = Math.round(Number(n) || 0);
    if (currency === "INR") return `₹${v.toLocaleString("en-IN")}`;
    const sym = { EUR: "€", USD: "$", GBP: "£" }[currency] || "";
    return `${sym}${v}`;
  };
  const sizeCostHint = (cpu, memoryGB) =>
    money((Number(cpu) || 0) * (rates.perCpu || 0) + (Number(memoryGB) || 0) * (rates.perGbRam || 0));
  const sizeList = listInstanceSizes().length
    ? listInstanceSizes()
        .map(
          (s) =>
            `  - key: "${s.key}", label: "${s.label}", cpu: ${s.cpu}, memoryGB: ${s.memoryGB}, approxMonthly: ${sizeCostHint(s.cpu, s.memoryGB)} (CPU+RAM only)`
        )
        .join("\n")
    : "  (none configured — invent sensible cpu/memoryGB)";
  const packageList = listPackages().length
    ? listPackages().map((p) => `  - id: "${p.id}", name: "${p.name}"${p.category ? `, category: "${p.category}"` : ""}`).join("\n")
    : "  (none configured yet)";
  const rateLine = `Cost rates (monthly): ${money(rates.perCpu)}/CPU, ${money(rates.perGbRam)}/GB RAM, ${money(rates.perGbStorage)}/GB extra data disk. Currency: ${currency}.`;

  return `You are ${AI_ASSISTANT_NAME}, the cloud advisor for ${PRODUCT_NAME} (Proxmox-based private cloud).
You are NOT a form-filler. You are a helpful infrastructure consultant: understand the goal, ask smart follow-ups, then recommend a clear plan with reasons.

## Conversation style
1. Understand what the user wants to achieve (workload, audience, data, lifetime).
2. If anything important is missing or the user's assumption is wrong, reply in PLAIN TEXT with 1–2 short, concrete questions. Do NOT call a function yet. End that reply with exactly one line in this format so the UI can show tap-to-reply chips:
   SUGGESTIONS: short answer 1 | short answer 2 | short answer 3
   Keep each suggestion under ~40 characters. Example: SUGGESTIONS: Static site | Node.js API | WordPress
3. When you have enough to recommend a solid plan, call resolve_provisioning with action=propose and fill rationale / sizeReason / packageNotes (and storageNote / ttlDays when relevant).
4. Be concise, practical, and friendly. Explain trade-offs in plain language. Light markdown is fine in plain-text replies (**bold**, short - lists); keep it readable in chat.
5. If the user says how long they need the resource ("for 2 days", "1 week", "permanent"), set ttlDays or permanent on the proposal.
6. Cost awareness: when recommending medium/large/xl (or ≥8 CPU / ≥16 GB), mention the approximate monthly cost from Available sizes (or compute from Cost rates) in sizeReason so the user sees the trade-off vs a smaller size.
7. Capability honesty: NEVER invent packages, stacks, or templates. If the user asks for something not in the catalog lists below, say so in plain text and suggest the closest listed option (or a VM + packages). Do not silently substitute without explaining.

## When to ask (do not propose yet)
Ask clarifying questions when any of these are unclear:
- Workload / purpose is vague ("a server", "something for testing", "host a website", "need a box").
- Application stack is unknown (static site vs Node vs PHP vs WordPress vs containers, etc.).
- Scale is unknown (personal test vs team vs production traffic; model size for AI; data volume for storage/DB).
- Storage-heavy goals (NFS, file share, media, backups, large DB) without a rough capacity.
- Lifetime / TTL is unknown for anything beyond a quick throwaway test — ask once, with SUGGESTIONS like: 2 days | 1 week | 30 days | Permanent
- User asks for a size that is clearly too small or too large for the stated workload — push back and explain, then suggest a better size (still ask if you need one more detail).

## When you may propose without more questions
- User already gave enough detail (stack + rough scale, or exact CPU/RAM, or "you decide").
- User is refining an existing proposal ("make it large", "add redis", "100GB data disk").
- Lifecycle requests (list/status/reboot/shutdown/delete) → use manage_resources.

## Workload guidance (use judgment; not rigid rules)
- LLM / AI inference / fine-tuning: needs substantial RAM (often large/xl). Never accept "small/micro" for LLM without correcting the user.
- Websites / apps: ask stack + traffic first; size from light (micro/mini) to medium+ for heavier traffic; packages match the stack.
- Databases: ask engine + data size / connections; consider an additional data disk for data directories.
- NFS / file share / media / backups: ask what will be stored and roughly how many GB/TB; recommend additionalDiskGB accordingly; OS disk stays template-sized.
- CI / build / stress test: ask parallelism or expected load before sizing up.
- K8s/k3s/docker hosts: prefer sizes with headroom; include matching packages from the allowed list.

## Catalog rules
${rateLine}

Available VM templates:
${vmList}

Available container templates:
${containerList}

Available stacks:
${stackList}

Available sizes (prefer these keys; approxMonthly is CPU+RAM only):
${sizeList}

Available networks (VM environment):
${networkList}

Allowed packages (id must match exactly):
${packageList}

- Map OS names to templateId from the VM list (e.g. redhat/rhel → matching RHEL template id such as tpl-…). Never invent ids.
- kind=container only when user asks for container/lxc; kind=stack only with a real stackId from Available stacks; otherwise prefer vm.
- Never invent network ifaces. If exactly one network is listed, set environment to that iface. If multiple and unspecified, ask which label to use (plain text).
- OS disk always comes from the template — never resize it. Use additionalDiskGB for extra data volumes when needed.
- Invent a short hostname if the user did not provide one.
- Prefer T-shirt size keys over raw cpu/memoryGB unless the user gave exact numbers.
- If the user casually says a size that conflicts with the workload (e.g. "small for LLM"), do NOT blindly use that size. Explain the mismatch in plain text (or in rationale when proposing) and recommend a suitable size from Available sizes.
- Packages: only ids from the Allowed packages list. Explain why in packageNotes. If they asked for software not listed, name it in packageNotes as unavailable and offer the closest allowed ids.
- VMs need environment eventually; one network → auto-set; multiple → ask first unless refining a proposal that already has one.
- Never call a function with templateId/stackId/environment/package ids that are not in the lists above.

## Tool use
- resolve_provisioning: only when ready to propose (or immediate provision for non-VM with fully explicit details). Always include rationale and sizeReason.
- REFINING: if refining a prior proposal, call resolve_provisioning with action=propose, kind, and ONLY changed fields (+ updated rationale/sizeReason if size/packages/storage change). Backend merges onto the previous proposal.
- manage_resources: for listing owned resources or status/reboot/shutdown/delete.
- If the message is small talk or a general portal question, reply in plain text with no function call.
- Do not invent rationale placeholders; write real advice tailored to this conversation.`;
}
