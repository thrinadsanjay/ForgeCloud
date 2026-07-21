import { prisma, fireAndForget } from "../db/client.js";

// Field visibility: showWhen = { key, equals? | equalsAny? | isTrue? | isFalse? }
// boolNegated fields store UI "checked" as the positive product of env !== "false".

export const SETTING_GROUPS = [
  {
    id: "proxmox",
    title: "Proxmox connection",
    note: "Applies immediately. Choose password or API-token auth — only the fields you need are shown.",
    live: true,
    fields: [
      { key: "PROXMOX_HOST", label: "Host / IP", type: "text", placeholder: "10.0.0.10" },
      { key: "PROXMOX_PORT", label: "Port", type: "text", placeholder: "8006" },
      { key: "PROXMOX_NODE", label: "Node name", type: "text", placeholder: "pve", hint: "Must match the Proxmox node (e.g. pve). Leave blank to auto-detect." },
      { type: "section", key: "_pve_auth", label: "Authentication" },
      {
        key: "PROXMOX_USE_API_TOKEN",
        label: "Auth method",
        type: "select",
        options: [
          { value: "false", label: "Username & password" },
          { value: "true", label: "API token" },
        ],
        default: "false",
      },
      { key: "PROXMOX_USERNAME", label: "Username", type: "text", placeholder: "root@pam",
        showWhen: { key: "PROXMOX_USE_API_TOKEN", equalsAny: ["false", false, "", null, undefined] } },
      { key: "PROXMOX_PASSWORD", label: "Password", type: "text", secret: true,
        showWhen: { key: "PROXMOX_USE_API_TOKEN", equalsAny: ["false", false, "", null, undefined] } },
      { key: "PROXMOX_TOKEN_ID", label: "API token ID", type: "text", placeholder: "root@pam!forge-portal",
        showWhen: { key: "PROXMOX_USE_API_TOKEN", equalsAny: ["true", true] } },
      { key: "PROXMOX_TOKEN_SECRET", label: "API token secret", type: "text", secret: true,
        showWhen: { key: "PROXMOX_USE_API_TOKEN", equalsAny: ["true", true] } },
      { key: "PROXMOX_VERIFY_SSL", label: "Verify TLS certificate", type: "bool" },
    ],
  },
  {
    id: "k3s",
    title: "K3s / Kubernetes API",
    note: "Applies immediately — used to talk to the K3s cluster API.",
    live: true,
    fields: [
      { key: "K3S_API_URL", label: "API server URL", type: "text", placeholder: "https://10.0.0.20:6443" },
      { key: "K3S_API_TOKEN", label: "API token", type: "text", secret: true },
      { key: "K3S_VERIFY_TLS", label: "Verify TLS certificate", type: "bool" },
    ],
  },
  {
    id: "vm",
    title: "VM defaults",
    note: "Applies immediately to newly provisioned resources.",
    live: true,
    fields: [
      { key: "VM_SSH_PASSWORD", label: "Default cloud-init SSH password", type: "text", secret: true },
      { key: "SNIPPET_STORAGE", label: "Cloud-init snippet storage", type: "text", placeholder: "local",
        note: "Must allow content type Snippets in Proxmox (Datacenter → Storage → Edit)." },
    ],
  },
  {
    id: "ansible",
    title: "Ansible (Forge controller)",
    note: "When enabled, Forge runs the in-image Ansible initial_setup role over SSH after the guest gets an IP. Windows guests are not supported yet.",
    live: true,
    fields: [
      { key: "ANSIBLE_ENABLED", label: "Enable Ansible guest setup", type: "bool", default: "false" },
      { key: "ANSIBLE_BOOTSTRAP_CLOUDINIT", label: "Bootstrap service account via minimal cloud-init", type: "bool", default: "true",
        showWhen: { key: "ANSIBLE_ENABLED", isTrue: true } },
      { key: "ANSIBLE_SERVICE_USER", label: "Service account username", type: "text", placeholder: "forge", default: "forge",
        showWhen: { key: "ANSIBLE_ENABLED", isTrue: true } },
      { key: "ANSIBLE_SERVICE_PASSWORD", label: "Service account password (optional)", type: "text", secret: true,
        showWhen: { key: "ANSIBLE_ENABLED", isTrue: true } },
      { key: "ANSIBLE_ADMIN_PUBKEY", label: "Admin / org SSH public key", type: "text",
        placeholder: "ssh-ed25519 AAAA…",
        showWhen: { key: "ANSIBLE_ENABLED", isTrue: true } },
      { key: "ANSIBLE_FORGE_PUBLIC_KEY", label: "Forge deploy public key", type: "text",
        placeholder: "ssh-ed25519 AAAA…",
        showWhen: { key: "ANSIBLE_ENABLED", isTrue: true } },
      { key: "ANSIBLE_FORGE_PRIVATE_KEY", label: "Forge deploy private key", type: "text", secret: true,
        showWhen: { key: "ANSIBLE_ENABLED", isTrue: true } },
      { key: "ANSIBLE_REMOVE_FORGE_KEY", label: "Remove Forge deploy key after successful setup", type: "bool", default: "true",
        showWhen: { key: "ANSIBLE_ENABLED", isTrue: true } },
    ],
  },
  {
    id: "internal",
    title: "Internal provisioning systems",
    note: "Enable each integration to configure its endpoint. Blank/unenabled steps are simulated until set up.",
    live: true,
    fields: [
      { type: "section", key: "_int_linux", label: "Linux team API" },
      { key: "INTERNAL_LINUX_ENABLED", label: "Enable Linux team API", type: "bool" },
      { key: "INTERNAL_LINUX_URL", label: "API URL", type: "text", placeholder: "https://linux.internal/api",
        showWhen: { key: "INTERNAL_LINUX_ENABLED", isTrue: true } },
      { key: "INTERNAL_LINUX_TOKEN", label: "API token", type: "text", secret: true,
        showWhen: { key: "INTERNAL_LINUX_ENABLED", isTrue: true } },

      { type: "section", key: "_int_net", label: "Network team API" },
      { key: "INTERNAL_NETWORK_ENABLED", label: "Enable Network team API", type: "bool" },
      { key: "INTERNAL_NETWORK_URL", label: "API URL", type: "text", placeholder: "https://network.internal/api/ip",
        showWhen: { key: "INTERNAL_NETWORK_ENABLED", isTrue: true } },
      { key: "INTERNAL_NETWORK_TOKEN", label: "API token", type: "text", secret: true,
        showWhen: { key: "INTERNAL_NETWORK_ENABLED", isTrue: true } },

      { type: "section", key: "_int_compute", label: "Compute & Storage team API" },
      { key: "INTERNAL_COMPUTE_ENABLED", label: "Enable Compute & Storage API", type: "bool" },
      { key: "INTERNAL_COMPUTE_URL", label: "API URL", type: "text", placeholder: "https://compute.internal/api",
        showWhen: { key: "INTERNAL_COMPUTE_ENABLED", isTrue: true } },
      { key: "INTERNAL_COMPUTE_TOKEN", label: "API token", type: "text", secret: true,
        showWhen: { key: "INTERNAL_COMPUTE_ENABLED", isTrue: true } },

      { type: "section", key: "_int_linux_aap", label: "Linux Ansible (AAP)" },
      { key: "INTERNAL_LINUX_ANSIBLE_ENABLED", label: "Enable Linux Ansible", type: "bool" },
      { key: "INTERNAL_LINUX_ANSIBLE_URL", label: "Launch URL", type: "text", placeholder: "https://aap.internal/api/v2/job_templates/…/launch/",
        showWhen: { key: "INTERNAL_LINUX_ANSIBLE_ENABLED", isTrue: true } },
      { key: "INTERNAL_LINUX_ANSIBLE_TOKEN", label: "Token", type: "text", secret: true,
        showWhen: { key: "INTERNAL_LINUX_ANSIBLE_ENABLED", isTrue: true } },

      { type: "section", key: "_int_snow_aap", label: "ServiceNow Ansible" },
      { key: "INTERNAL_SERVICENOW_ANSIBLE_ENABLED", label: "Enable ServiceNow Ansible", type: "bool" },
      { key: "INTERNAL_SERVICENOW_ANSIBLE_URL", label: "Launch URL", type: "text", placeholder: "https://aap.internal/api/v2/job_templates/…/launch/",
        showWhen: { key: "INTERNAL_SERVICENOW_ANSIBLE_ENABLED", isTrue: true } },
      { key: "INTERNAL_SERVICENOW_ANSIBLE_TOKEN", label: "Token", type: "text", secret: true,
        showWhen: { key: "INTERNAL_SERVICENOW_ANSIBLE_ENABLED", isTrue: true } },

      { type: "section", key: "_int_common", label: "Common" },
      { key: "INTERNAL_VERIFY_TLS", label: "Verify TLS certificates", type: "bool" },
      { key: "INTERNAL_HTTP_TIMEOUT_MS", label: "HTTP timeout (ms)", type: "number", placeholder: "30000" },
    ],
  },
  {
    id: "servicenow",
    title: "ServiceNow (ITSM)",
    note: "Applies immediately. Core connection always shown; expand catalog, CMDB, and incidents only when enabled.",
    live: true,
    fields: [
      { key: "SERVICENOW_INSTANCE_URL", label: "Instance URL", type: "text", placeholder: "https://yourcompany.service-now.com" },
      { key: "SERVICENOW_USERNAME", label: "Username", type: "text", placeholder: "forge.integration" },
      { key: "SERVICENOW_PASSWORD", label: "Password", type: "text", secret: true },
      { key: "SERVICENOW_VERIFY_TLS", label: "Verify TLS certificate", type: "bool" },
      { key: "SERVICENOW_HTTP_TIMEOUT_MS", label: "HTTP timeout (ms)", type: "number", placeholder: "15000" },

      { type: "section", key: "_snow_cat", label: "Catalog requests" },
      { key: "SERVICENOW_CATALOG_ENABLED", label: "Create REQ/RITM on provision submit", type: "bool" },
      { key: "SERVICENOW_CATALOG_ITEM_SYS_ID", label: "Catalog item sys_id", type: "text", placeholder: "abc123…",
        showWhen: { key: "SERVICENOW_CATALOG_ENABLED", isTrue: true } },
      { key: "SERVICENOW_ASSIGNMENT_GROUP_SYS_ID", label: "Assignment group sys_id", type: "text", placeholder: "optional",
        showWhen: { key: "SERVICENOW_CATALOG_ENABLED", isTrue: true } },
      { key: "SERVICENOW_REQUESTED_FOR_SYS_ID", label: "Requested For (user sys_id)", type: "text", placeholder: "optional",
        showWhen: { key: "SERVICENOW_CATALOG_ENABLED", isTrue: true } },
      { key: "SERVICENOW_OPENED_BY_SYS_ID", label: "Opened by (user sys_id)", type: "text", placeholder: "optional",
        showWhen: { key: "SERVICENOW_CATALOG_ENABLED", isTrue: true } },
      { key: "SERVICENOW_USER_LOOKUP_ENABLED", label: "Resolve portal user → ServiceNow sys_user (by email)", type: "bool",
        showWhen: { key: "SERVICENOW_CATALOG_ENABLED", isTrue: true } },

      { type: "section", key: "_snow_cmdb", label: "CMDB" },
      { key: "SERVICENOW_CMDB_ENABLED", label: "Create CMDB CI on successful provision", type: "bool" },
      { key: "SERVICENOW_CMDB_CLASS", label: "CMDB table", type: "text", placeholder: "cmdb_ci_server",
        showWhen: { key: "SERVICENOW_CMDB_ENABLED", isTrue: true } },
      { key: "SERVICENOW_CMDB_COMPANY_SYS_ID", label: "Company sys_id", type: "text", placeholder: "optional",
        showWhen: { key: "SERVICENOW_CMDB_ENABLED", isTrue: true } },
      { key: "SERVICENOW_CMDB_LOCATION_SYS_ID", label: "Location sys_id", type: "text", placeholder: "optional",
        showWhen: { key: "SERVICENOW_CMDB_ENABLED", isTrue: true } },
      { key: "SERVICENOW_CMDB_SUPPORT_GROUP_SYS_ID", label: "Support group sys_id", type: "text", placeholder: "optional",
        showWhen: { key: "SERVICENOW_CMDB_ENABLED", isTrue: true } },

      { type: "section", key: "_snow_inc", label: "Incidents" },
      { key: "SERVICENOW_INCIDENTS_ENABLED", label: "Raise an incident when a deployment fails", type: "bool" },
      { key: "SERVICENOW_CALLER_SYS_ID", label: "Incident caller sys_id", type: "text", placeholder: "optional",
        showWhen: { key: "SERVICENOW_INCIDENTS_ENABLED", isTrue: true } },
    ],
  },
  {
    id: "n8n",
    title: "n8n / workflow webhooks",
    note: "Applies immediately. Enable webhooks, then configure the URL and signing secret.",
    live: true,
    fields: [
      { key: "N8N_WEBHOOK_ENABLED", label: "Send lifecycle webhooks", type: "bool" },
      { key: "N8N_WEBHOOK_URL", label: "Webhook URL", type: "text", placeholder: "https://n8n.internal/webhook/forge-provision",
        showWhen: { key: "N8N_WEBHOOK_ENABLED", isTrue: true } },
      { key: "N8N_WEBHOOK_SECRET", label: "Webhook signing secret", type: "text", secret: true,
        showWhen: { key: "N8N_WEBHOOK_ENABLED", isTrue: true } },
      { key: "N8N_VERIFY_TLS", label: "Verify TLS certificate", type: "bool",
        showWhen: { key: "N8N_WEBHOOK_ENABLED", isTrue: true } },
      { key: "N8N_HTTP_TIMEOUT_MS", label: "HTTP timeout (ms)", type: "number", placeholder: "10000",
        showWhen: { key: "N8N_WEBHOOK_ENABLED", isTrue: true } },
    ],
  },
  {
    id: "ipam",
    title: "IPAM (IP Address Management)",
    note: "Optional. When configured, Forge can reserve static IPs later. Until then (and whenever IPAM is not linked), guests use DHCP on the selected network.",
    live: true,
    fields: [
      { key: "IPAM_URL", label: "API base URL", type: "text", placeholder: "https://ipam.internal/api/v2" },
      { key: "IPAM_USERNAME", label: "Username / App ID", type: "text", placeholder: "forge" },
      { key: "IPAM_API_TOKEN", label: "API token / key", type: "text", secret: true },
      { key: "IPAM_VERIFY_TLS", label: "Verify TLS certificate", type: "bool" },
    ],
  },
  {
    id: "ai",
    title: "AI assistant (Forge Assist)",
    note: "Free Gemini tier works for testing. Get a key at aistudio.google.com/apikey — not a Cursor (crsr_) key.",
    live: true,
    fields: [
      {
        key: "AI_PROVIDER",
        label: "Provider",
        type: "select",
        options: [
          { value: "gemini", label: "Google Gemini" },
          { value: "openai", label: "OpenAI (ChatGPT)" },
          { value: "anthropic", label: "Anthropic (Claude)" },
          { value: "openrouter", label: "OpenRouter (multi-model)" },
          { value: "ollama", label: "Ollama (local)" },
        ],
        placeholder: "gemini",
        default: "gemini",
      },
      { key: "GEMINI_API_KEY", label: "API key", type: "text", secret: true,
        showWhen: { key: "AI_PROVIDER", equals: "gemini" },
        hint: "From Google AI Studio only. Cursor keys will not work." },
      {
        key: "GEMINI_MODEL",
        label: "Model",
        type: "select",
        showWhen: { key: "AI_PROVIDER", equals: "gemini" },
        default: "gemini-2.0-flash",
        options: [
          { value: "gemini-2.0-flash", label: "gemini-2.0-flash (best for free tier)" },
          { value: "gemini-flash-latest", label: "gemini-flash-latest" },
          { value: "gemini-1.5-flash", label: "gemini-1.5-flash" },
          { value: "gemini-2.5-flash", label: "gemini-2.5-flash" },
        ],
      },

      { key: "OPENAI_API_KEY", label: "API key", type: "text", secret: true,
        showWhen: { key: "AI_PROVIDER", equals: "openai" } },
      { key: "OPENAI_MODEL", label: "Model", type: "text", placeholder: "gpt-4o-mini",
        showWhen: { key: "AI_PROVIDER", equals: "openai" } },
      { key: "OPENAI_BASE_URL", label: "Base URL (optional)", type: "text", placeholder: "https://api.openai.com/v1",
        showWhen: { key: "AI_PROVIDER", equals: "openai" },
        hint: "Corporate proxy or Azure OpenAI-compatible endpoint." },

      { key: "ANTHROPIC_API_KEY", label: "API key", type: "text", secret: true,
        showWhen: { key: "AI_PROVIDER", equals: "anthropic" } },
      { key: "ANTHROPIC_MODEL", label: "Model", type: "text", placeholder: "claude-sonnet-4-20250514",
        showWhen: { key: "AI_PROVIDER", equals: "anthropic" } },

      { key: "OPENROUTER_API_KEY", label: "API key", type: "text", secret: true,
        showWhen: { key: "AI_PROVIDER", equals: "openrouter" } },
      { key: "OPENROUTER_MODEL", label: "Model", type: "text", placeholder: "openai/gpt-4o-mini",
        showWhen: { key: "AI_PROVIDER", equals: "openrouter" },
        hint: "Examples: anthropic/claude-sonnet-4, openai/gpt-4o, google/gemini-2.0-flash." },

      { key: "OLLAMA_BASE_URL", label: "Base URL", type: "text", placeholder: "http://127.0.0.1:11434/v1",
        showWhen: { key: "AI_PROVIDER", equals: "ollama" },
        hint: "From Docker use http://host.docker.internal:11434/v1." },
      { key: "OLLAMA_MODEL", label: "Model", type: "text", placeholder: "llama3.2",
        showWhen: { key: "AI_PROVIDER", equals: "ollama" } },
    ],
  },
  {
    id: "cost",
    title: "Cost estimation",
    note: "Applies immediately. Per-month unit prices used on the provisioning form.",
    live: true,
    fields: [
      { key: "COST_PER_CPU", label: "Per CPU core (₹ / month)", type: "number", placeholder: "1800", default: "1800" },
      { key: "COST_PER_GB_RAM", label: "Per GB RAM (₹ / month)", type: "number", placeholder: "85", default: "85" },
      { key: "COST_PER_GB_STORAGE", label: "Per GB storage (₹ / month)", type: "number", placeholder: "12", default: "12" },
    ],
  },
  {
    id: "approvals",
    title: "Approval policy",
    note: "Applies immediately. Turn off auto-approve so CPU / RAM / disk over the thresholds need Approver or Admin approval.",
    live: true,
    fields: [
      { key: "AUTO_APPROVE_DEPLOYMENTS", label: "Auto-approve all deployments", type: "boolNegated",
        hint: "When off, deployments over the thresholds below need admin approval." },
      { key: "APPROVAL_CPU_THRESHOLD", label: "CPU cores threshold", type: "number", placeholder: "2",
        showWhen: { key: "AUTO_APPROVE_DEPLOYMENTS", isFalse: true } },
      { key: "APPROVAL_MEMORY_GB_THRESHOLD", label: "Memory (GB) threshold", type: "number", placeholder: "4",
        showWhen: { key: "AUTO_APPROVE_DEPLOYMENTS", isFalse: true } },
      { key: "APPROVAL_DISK_GB_THRESHOLD", label: "Disk (GB) threshold", type: "number", placeholder: "50",
        showWhen: { key: "AUTO_APPROVE_DEPLOYMENTS", isFalse: true } },
    ],
  },
  {
    id: "oidc",
    title: "OIDC SSO",
    note: "Takes effect after a backend restart. Works with any OpenID Connect provider (Entra ID, Okta, Keycloak, Google, …). Leave blank to disable SSO.",
    live: false,
    fields: [
      { key: "OIDC_ISSUER", label: "Issuer URL", type: "text",
        placeholder: "https://login.microsoftonline.com/{tenant}/v2.0",
        hint: "Provider discovery URL base (no /.well-known/... path). Entra example: https://login.microsoftonline.com/<tenant-id>/v2.0" },
      { key: "OIDC_CLIENT_ID", label: "Client ID", type: "text" },
      { key: "OIDC_CLIENT_SECRET", label: "Client secret", type: "text", secret: true },
      { key: "OIDC_REDIRECT_URI", label: "Redirect URI", type: "text",
        placeholder: "http://localhost:5273/auth/oidc/callback" },
      { key: "OIDC_SCOPES", label: "Scopes", type: "text", placeholder: "openid profile email", default: "openid profile email" },
    ],
  },
];

const FIELD_BY_KEY = new Map();
for (const group of SETTING_GROUPS) {
  for (const field of group.fields) {
    if (field.type === "section") continue;
    FIELD_BY_KEY.set(field.key, field);
  }
}

let overrides = {};

export async function hydrateSettings() {
  const rows = await prisma.setting.findMany();
  overrides = {};
  for (const row of rows) overrides[row.key] = row.value;

  // Migrate legacy Entra settings → OIDC keys when OIDC is unset.
  const map = [
    ["ENTRA_CLIENT_ID", "OIDC_CLIENT_ID"],
    ["ENTRA_CLIENT_SECRET", "OIDC_CLIENT_SECRET"],
    ["ENTRA_REDIRECT_URI", "OIDC_REDIRECT_URI"],
  ];
  for (const [from, to] of map) {
    if (!overrides[to] && (overrides[from] || process.env[from])) {
      overrides[to] = overrides[from] || process.env[from];
    }
  }
  if (!overrides.OIDC_ISSUER && !process.env.OIDC_ISSUER) {
    const tenant = overrides.ENTRA_TENANT_ID || process.env.ENTRA_TENANT_ID;
    if (tenant) overrides.OIDC_ISSUER = `https://login.microsoftonline.com/${tenant}/v2.0`;
  }

  // Migrate Proxmox token bool display for select field (env is "true"/"false").
  if (overrides.PROXMOX_USE_API_TOKEN == null && process.env.PROXMOX_USE_API_TOKEN != null) {
    overrides.PROXMOX_USE_API_TOKEN = process.env.PROXMOX_USE_API_TOKEN;
  }

  // Auto-enable internal systems that already have a URL (pre-toggle installs).
  const internalEnablePairs = [
    ["INTERNAL_LINUX_URL", "INTERNAL_LINUX_ENABLED"],
    ["INTERNAL_NETWORK_URL", "INTERNAL_NETWORK_ENABLED"],
    ["INTERNAL_COMPUTE_URL", "INTERNAL_COMPUTE_ENABLED"],
    ["INTERNAL_LINUX_ANSIBLE_URL", "INTERNAL_LINUX_ANSIBLE_ENABLED"],
    ["INTERNAL_SERVICENOW_ANSIBLE_URL", "INTERNAL_SERVICENOW_ANSIBLE_ENABLED"],
  ];
  for (const [urlKey, enableKey] of internalEnablePairs) {
    if (overrides[enableKey] != null || process.env[enableKey] != null) continue;
    const url = overrides[urlKey] || process.env[urlKey];
    if (url && String(url).trim()) overrides[enableKey] = "true";
  }
}

function persistSettings() {
  const entries = Object.entries(overrides);
  fireAndForget(
    prisma.$transaction(
      entries.map(([key, value]) =>
        prisma.setting.upsert({ where: { key }, create: { key, value: String(value) }, update: { value: String(value) } })
      )
    ),
    "settings"
  );
}

function readOverrides() {
  return { ...overrides };
}

export function applyToEnv() {
  const keepIfBlank = new Set([
    "PROXMOX_HOST",
    "PROXMOX_PORT",
    "PROXMOX_NODE",
    "PROXMOX_USERNAME",
    "PROXMOX_TOKEN_ID",
    "DATABASE_URL",
    "AI_PROVIDER",
    "GEMINI_MODEL",
    "OPENAI_MODEL",
    "ANTHROPIC_MODEL",
    "OPENROUTER_MODEL",
    "OLLAMA_MODEL",
    "OLLAMA_BASE_URL",
    "OPENAI_BASE_URL",
    "OIDC_ISSUER",
    "OIDC_CLIENT_ID",
    "OIDC_REDIRECT_URI",
    "OIDC_SCOPES",
  ]);

  for (const [key, value] of Object.entries(overrides)) {
    if (!FIELD_BY_KEY.has(key) || value == null) continue;
    const str = String(value);
    if (keepIfBlank.has(key) && str.trim() === "") continue;
    process.env[key] = str;
  }

  // Keep Entra aliases populated for any legacy code paths.
  if (process.env.OIDC_CLIENT_ID && !process.env.ENTRA_CLIENT_ID) {
    process.env.ENTRA_CLIENT_ID = process.env.OIDC_CLIENT_ID;
  }
  if (process.env.OIDC_CLIENT_SECRET && !process.env.ENTRA_CLIENT_SECRET) {
    process.env.ENTRA_CLIENT_SECRET = process.env.OIDC_CLIENT_SECRET;
  }
  if (process.env.OIDC_REDIRECT_URI && !process.env.ENTRA_REDIRECT_URI) {
    process.env.ENTRA_REDIRECT_URI = process.env.OIDC_REDIRECT_URI;
  }
}

function isSecretSet(key) {
  const v = process.env[key];
  return typeof v === "string" && v.trim() !== "" && v !== "CHANGE_ME";
}

export function getEffectiveSettings() {
  return {
    groups: SETTING_GROUPS.map((group) => ({
      id: group.id,
      title: group.title,
      note: group.note,
      live: group.live,
      fields: group.fields.map((field) => {
        if (field.type === "section") {
          return { key: field.key, type: "section", label: field.label, showWhen: field.showWhen || null };
        }
        const raw = process.env[field.key] ?? "";
        const base = {
          key: field.key,
          label: field.label,
          type: field.type,
          placeholder: field.placeholder || "",
          hint: field.hint || "",
          showWhen: field.showWhen || null,
          ...(field.options ? { options: field.options } : {}),
          ...(field.default != null ? { default: field.default } : {}),
        };
        if (field.secret) {
          return { ...base, secret: true, isSet: isSecretSet(field.key), value: "" };
        }
        if (field.type === "bool") {
          return { ...base, value: raw === "true" };
        }
        if (field.type === "boolNegated") {
          return { ...base, value: raw !== "false" };
        }
        // Select values that represent booleans (Proxmox auth method)
        if (field.type === "select" && field.key === "PROXMOX_USE_API_TOKEN") {
          return { ...base, value: raw === "true" ? "true" : "false" };
        }
        if (raw === "" && field.default != null) {
          return { ...base, value: field.default };
        }
        return { ...base, value: raw };
      }),
    })),
  };
}

export function updateSettings(patch = {}) {
  for (const [key, value] of Object.entries(patch)) {
    const field = FIELD_BY_KEY.get(key);
    if (!field) continue;

    if (field.secret) {
      if (value == null || String(value).trim() === "") continue;
      overrides[key] = String(value).trim();
      continue;
    }

    if (field.type === "bool") {
      overrides[key] = value ? "true" : "false";
      continue;
    }
    if (field.type === "boolNegated") {
      overrides[key] = value ? "true" : "false";
      continue;
    }
    // Auth method select writes "true"/"false" into PROXMOX_USE_API_TOKEN
    overrides[key] = value == null ? "" : String(value);
  }

  persistSettings();
  applyToEnv();
  return getEffectiveSettings();
}

const DEFAULT_COST_RATES = { perCpu: 1800, perGbRam: 85, perGbStorage: 12 };

export async function getCostRatesFromDb() {
  const row = await prisma.costRate.findUnique({ where: { id: "default" } });
  if (!row) return { ...DEFAULT_COST_RATES, currency: "INR" };
  return {
    perCpu: row.perCpu,
    perGbRam: row.perGbRam,
    perGbStorage: row.perGbStorage,
    currency: "INR",
  };
}

let cachedCostRates = null;

export async function hydrateCostRates() {
  cachedCostRates = await getCostRatesFromDb();
}

export function getCostRates() {
  return cachedCostRates || { ...DEFAULT_COST_RATES, currency: "INR" };
}

export async function updateCostRates(rates) {
  const data = {
    perCpu: Number(rates.perCpu) || DEFAULT_COST_RATES.perCpu,
    perGbRam: Number(rates.perGbRam) || DEFAULT_COST_RATES.perGbRam,
    perGbStorage: Number(rates.perGbStorage) || DEFAULT_COST_RATES.perGbStorage,
  };
  await prisma.costRate.upsert({
    where: { id: "default" },
    create: { id: "default", ...data },
    update: data,
  });
  cachedCostRates = { ...data, currency: "INR" };
  return cachedCostRates;
}

export { readOverrides };
