import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import Users from "./Users.jsx";
import Groups from "./Groups.jsx";
import Mappings from "./Mappings.jsx";
import Settings from "./Settings.jsx";
import CatalogAdmin from "./CatalogAdmin.jsx";
import ChatAnalytics from "./ChatAnalytics.jsx";
import AdminPageHeader from "../components/AdminPageHeader.jsx";
import { ROLE_LABELS } from "../lib/roles.js";

/**
 * Compact Admin nav — fewer groups, short labels.
 * Only the active group stays expanded (accordion).
 */
const NAV = [
  {
    id: "access",
    label: "Access",
    items: [
      { id: "users", label: "Users", icon: "users" },
      { id: "groups", label: "Groups", icon: "groups" },
      { id: "roles", label: "Roles", icon: "roles" },
    ],
  },
  {
    id: "catalog",
    label: "Catalog",
    items: [
      { id: "packages", label: "Packages", icon: "box" },
      { id: "app-roles", label: "App roles", icon: "flow" },
      { id: "sizes", label: "Sizes", icon: "size" },
      { id: "hostname", label: "Hostnames", icon: "tag" },
      { id: "workflows", label: "Workflows", icon: "flow" },
      { id: "mappings", label: "Mappings", icon: "map" },
    ],
  },
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
      { id: "ansible", label: "Ansible", icon: "ansible" },
      { id: "internal", label: "Internal APIs", icon: "plug" },
      { id: "n8n", label: "Webhooks", icon: "hook" },
      { id: "ai", label: "AI Provider", icon: "ai" },
    ],
  },
  {
    id: "integrations",
    label: "Integrations",
    items: [
      { id: "servicenow", label: "ServiceNow", icon: "cloud" },
      { id: "ipam", label: "IPAM", icon: "net" },
      { id: "oidc", label: "OIDC SSO", icon: "key" },
    ],
  },
  {
    id: "policies",
    label: "Policies",
    items: [
      { id: "cost", label: "Cost", icon: "cost" },
      { id: "approvals", label: "Approvals", icon: "shield" },
      { id: "assist", label: "Forge Assist", icon: "spark" },
    ],
  },
];

const ALL_ITEMS = NAV.flatMap((g) => g.items);
const ALL_IDS = new Set(ALL_ITEMS.map((i) => i.id));

const SETTING_TABS = new Set([
  "proxmox", "k3s", "vm", "ansible", "internal", "n8n", "servicenow", "ipam", "oidc", "cost", "approvals", "ai",
]);
const CATALOG_TABS = new Set(["packages", "app-roles", "sizes", "hostname", "workflows"]);

const LEGACY = {
  settings: "proxmox",
  catalog: "packages",
  permissions: "roles",
  general: "users",
  about: "users",
};

function groupIdForTab(tabId) {
  return NAV.find((g) => g.items.some((i) => i.id === tabId))?.id || NAV[0].id;
}

function normalizeTab(raw, sectionParam) {
  if (sectionParam && SETTING_TABS.has(sectionParam)) return sectionParam;
  if (raw && LEGACY[raw]) return LEGACY[raw];
  if (raw && ALL_IDS.has(raw)) return raw;
  return "users";
}

function NavIcon({ name }) {
  const p = {
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "1.75",
    strokeLinecap: "round",
    strokeLinejoin: "round",
    "aria-hidden": true,
  };
  switch (name) {
    case "users":
      return <svg {...p}><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" /></svg>;
    case "groups":
      return <svg {...p}><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></svg>;
    case "roles":
      return <svg {...p}><path d="M12 3 4 7v5c0 5 3.5 8.5 8 9 4.5-.5 8-4 8-9V7l-8-4z" /></svg>;
    case "perms":
      return <svg {...p}><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></svg>;
    case "box":
      return <svg {...p}><path d="M21 8 12 3 3 8v8l9 5 9-5V8z" /><path d="M3 8l9 5 9-5M12 13v10" /></svg>;
    case "size":
      return <svg {...p}><path d="M4 20V10M4 20h10M4 10h6v10" /><path d="M14 20V4h6v16" /></svg>;
    case "tag":
      return <svg {...p}><path d="M20.6 13.4 12 22l-8.6-8.6a2 2 0 0 1 0-2.8L10.6 3H21v10.4a2 2 0 0 1-.4 1z" /><circle cx="15.5" cy="8.5" r="1.2" /></svg>;
    case "flow":
      return <svg {...p}><circle cx="6" cy="6" r="2.5" /><circle cx="18" cy="12" r="2.5" /><circle cx="6" cy="18" r="2.5" /><path d="M8.5 7.5 15.5 11M8.5 16.5 15.5 13" /></svg>;
    case "map":
      return <svg {...p}><path d="M9 3 3 6v15l6-3 6 3 6-3V3l-6 3-6-3z" /><path d="M9 3v15M15 6v15" /></svg>;
    case "srv":
      return <svg {...p}><rect x="3" y="4" width="18" height="6" rx="1.5" /><rect x="3" y="14" width="18" height="6" rx="1.5" /><path d="M7 7h.01M7 17h.01" /></svg>;
    case "k8s":
      return <svg {...p}><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1" /></svg>;
    case "vm":
      return <svg {...p}><rect x="3" y="5" width="18" height="12" rx="2" /><path d="M8 21h8M12 17v4" /></svg>;
    case "plug":
      return <svg {...p}><path d="M9 7v6M15 7v6M7 13h10v2a4 4 0 0 1-4 4h-2a4 4 0 0 1-4-4v-2zM12 19v3" /></svg>;
    case "hook":
      return <svg {...p}><path d="M10 13a5 5 0 0 0 7.5.5l2.5-2.5a5 5 0 0 0-7-7L11 6" /><path d="M14 11a5 5 0 0 0-7.5-.5L4 13a5 5 0 0 0 7 7l2-2" /></svg>;
    case "cloud":
      return <svg {...p}><path d="M18 18H7a4 4 0 0 1-.5-8A6 6 0 0 1 18 8a4 4 0 0 1 0 10z" /></svg>;
    case "net":
      return <svg {...p}><circle cx="6" cy="6" r="2.5" /><circle cx="18" cy="6" r="2.5" /><circle cx="12" cy="18" r="2.5" /><path d="M8 7.5 10.5 16M16 7.5 13.5 16M8.5 6h7" /></svg>;
    case "key":
      return <svg {...p}><circle cx="8" cy="12" r="3.5" /><path d="M11.5 12H21v3M17 12v3" /></svg>;
    case "cost":
      return <svg {...p}><path d="M12 3v18M8 8.5c0-1.5 1.8-2.5 4-2.5s4 1 4 2.5-1.8 2.5-4 2.5-4 1-4 2.5 1.8 2.5 4 2.5 4-1 4-2.5" /></svg>;
    case "shield":
      return <svg {...p}><path d="M12 3 4 7v5c0 5 3.5 8.5 8 9 4.5-.5 8-4 8-9V7l-8-4z" /></svg>;
    case "spark":
      return <svg {...p}><path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M18.4 5.6l-2.8 2.8M8.4 15.6l-2.8 2.8" /><circle cx="12" cy="12" r="2.5" /></svg>;
    case "ai":
      return <svg {...p}><path d="M12 3v3M12 18v3M3 12h3M18 12h3" /><circle cx="12" cy="12" r="4" /></svg>;
    case "ansible":
      return <svg {...p}><path d="M4 19 12 5l8 14" /><path d="M8.5 15h7" /><circle cx="12" cy="11" r="1.5" /></svg>;
    case "audit":
      return <svg {...p}><path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2" /><rect x="9" y="3" width="6" height="4" rx="1" /><path d="M9 12h6M9 16h4" /></svg>;
    case "info":
      return <svg {...p}><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 7.5v.5" /></svg>;
    default:
      return <svg {...p}><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3" /></svg>;
  }
}

function RolesPage() {
  const roles = [
    {
      id: "admin",
      icon: { label: "Ad", bg: "#ea580c" },
      can: ["Full admin", "Approve deployments", "Manage users & groups", "Platform settings"],
    },
    {
      id: "approver",
      icon: { label: "Ap", bg: "#059669" },
      can: ["Approve size-policy holds", "View all deployments", "Provision resources"],
    },
    {
      id: "user",
      icon: { label: "Us", bg: "#2563eb" },
      can: ["Provision own resources", "View own deployments", "Use Forge Assist"],
    },
  ];
  const matrix = [
    ["Manage users & groups", true, false, false],
    ["Platform settings", true, false, false],
    ["Approve deployments", true, true, false],
    ["View all deployments", true, true, false],
    ["Provision resources", true, true, true],
    ["Own resources only", false, false, true],
  ];

  return (
    <div className="adm-board">
      <AdminPageHeader
        title="Roles & permissions"
        description="Built-in portal roles. Assign them on the Users page."
      />
      <div className="adm-stat-grid role-perm-cards">
        {roles.map((r) => (
          <div key={r.id} className="adm-stat-card role-perm-card">
            <span className="adm-entity-icon" style={{ background: r.icon.bg }} aria-hidden="true">{r.icon.label}</span>
            <div>
              <div className="adm-stat-label">{ROLE_LABELS[r.id]}</div>
              <ul className="role-perm-list">
                {r.can.map((c) => <li key={c}>{c}</li>)}
              </ul>
            </div>
          </div>
        ))}
      </div>
      <div className="adm-table-wrap">
        <div className="adm-table-head">
          <h3 className="adm-table-title">Capability matrix</h3>
          <span className="muted adm-table-count">Quick reference</span>
        </div>
        <div className="role-matrix">
          <div className="role-matrix-row role-matrix-head">
            <div>Capability</div>
            <div>Admin</div>
            <div>Approver</div>
            <div>User</div>
          </div>
          {matrix.map(([cap, a, ap, u]) => (
            <div key={cap} className="role-matrix-row">
              <div className="role-matrix-cap">{cap}</div>
              <div>{a ? <span className="role-matrix-yes">Yes</span> : <span className="muted">—</span>}</div>
              <div>{ap ? <span className="role-matrix-yes">Yes</span> : <span className="muted">—</span>}</div>
              <div>{u ? <span className="role-matrix-yes">Yes</span> : <span className="muted">—</span>}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export default function Admin() {
  const [params, setParams] = useSearchParams();
  const active = normalizeTab(params.get("tab"), params.get("section"));
  const activeGroup = groupIdForTab(active);

  // Accordion: only one group open. Follows the active page; user can peek another.
  const [openGroup, setOpenGroup] = useState(activeGroup);

  useEffect(() => {
    setOpenGroup(activeGroup);
  }, [activeGroup]);

  useEffect(() => {
    const raw = params.get("tab");
    const section = params.get("section");
    if (!section && !LEGACY[raw]) return;
    const normalized = normalizeTab(raw, section);
    const next = new URLSearchParams();
    if (normalized !== "users") next.set("tab", normalized);
    setParams(next, { replace: true });
  }, [params, setParams]);

  const selectTab = (item) => {
    const next = new URLSearchParams();
    if (item.id !== "users") next.set("tab", item.id);
    setParams(next, { replace: true });
  };

  const toggleGroup = (id) => {
    setOpenGroup((cur) => (cur === id ? null : id));
  };

  return (
    <div className="adm-shell">
      <aside className="adm-sidebar" aria-label="Administration">
        <div className="adm-sidebar-brand">Admin</div>

        {NAV.map((group) => {
          const isOpen = openGroup === group.id;
          const hasActive = group.items.some((i) => i.id === active);
          return (
            <div key={group.id} className={`adm-sidebar-group ${hasActive ? "has-active" : ""}`}>
              <button
                type="button"
                className={`adm-sidebar-group-title ${isOpen ? "is-open" : ""}`}
                onClick={() => toggleGroup(group.id)}
                aria-expanded={isOpen}
              >
                <span className="adm-sidebar-chevron" aria-hidden="true">{isOpen ? "▾" : "▸"}</span>
                <span>{group.label}</span>
                {!isOpen && hasActive && <span className="adm-sidebar-dot" aria-hidden="true" />}
              </button>
              <nav className={`adm-sidebar-nav ${isOpen ? "is-open" : ""}`}>
                  {group.items.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      className={`adm-sidebar-item ${active === item.id ? "is-active" : ""}`}
                      onClick={() => selectTab(item)}
                    >
                      <span className="adm-sidebar-icon"><NavIcon name={item.icon} /></span>
                      <span>{item.label}</span>
                    </button>
                  ))}
                </nav>
            </div>
          );
        })}
      </aside>

      <main className="adm-content" key={active}>
        {active === "users" && <Users embedded />}
        {active === "groups" && <Groups />}
        {active === "roles" && <RolesPage />}
        {active === "mappings" && <Mappings embedded />}
        {CATALOG_TABS.has(active) && <CatalogAdmin section={active} embedded />}
        {SETTING_TABS.has(active) && <Settings sectionId={active} embedded />}
        {active === "assist" && <ChatAnalytics />}
      </main>
    </div>
  );
}
