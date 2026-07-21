import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  getSettings, updateSettings,
  testProxmoxConnection, testK3sConnection,
  testServiceNowConnection, testIpamConnection, testN8nWebhook, testAiConnection,
} from "../api/client.js";
import AdminPageHeader from "../components/AdminPageHeader.jsx";

const TESTERS = {
  proxmox: { label: "Test connection", run: testProxmoxConnection },
  k3s: { label: "Test connection", run: testK3sConnection },
  servicenow: { label: "Test connection", run: testServiceNowConnection },
  ipam: { label: "Test connection", run: testIpamConnection },
  n8n: { label: "Send test event", run: testN8nWebhook },
  ai: { label: "Test AI", run: testAiConnection },
};

const NAV_CATEGORIES = [
  {
    id: "infra",
    label: "Infrastructure",
    items: [
      { id: "proxmox", label: "Proxmox", icon: "srv" },
      { id: "k3s", label: "Kubernetes", icon: "k8s" },
      { id: "vm", label: "VM Defaults", icon: "vm" },
    ],
  },
  {
    id: "automation",
    label: "Automation",
    items: [
      { id: "ansible", label: "Ansible", icon: "plug" },
      { id: "internal", label: "Internal Provisioning", icon: "plug" },
      { id: "n8n", label: "n8n Webhooks", icon: "hook" },
      { id: "ai", label: "AI Assistant", icon: "ai" },
    ],
  },
  {
    id: "enterprise",
    label: "Enterprise Integrations",
    items: [
      { id: "servicenow", label: "ServiceNow", icon: "snow" },
      { id: "ipam", label: "IPAM", icon: "net" },
      { id: "oidc", label: "OIDC SSO", icon: "key" },
    ],
  },
  {
    id: "policies",
    label: "Policies",
    items: [
      { id: "cost", label: "Cost Estimation", icon: "cost" },
      { id: "approvals", label: "Approval Policy", icon: "shield" },
    ],
  },
];

const SECTION_META = {
  proxmox: {
    title: "Proxmox",
    summary: "Talks to the Proxmox VE API for clones, power, and cloud-init.",
    docs: "Connection, authentication, and TLS for the hypervisor API.",
  },
  k3s: {
    title: "Kubernetes",
    summary: "Used by Container hosting for namespaces and workloads.",
    docs: "Cluster API URL and service-account token.",
  },
  vm: {
    title: "VM Defaults",
    summary: "Defaults applied when a user provisions without overrides.",
    docs: "Cloud-init password and snippet storage for new VMs.",
  },
  ansible: {
    title: "Ansible",
    summary: "Forge runs initial_setup on Linux guests over SSH after boot.",
    docs: "Enable Ansible, set the service account, and paste Forge deploy keys. Windows guests are not supported yet.",
  },
  internal: {
    title: "Internal Provisioning",
    summary: "Optional internal workflow systems outside Proxmox templates.",
    docs: "Enable each team integration and configure its endpoint.",
  },
  n8n: {
    title: "n8n Webhooks",
    summary: "Fires lifecycle events to an n8n (or similar) webhook.",
    docs: "Enable delivery, set URL, and optional signing secret.",
  },
  ai: {
    title: "AI Assistant",
    summary: "Powers Forge Assist chat and sizing suggestions.",
    docs: "Choose a provider, model, and credentials.",
  },
  servicenow: {
    title: "ServiceNow",
    summary: "Mirrors requests and CMDB CIs into ServiceNow.",
    docs: "Connection plus catalog, CMDB, and incident options.",
  },
  ipam: {
    title: "IPAM",
    summary: "Allocates IPs during provisioning when configured.",
    docs: "API base URL and credentials for IP reservation.",
  },
  oidc: {
    title: "OIDC SSO",
    summary: "Enterprise SSO via OIDC (Entra ID, Google, Okta, Keycloak, LDAP/AD bridge, …).",
    docs: "Issuer, credentials, redirect URI, then test login.",
  },
  cost: {
    title: "Cost Estimation",
    summary: "Unit rates for the live cost estimate on the provision form.",
    docs: "Monthly rates in INR for CPU, RAM, and storage.",
  },
  approvals: {
    title: "Approval Policy",
    summary: "When oversized VMs pause for an approver.",
    docs: "Thresholds that hold deployments for review.",
  },
};

const INTERNAL_INTEGRATIONS = [
  {
    id: "linux",
    title: "Linux Team",
    description: "OS build and package workflows",
    enableKey: "INTERNAL_LINUX_ENABLED",
    fieldKeys: ["INTERNAL_LINUX_ENABLED", "INTERNAL_LINUX_URL", "INTERNAL_LINUX_TOKEN"],
  },
  {
    id: "network",
    title: "Network Team",
    description: "IP and network automation",
    enableKey: "INTERNAL_NETWORK_ENABLED",
    fieldKeys: ["INTERNAL_NETWORK_ENABLED", "INTERNAL_NETWORK_URL", "INTERNAL_NETWORK_TOKEN"],
  },
  {
    id: "compute",
    title: "Compute & Storage",
    description: "Storage and compute team API",
    enableKey: "INTERNAL_COMPUTE_ENABLED",
    fieldKeys: ["INTERNAL_COMPUTE_ENABLED", "INTERNAL_COMPUTE_URL", "INTERNAL_COMPUTE_TOKEN"],
  },
  {
    id: "linux_aap",
    title: "Linux Ansible",
    description: "AAP job template launches",
    enableKey: "INTERNAL_LINUX_ANSIBLE_ENABLED",
    fieldKeys: ["INTERNAL_LINUX_ANSIBLE_ENABLED", "INTERNAL_LINUX_ANSIBLE_URL", "INTERNAL_LINUX_ANSIBLE_TOKEN"],
  },
  {
    id: "snow_aap",
    title: "ServiceNow Ansible",
    description: "Ansible driven from ServiceNow",
    enableKey: "INTERNAL_SERVICENOW_ANSIBLE_ENABLED",
    fieldKeys: ["INTERNAL_SERVICENOW_ANSIBLE_ENABLED", "INTERNAL_SERVICENOW_ANSIBLE_URL", "INTERNAL_SERVICENOW_ANSIBLE_TOKEN"],
  },
  {
    id: "common",
    title: "Common Settings",
    description: "TLS and HTTP timeout for all internal calls",
    enableKey: null,
    fieldKeys: ["INTERNAL_VERIFY_TLS", "INTERNAL_HTTP_TIMEOUT_MS"],
  },
];

const AI_PROVIDERS = [
  { value: "ollama", label: "Ollama", hint: "Local" },
  { value: "openai", label: "OpenAI", hint: "ChatGPT" },
  { value: "gemini", label: "Gemini", hint: "Google" },
  { value: "anthropic", label: "Claude", hint: "Anthropic" },
  { value: "openrouter", label: "OpenRouter", hint: "Multi-model" },
];

const OIDC_STEPS = [
  { id: "provider", label: "Provider" },
  { id: "credentials", label: "Credentials" },
  { id: "redirect", label: "Redirect URI" },
  { id: "test", label: "Test Login" },
];

function formFromGroups(groups) {
  const state = {};
  for (const group of groups) {
    for (const field of group.fields) {
      if (field.type === "section") continue;
      state[field.key] = field.secret ? "" : field.value;
    }
  }
  return state;
}

function isTruthy(v) {
  return v === true || v === "true" || v === 1 || v === "1";
}

function isFalsy(v) {
  return v === false || v === "false" || v === 0 || v === "0" || v === "" || v == null;
}

function isFieldVisible(field, form) {
  const cond = field?.showWhen;
  if (!cond) return true;
  const current = form[cond.key];
  if (cond.isTrue) return isTruthy(current);
  if (cond.isFalse) return isFalsy(current);
  if (Object.prototype.hasOwnProperty.call(cond, "equals")) {
    return String(current ?? "") === String(cond.equals ?? "");
  }
  if (Array.isArray(cond.equalsAny)) {
    return cond.equalsAny.some((v) => {
      if (v == null || v === "") return isFalsy(current);
      if (typeof v === "boolean") return v ? isTruthy(current) : isFalsy(current);
      return String(current ?? "") === String(v);
    });
  }
  return true;
}

function splitIntoCards(fields) {
  const cards = [];
  let current = { key: "_main", title: null, fields: [] };
  for (const field of fields) {
    if (field.type === "section") {
      if (current.fields.length) cards.push(current);
      current = { key: field.key, title: field.label, fields: [] };
      continue;
    }
    current.fields.push(field);
  }
  if (current.fields.length) cards.push(current);
  return cards;
}

function fieldMap(group) {
  const map = {};
  for (const f of group?.fields || []) {
    if (f.type !== "section") map[f.key] = f;
  }
  return map;
}

function fmtTestTime(iso) {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    const today = new Date();
    const sameDay = d.toDateString() === today.toDateString();
    return sameDay
      ? `Today ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
      : d.toLocaleString();
  } catch {
    return "—";
  }
}

function NavIcon({ name }) {
  const common = {
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "1.8",
    strokeLinecap: "round",
    strokeLinejoin: "round",
    "aria-hidden": true,
  };
  if (name === "srv") {
    return (
      <svg {...common}><rect x="3" y="4" width="18" height="6" rx="1.5" /><rect x="3" y="14" width="18" height="6" rx="1.5" /><path d="M7 7h.01M7 17h.01" /></svg>
    );
  }
  if (name === "k8s") {
    return (
      <svg {...common}><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1" /></svg>
    );
  }
  if (name === "vm") {
    return (
      <svg {...common}><rect x="3" y="5" width="18" height="12" rx="2" /><path d="M8 21h8M12 17v4" /></svg>
    );
  }
  if (name === "plug") {
    return (
      <svg {...common}><path d="M9 7v6M15 7v6M7 13h10v2a4 4 0 0 1-4 4h-2a4 4 0 0 1-4-4v-2zM12 19v3" /></svg>
    );
  }
  if (name === "hook") {
    return (
      <svg {...common}><path d="M10 13a5 5 0 0 0 7.5.5l2.5-2.5a5 5 0 0 0-7-7L11 6" /><path d="M14 11a5 5 0 0 0-7.5-.5L4 13a5 5 0 0 0 7 7l2-2" /></svg>
    );
  }
  if (name === "ai") {
    return (
      <svg {...common}><path d="M12 3v3M12 18v3M3 12h3M18 12h3" /><circle cx="12" cy="12" r="4" /></svg>
    );
  }
  if (name === "snow") {
    return (
      <svg {...common}><path d="M12 2v20M4.9 7l14.2 10M4.9 17 19.1 7" /></svg>
    );
  }
  if (name === "net") {
    return (
      <svg {...common}><circle cx="6" cy="6" r="2.5" /><circle cx="18" cy="6" r="2.5" /><circle cx="12" cy="18" r="2.5" /><path d="M8 7.5 10.5 16M16 7.5 13.5 16M8.5 6h7" /></svg>
    );
  }
  if (name === "key") {
    return (
      <svg {...common}><circle cx="8" cy="12" r="3.5" /><path d="M11.5 12H21v3M17 12v3" /></svg>
    );
  }
  if (name === "cost") {
    return (
      <svg {...common}><path d="M12 3v18M8 8.5c0-1.5 1.8-2.5 4-2.5s4 1 4 2.5-1.8 2.5-4 2.5-4 1-4 2.5 1.8 2.5 4 2.5 4-1 4-2.5" /></svg>
    );
  }
  return (
    <svg {...common}><path d="M12 3 4 7v5c0 5 3.5 8.5 8 9 4.5-.5 8-4 8-9V7l-8-4z" /></svg>
  );
}

function Toggle({ checked, onChange }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      className={`switch ${checked ? "on" : ""}`}
      onClick={() => onChange(!checked)}
    >
      <span className="switch-knob" />
    </button>
  );
}

function Field({ field, value, onChange, layout = "row" }) {
  if (field.type === "bool" || field.type === "boolNegated") {
    return (
      <div className={`pc-field pc-field-toggle ${layout === "stack" ? "pc-field-stack" : ""}`}>
        <div className="pc-field-label">
          <label>{field.label}</label>
          {field.hint && <p className="pc-help">{field.hint}</p>}
        </div>
        <Toggle checked={!!value} onChange={(v) => onChange(field.key, v)} />
      </div>
    );
  }

  if (field.type === "select" && Array.isArray(field.options)) {
    return (
      <div className={`pc-field ${layout === "stack" ? "pc-field-stack" : ""}`}>
        <div className="pc-field-label">
          <label htmlFor={`set-${field.key}`}>{field.label}</label>
          {field.hint && <p className="pc-help">{field.hint}</p>}
        </div>
        <select
          id={`set-${field.key}`}
          className="control-select"
          value={value ?? field.default ?? ""}
          onChange={(e) => onChange(field.key, e.target.value)}
        >
          {field.options.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
      </div>
    );
  }

  return (
    <div className={`pc-field ${layout === "stack" ? "pc-field-stack" : ""}`}>
      <div className="pc-field-label">
        <label htmlFor={`set-${field.key}`}>{field.label}</label>
        {field.secret && (
          <span className={`set-tag ${field.isSet ? "on" : ""}`}>{field.isSet ? "configured" : "not set"}</span>
        )}
        {field.hint && <p className="pc-help">{field.hint}</p>}
      </div>
      <input
        id={`set-${field.key}`}
        className="control-input"
        type={field.type === "number" ? "number" : "text"}
        value={value ?? ""}
        placeholder={field.secret && field.isSet ? "•••••••• (leave blank to keep)" : field.placeholder}
        autoComplete={field.secret ? "new-password" : "off"}
        onChange={(e) => onChange(field.key, e.target.value)}
      />
    </div>
  );
}

function SectionCard({ title, description, children, footer }) {
  return (
    <section className="pc-card">
      {(title || description) && (
        <header className="pc-card-head">
          {title && <h3>{title}</h3>}
          {description && <p>{description}</p>}
        </header>
      )}
      <div className="pc-card-body">{children}</div>
      {footer && <footer className="pc-card-foot">{footer}</footer>}
    </section>
  );
}

function StatusRail({ active, meta, secretFields, secretsSet, lastTest, tester }) {
  const status = lastTest
    ? (lastTest.ok ? "connected" : "failed")
    : (active.live ? "pending" : "restart");

  const badge = {
    connected: { label: "Connected", cls: "pc-badge-ok" },
    failed: { label: "Failed", cls: "pc-badge-err" },
    pending: { label: "Pending", cls: "pc-badge-warn" },
    restart: { label: "Restart", cls: "pc-badge-muted" },
  }[status];

  return (
    <aside className="pc-rail" aria-label="Section status">
      <div className="pc-rail-live">
        <span className={`pc-badge ${active.live ? "pc-badge-ok" : "pc-badge-warn"}`}>
          {active.live ? "LIVE" : "RESTART"}
        </span>
        <span className={`pc-badge ${badge.cls}`}>{badge.label}</span>
      </div>

      <dl className="pc-rail-stats">
        {secretFields.length > 0 && (
          <div>
            <dt>Secrets</dt>
            <dd>{secretsSet} configured</dd>
          </div>
        )}
        {tester && (
          <div>
            <dt>Last Test</dt>
            <dd>{lastTest ? fmtTestTime(lastTest.at) : "Not tested"}</dd>
          </div>
        )}
        <div>
          <dt>Connection</dt>
          <dd>{lastTest ? (lastTest.ok ? "Healthy" : "Unhealthy") : "Unknown"}</dd>
        </div>
      </dl>

      {lastTest && (
        <div className={`pc-rail-test ${lastTest.ok ? "ok" : "err"}`}>
          {lastTest.text}
        </div>
      )}

      <div className="pc-rail-help">
        <div className="pc-rail-help-title">Need help?</div>
        <p>{meta?.docs || meta?.summary || active.note}</p>
      </div>
    </aside>
  );
}

function Overview({ groups, onOpen }) {
  const byId = Object.fromEntries(groups.map((g) => [g.id, g]));
  const liveCount = groups.filter((g) => g.live).length;
  return (
    <div className="pc-overview">
      <div className="pc-overview-grid">
        {NAV_CATEGORIES.map((cat) => (
          <section key={cat.id} className="pc-card pc-overview-card">
            <header className="pc-card-head">
              <h3>{cat.label}</h3>
              <p>{cat.items.length} configuration areas</p>
            </header>
            <ul className="pc-overview-list">
              {cat.items.map((item) => {
                const g = byId[item.id];
                return (
                  <li key={item.id}>
                    <button type="button" onClick={() => onOpen(item.id)}>
                      <span className="pc-overview-icon"><NavIcon name={item.icon} /></span>
                      <span>
                        <strong>{item.label}</strong>
                        <em>{g?.live ? "Applies live" : "Restart required"}</em>
                      </span>
                      <span className="pc-overview-chevron">→</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>
      <aside className="pc-rail">
        <div className="pc-rail-live">
          <span className="pc-badge pc-badge-ok">HEALTHY</span>
        </div>
        <dl className="pc-rail-stats">
          <div>
            <dt>Overall</dt>
            <dd>Platform ready</dd>
          </div>
          <div>
            <dt>Sections</dt>
            <dd>{groups.length}</dd>
          </div>
          <div>
            <dt>Live apply</dt>
            <dd>{liveCount}/{groups.length}</dd>
          </div>
        </dl>
        <div className="pc-rail-help">
          <div className="pc-rail-help-title">Platform status</div>
          <p>Pick a category on the left, or open a card to configure an integration.</p>
        </div>
      </aside>
    </div>
  );
}

function GenericCards({ group, form, onChange, actions }) {
  const cards = splitIntoCards(group.fields).map((card) => ({
    ...card,
    fields: card.fields.filter((f) => isFieldVisible(f, form)),
  })).filter((c) => c.fields.length);

  const titled = cards.some((c) => c.title);
  const connectionTitle = titled ? null : "Configuration";

  return (
    <div className="pc-stack">
      {cards.map((card, idx) => (
        <SectionCard
          key={card.key}
          title={card.title || (idx === 0 ? connectionTitle : null)}
          footer={idx === cards.length - 1 ? actions : null}
        >
          {card.fields.map((field) => (
            <Field key={field.key} field={field} value={form[field.key]} onChange={onChange} />
          ))}
        </SectionCard>
      ))}
    </div>
  );
}

function InternalView({ group, form, onChange, actions }) {
  const [selected, setSelected] = useState(null);
  const fmap = fieldMap(group);

  if (selected) {
    const integ = INTERNAL_INTEGRATIONS.find((i) => i.id === selected);
    const fields = (integ?.fieldKeys || [])
      .map((k) => fmap[k])
      .filter(Boolean)
      .filter((f) => isFieldVisible(f, form));

    return (
      <div className="pc-stack">
        <button type="button" className="pc-back" onClick={() => setSelected(null)}>
          ← All integrations
        </button>
        <SectionCard title={integ.title} description={integ.description} footer={actions}>
          {fields.map((field) => (
            <Field key={field.key} field={field} value={form[field.key]} onChange={onChange} />
          ))}
        </SectionCard>
      </div>
    );
  }

  return (
    <div className="pc-stack">
      <div className="pc-integ-grid">
        {INTERNAL_INTEGRATIONS.map((integ) => {
          const enabled = integ.enableKey ? isTruthy(form[integ.enableKey]) : true;
          return (
            <button
              key={integ.id}
              type="button"
              className={`pc-integ-card ${enabled ? "is-on" : "is-off"}`}
              onClick={() => setSelected(integ.id)}
            >
              <div className="pc-integ-top">
                <strong>{integ.title}</strong>
                <span className={`pc-badge ${enabled ? "pc-badge-ok" : "pc-badge-muted"}`}>
                  {integ.enableKey ? (enabled ? "Enabled" : "Disabled") : "Shared"}
                </span>
              </div>
              <p>{integ.description}</p>
              <span className="pc-integ-link">Configure →</span>
            </button>
          );
        })}
      </div>
      <SectionCard footer={actions}>
        <p className="pc-muted-note">Open an integration to configure it, then save from that screen.</p>
      </SectionCard>
    </div>
  );
}

function ServiceNowView({ group, form, onChange, actions }) {
  const cards = splitIntoCards(group.fields);
  const [openKey, setOpenKey] = useState(cards[0]?.key || "_main");

  return (
    <div className="pc-stack">
      <div className="pc-accordion">
        {cards.map((card) => {
          const visible = card.fields.filter((f) => isFieldVisible(f, form));
          if (!visible.length && card.title) return null;
          const isOpen = openKey === card.key;
          return (
            <div key={card.key} className={`pc-acc-item ${isOpen ? "is-open" : ""}`}>
              <button
                type="button"
                className="pc-acc-trigger"
                aria-expanded={isOpen}
                onClick={() => setOpenKey(isOpen ? "" : card.key)}
              >
                <span>{card.title || "Connection"}</span>
                <span className="pc-acc-chevron">{isOpen ? "▾" : "▸"}</span>
              </button>
              {isOpen && (
                <div className="pc-acc-body">
                  {visible.map((field) => (
                    <Field key={field.key} field={field} value={form[field.key]} onChange={onChange} />
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <SectionCard footer={actions} />
    </div>
  );
}

function AiView({ group, form, onChange, actions }) {
  const fmap = fieldMap(group);
  const provider = form.AI_PROVIDER || "gemini";
  const fields = (group.fields || [])
    .filter((f) => f.type !== "section" && f.key !== "AI_PROVIDER")
    .filter((f) => isFieldVisible(f, form));

  const modelField = fields.find((f) => /MODEL/i.test(f.key));
  const modelValue = modelField ? (form[modelField.key] || modelField.default || "—") : "—";

  return (
    <div className="pc-stack">
      <SectionCard title="Provider" description="Choose how Forge Assist talks to a model.">
        <div className="pc-provider-grid">
          {AI_PROVIDERS.map((p) => (
            <button
              key={p.value}
              type="button"
              className={`pc-provider ${provider === p.value ? "is-active" : ""}`}
              onClick={() => onChange("AI_PROVIDER", p.value)}
            >
              <span className="pc-provider-radio" aria-hidden="true" />
              <strong>{p.label}</strong>
              <em>{p.hint}</em>
            </button>
          ))}
        </div>
      </SectionCard>

      <SectionCard title="Configuration" footer={actions}>
        {fields.map((field) => (
          <Field key={field.key} field={field} value={form[field.key]} onChange={onChange} />
        ))}
        {!fields.length && fmap.AI_PROVIDER && (
          <p className="pc-muted-note">Select a provider to configure credentials.</p>
        )}
      </SectionCard>

      <SectionCard title="Current">
        <dl className="pc-kv">
          <div><dt>Provider</dt><dd>{provider}</dd></div>
          <div><dt>Model</dt><dd className="mono">{modelValue}</dd></div>
        </dl>
      </SectionCard>
    </div>
  );
}

function ApprovalView({ group, form, onChange, actions }) {
  const fmap = fieldMap(group);
  const autoApprove = !!form.AUTO_APPROVE_DEPLOYMENTS;
  const cpu = Number(form.APPROVAL_CPU_THRESHOLD ?? 2);
  const mem = Number(form.APPROVAL_MEMORY_GB_THRESHOLD ?? 4);
  const disk = Number(form.APPROVAL_DISK_GB_THRESHOLD ?? 50);

  const SliderField = ({ fieldKey, min, max, unit, label }) => {
    const field = fmap[fieldKey];
    if (!field) return null;
    const val = Number(form[fieldKey] ?? field.default ?? min);
    return (
      <div className="pc-slider">
        <div className="pc-slider-head">
          <label htmlFor={`set-${fieldKey}`}>{label || field.label}</label>
          <strong>{val} {unit}</strong>
        </div>
        <input
          id={`set-${fieldKey}`}
          type="range"
          min={min}
          max={max}
          step={1}
          value={Number.isFinite(val) ? val : min}
          onChange={(e) => onChange(fieldKey, e.target.value)}
        />
      </div>
    );
  };

  return (
    <div className="pc-stack">
      <SectionCard title="Policy mode">
        {fmap.AUTO_APPROVE_DEPLOYMENTS && (
          <Field
            field={fmap.AUTO_APPROVE_DEPLOYMENTS}
            value={form.AUTO_APPROVE_DEPLOYMENTS}
            onChange={onChange}
          />
        )}
      </SectionCard>

      {!autoApprove && (
        <SectionCard
          title="Size thresholds"
          description="Deployments exceeding any of these values require approval."
          footer={actions}
        >
          <SliderField fieldKey="APPROVAL_CPU_THRESHOLD" min={1} max={64} unit="cores" label="CPU threshold" />
          <SliderField fieldKey="APPROVAL_MEMORY_GB_THRESHOLD" min={1} max={512} unit="GB" label="Memory threshold" />
          <SliderField fieldKey="APPROVAL_DISK_GB_THRESHOLD" min={10} max={2000} unit="GB" label="Disk threshold" />
          <div className="pc-info-box">
            VMs over <strong>{cpu} CPU</strong>, <strong>{mem} GB RAM</strong>, or <strong>{disk} GB disk</strong> will be held for Approver or Admin review.
          </div>
        </SectionCard>
      )}

      {autoApprove && (
        <SectionCard footer={actions}>
          <div className="pc-info-box">
            Auto-approve is on — size thresholds are not enforced. Turn it off to require approval for oversized requests.
          </div>
        </SectionCard>
      )}
    </div>
  );
}

function CostView({ group, form, onChange, actions }) {
  const fmap = fieldMap(group);
  const cpu = Number(form.COST_PER_CPU ?? fmap.COST_PER_CPU?.default ?? 1800);
  const ram = Number(form.COST_PER_GB_RAM ?? fmap.COST_PER_GB_RAM?.default ?? 85);
  const storage = Number(form.COST_PER_GB_STORAGE ?? fmap.COST_PER_GB_STORAGE?.default ?? 12);
  const example = { cpu: 2, ram: 8, storage: 100 };
  const total = cpu * example.cpu + ram * example.ram + storage * example.storage;

  return (
    <div className="pc-cost-layout">
      <SectionCard title="Unit prices" description="Monthly rates used on the provision form." footer={actions}>
        {["COST_PER_CPU", "COST_PER_GB_RAM", "COST_PER_GB_STORAGE"].map((key) => (
          fmap[key] ? (
            <Field key={key} field={fmap[key]} value={form[key]} onChange={onChange} />
          ) : null
        ))}
      </SectionCard>

      <SectionCard title="Live preview">
        <div className="pc-cost-preview">
          <div className="pc-cost-rates">
            <div><span>CPU</span><strong>₹{cpu}/core</strong></div>
            <div><span>RAM</span><strong>₹{ram}/GB</strong></div>
            <div><span>Storage</span><strong>₹{storage}/GB</strong></div>
          </div>
          <div className="pc-cost-example">
            <div className="pc-cost-example-label">Example VM</div>
            <div className="pc-cost-example-specs">
              <span>{example.cpu} CPU</span>
              <span>{example.ram} GB</span>
              <span>{example.storage} GB</span>
            </div>
            <div className="pc-cost-total">
              <span>Estimated monthly cost</span>
              <strong>₹{Math.round(total).toLocaleString("en-IN")}</strong>
            </div>
          </div>
        </div>
      </SectionCard>
    </div>
  );
}

function OidcView({ group, form, onChange, actions }) {
  const [step, setStep] = useState(0);
  const fmap = fieldMap(group);

  const stepFields = [
    ["OIDC_ISSUER", "OIDC_SCOPES"],
    ["OIDC_CLIENT_ID", "OIDC_CLIENT_SECRET"],
    ["OIDC_REDIRECT_URI"],
    [],
  ];

  const complete = [
    !!(form.OIDC_ISSUER || fmap.OIDC_ISSUER?.isSet),
    !!(form.OIDC_CLIENT_ID && (form.OIDC_CLIENT_SECRET || fmap.OIDC_CLIENT_SECRET?.isSet)),
    !!form.OIDC_REDIRECT_URI,
    false,
  ];

  return (
    <div className="pc-stack">
      <div className="pc-wizard-steps" role="tablist" aria-label="OIDC setup steps">
        {OIDC_STEPS.map((s, i) => (
          <button
            key={s.id}
            type="button"
            role="tab"
            aria-selected={step === i}
            className={`pc-wizard-step ${step === i ? "is-active" : ""} ${complete[i] ? "is-done" : ""}`}
            onClick={() => setStep(i)}
          >
            <span className="pc-wizard-num">{i + 1}</span>
            {s.label}
          </button>
        ))}
      </div>

      {step < 3 && (
        <SectionCard
          title={OIDC_STEPS[step].label}
          description={
            step === 0 ? "Issuer discovery URL for your IdP."
              : step === 1 ? "Application credentials from the identity provider."
                : "Must match the callback registered with your IdP."
          }
          footer={(
            <div className="pc-wizard-actions">
              <button type="button" className="btn btn-ghost" disabled={step === 0} onClick={() => setStep((s) => s - 1)}>
                Back
              </button>
              <button type="button" className="btn btn-primary" onClick={() => setStep((s) => Math.min(3, s + 1))}>
                Continue
              </button>
            </div>
          )}
        >
          {step === 0 && (
            <div className="pc-field pc-field-stack">
              <div className="pc-field-label">
                <label htmlFor="oidc-provider-preset">Provider</label>
                <p className="pc-help">
                  Preset fills a typical issuer pattern — edit placeholders like {"{tenant}"} before saving.
                  Classic LDAP/AD needs an OIDC bridge (Keycloak, Dex, or AD FS).
                </p>
              </div>
              <select
                id="oidc-provider-preset"
                className="control-select"
                defaultValue=""
                onChange={(e) => {
                  const v = e.target.value;
                  const scopes = "openid profile email";
                  if (v === "entra") {
                    onChange("OIDC_ISSUER", "https://login.microsoftonline.com/{tenant}/v2.0");
                    onChange("OIDC_SCOPES", scopes);
                  } else if (v === "google") {
                    onChange("OIDC_ISSUER", "https://accounts.google.com");
                    onChange("OIDC_SCOPES", scopes);
                  } else if (v === "okta") {
                    onChange("OIDC_ISSUER", "https://{org}.okta.com");
                    onChange("OIDC_SCOPES", scopes);
                  } else if (v === "keycloak") {
                    onChange("OIDC_ISSUER", "https://keycloak.internal/realms/{realm}");
                    onChange("OIDC_SCOPES", scopes);
                  } else if (v === "auth0") {
                    onChange("OIDC_ISSUER", "https://{tenant}.auth0.com");
                    onChange("OIDC_SCOPES", scopes);
                  } else if (v === "pingone") {
                    onChange("OIDC_ISSUER", "https://auth.pingone.com/{envId}/as");
                    onChange("OIDC_SCOPES", scopes);
                  } else if (v === "onelogin") {
                    onChange("OIDC_ISSUER", "https://{subdomain}.onelogin.com/oidc/2");
                    onChange("OIDC_SCOPES", scopes);
                  } else if (v === "jumpcloud") {
                    onChange("OIDC_ISSUER", "https://oauth.id.jumpcloud.com");
                    onChange("OIDC_SCOPES", scopes);
                  } else if (v === "cognito") {
                    onChange("OIDC_ISSUER", "https://cognito-idp.{region}.amazonaws.com/{userPoolId}");
                    onChange("OIDC_SCOPES", scopes);
                  } else if (v === "gitlab") {
                    onChange("OIDC_ISSUER", "https://gitlab.com");
                    onChange("OIDC_SCOPES", scopes);
                  } else if (v === "adfs") {
                    onChange("OIDC_ISSUER", "https://adfs.{domain}/adfs");
                    onChange("OIDC_SCOPES", scopes);
                  } else if (v === "ldap") {
                    // Classic LDAP/AD is not OIDC — point admins at a common OIDC bridge pattern.
                    onChange("OIDC_ISSUER", "https://keycloak.internal/realms/{realm}");
                    onChange("OIDC_SCOPES", scopes);
                  }
                }}
              >
                <option value="">Custom / already configured</option>
                <optgroup label="Cloud IdPs">
                  <option value="entra">Microsoft Entra ID</option>
                  <option value="google">Google Workspace</option>
                  <option value="okta">Okta</option>
                  <option value="auth0">Auth0</option>
                  <option value="cognito">Amazon Cognito</option>
                </optgroup>
                <optgroup label="Enterprise / on-prem">
                  <option value="keycloak">Keycloak</option>
                  <option value="adfs">Active Directory (AD FS)</option>
                  <option value="ldap">LDAP / AD (via Keycloak / Dex)</option>
                  <option value="pingone">PingOne / PingFederate</option>
                  <option value="onelogin">OneLogin</option>
                  <option value="jumpcloud">JumpCloud</option>
                </optgroup>
                <optgroup label="Developer platforms">
                  <option value="gitlab">GitLab</option>
                </optgroup>
              </select>
            </div>
          )}
          {stepFields[step].map((key) => (
            fmap[key] ? (
              <Field key={key} field={fmap[key]} value={form[key]} onChange={onChange} />
            ) : null
          ))}
        </SectionCard>
      )}

      {step === 3 && (
        <SectionCard
          title="Test login"
          description="Save settings, restart the backend if needed, then sign in with SSO from the login page."
          footer={actions}
        >
          <div className="pc-info-box">
            OIDC changes take effect after a backend restart. Use a local admin account if SSO is misconfigured.
          </div>
          <dl className="pc-kv">
            <div><dt>Issuer</dt><dd className="mono">{form.OIDC_ISSUER || "—"}</dd></div>
            <div><dt>Client ID</dt><dd className="mono">{form.OIDC_CLIENT_ID || "—"}</dd></div>
            <div><dt>Redirect</dt><dd className="mono">{form.OIDC_REDIRECT_URI || "—"}</dd></div>
          </dl>
        </SectionCard>
      )}
    </div>
  );
}

function ProxmoxView({ group, form, onChange, actions }) {
  const fmap = fieldMap(group);
  const conn = ["PROXMOX_HOST", "PROXMOX_PORT", "PROXMOX_NODE"]
    .map((k) => fmap[k]).filter(Boolean);
  const authKeys = form.PROXMOX_USE_API_TOKEN === "true"
    ? ["PROXMOX_USE_API_TOKEN", "PROXMOX_TOKEN_ID", "PROXMOX_TOKEN_SECRET"]
    : ["PROXMOX_USE_API_TOKEN", "PROXMOX_USERNAME", "PROXMOX_PASSWORD"];
  const auth = authKeys.map((k) => fmap[k]).filter(Boolean).filter((f) => isFieldVisible(f, form));
  const security = fmap.PROXMOX_VERIFY_SSL ? [fmap.PROXMOX_VERIFY_SSL] : [];

  return (
    <div className="pc-stack">
      <SectionCard title="Connection" description="Hypervisor API endpoint.">
        {conn.map((f) => <Field key={f.key} field={f} value={form[f.key]} onChange={onChange} />)}
      </SectionCard>
      <SectionCard title="Authentication" description="Password or API token — only relevant fields are shown.">
        {auth.map((f) => <Field key={f.key} field={f} value={form[f.key]} onChange={onChange} />)}
      </SectionCard>
      <SectionCard title="Security" footer={actions}>
        {security.map((f) => <Field key={f.key} field={f} value={form[f.key]} onChange={onChange} />)}
      </SectionCard>
    </div>
  );
}

export default function Settings({ sectionId = null, embedded = false } = {}) {
  const [params] = useSearchParams();
  const [groups, setGroups] = useState([]);
  const [form, setForm] = useState({});
  const resolvedId = sectionId || params.get("section") || "proxmox";
  const [activeId, setActiveId] = useState(resolvedId);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [testResults, setTestResults] = useState({});
  const noticeTimer = useRef(null);

  const load = () => {
    setLoading(true);
    getSettings()
      .then((d) => {
        const gs = d.groups || [];
        setGroups(gs);
        setForm(formFromGroups(gs));
        setError("");
      })
      .catch((e) => setError(e.response?.data?.error || e.message))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, []);
  useEffect(() => () => clearTimeout(noticeTimer.current), []);
  useEffect(() => {
    if (sectionId) setActiveId(sectionId);
  }, [sectionId]);

  const flash = (msg) => {
    setNotice(msg);
    clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(""), 4000);
  };

  const onChange = (key, value) => setForm((f) => ({ ...f, [key]: value }));

  const save = async () => {
    setSaving(true);
    setError("");
    try {
      const d = await updateSettings(form);
      const gs = d.groups || [];
      setGroups(gs);
      setForm(formFromGroups(gs));
      flash("Settings saved.");
      return true;
    } catch (e) {
      setError(e.response?.data?.error || e.message);
      return false;
    } finally {
      setSaving(false);
    }
  };

  const saveAndTest = async (tester) => {
    const ok = await save();
    if (!ok) return;
    setTesting(true);
    try {
      const r = await tester.run();
      const detail = r.gitVersion || r.pveversion || r.platform || r.model || r.reply;
      const where = r.url || r.host || r.provider || "endpoint";
      const result = {
        ok: true,
        text: `Connected to ${where}${detail ? ` · ${detail}` : ""}.`,
        at: new Date().toISOString(),
        detail,
      };
      setTestResults((prev) => ({ ...prev, [activeId]: result }));
    } catch (e) {
      const result = {
        ok: false,
        text: e.response?.data?.error || e.message,
        at: new Date().toISOString(),
      };
      setTestResults((prev) => ({ ...prev, [activeId]: result }));
    } finally {
      setTesting(false);
    }
  };

  const active = useMemo(
    () => groups.find((g) => g.id === activeId) || null,
    [groups, activeId]
  );

  if (loading) {
    return <div className="set-loading"><span className="spinner" /></div>;
  }

  if (!active) {
    return (
      <div className="adm-card">
        <p className="muted" style={{ margin: 0 }}>Unknown configuration section.</p>
      </div>
    );
  }

  const tester = TESTERS[active.id] || null;
  const meta = SECTION_META[active.id] || { title: active.title, summary: active.note || "" };
  const lastTest = testResults[active.id] || null;
  const secretFields = (active.fields || []).filter((f) => f.secret && f.type !== "section");
  const secretsSet = secretFields.filter((f) => f.isSet).length;

  const actions = (
    <div className="pc-actions">
      <button type="button" className="btn btn-primary" onClick={save} disabled={saving || testing}>
        {saving ? "Saving…" : "Save changes"}
      </button>
      {tester && (
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => saveAndTest(tester)}
          disabled={saving || testing}
        >
          {testing ? "Testing…" : tester.label}
        </button>
      )}
    </div>
  );

  const renderActive = () => {
    if (active.id === "proxmox") {
      return <ProxmoxView group={active} form={form} onChange={onChange} actions={actions} />;
    }
    if (active.id === "internal") {
      return <InternalView group={active} form={form} onChange={onChange} actions={actions} />;
    }
    if (active.id === "servicenow") {
      return <ServiceNowView group={active} form={form} onChange={onChange} actions={actions} />;
    }
    if (active.id === "ai") {
      return <AiView group={active} form={form} onChange={onChange} actions={actions} />;
    }
    if (active.id === "approvals") {
      return <ApprovalView group={active} form={form} onChange={onChange} actions={actions} />;
    }
    if (active.id === "cost") {
      return <CostView group={active} form={form} onChange={onChange} actions={actions} />;
    }
    if (active.id === "oidc") {
      return <OidcView group={active} form={form} onChange={onChange} actions={actions} />;
    }
    return <GenericCards group={active} form={form} onChange={onChange} actions={actions} />;
  };

  const statusChips = (
    <div className="adm-status-row">
      <span className={`pc-badge ${active.live ? "pc-badge-ok" : "pc-badge-warn"}`}>
        {active.live ? "Live" : "Restart"}
      </span>
      {lastTest && (
        <span className={`pc-badge ${lastTest.ok ? "pc-badge-ok" : "pc-badge-err"}`}>
          {lastTest.ok ? "Connected" : "Failed"}
        </span>
      )}
      {secretFields.length > 0 && (
        <span className="pc-badge pc-badge-muted">{secretsSet}/{secretFields.length} secrets</span>
      )}
      {lastTest && (
        <span className="adm-status-muted">Last test · {fmtTestTime(lastTest.at)}</span>
      )}
    </div>
  );

  return (
    <div className={`pc-settings ${embedded ? "pc-settings-embedded" : ""}`}>
      <AdminPageHeader
        title={meta.title || active.title}
        description={meta.summary || active.note}
      >
        {statusChips}
      </AdminPageHeader>

      {error && <div className="login-error" style={{ marginBottom: 14 }}>{error}</div>}
      {notice && <div className="set-notice">{notice}</div>}

      <div className="pc-main-only">
        {renderActive()}
      </div>
    </div>
  );
}

