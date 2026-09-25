import { useSearchParams } from "react-router-dom";
import Provision from "./Provision.jsx";
import KubernetesInventory from "./KubernetesInventory.jsx";
import ComposeProvision from "./ComposeProvision.jsx";

const CREATE_TABS = [
  {
    id: "vms",
    label: "Virtual Machines",
    hint: "Templates & stacks",
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <rect x="3" y="4" width="18" height="12" rx="2" stroke="currentColor" strokeWidth="1.8" />
        <path d="M8 20h8M12 16v4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    id: "containers",
    label: "Kubernetes",
    hint: "Namespaces",
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.8" />
        <path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    id: "compose",
    label: "Docker Stacks",
    hint: "Compose on remote hosts",
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <rect x="3" y="10" width="4" height="4" rx="0.5" stroke="currentColor" strokeWidth="1.6" />
        <rect x="8" y="10" width="4" height="4" rx="0.5" stroke="currentColor" strokeWidth="1.6" />
        <rect x="13" y="10" width="4" height="4" rx="0.5" stroke="currentColor" strokeWidth="1.6" />
        <rect x="8" y="5" width="4" height="4" rx="0.5" stroke="currentColor" strokeWidth="1.6" />
        <path d="M3 16c2 2 6 3 10 3s7-1 9-3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    ),
  },
];

/**
 * Provisioning hub — create flows with mockup-style top tabs (no duplicate Admin links).
 */
export default function ProvisionHub() {
  const [params, setParams] = useSearchParams();
  const requested = params.get("tab");
  const active = CREATE_TABS.some((t) => t.id === requested) ? requested : "vms";

  const selectTab = (id) => setParams(id === "vms" ? {} : { tab: id }, { replace: true });

  return (
    <div className="page ph-page ph-page-flat">
      <div className="ph-shell">
        <header className="ph-top">
          <div className="ph-top-copy">
            <div className="eyebrow">Provisioning</div>
            <h1>Create infrastructure</h1>
            <p>Choose a template, configure it, then launch — or download IaC to provision from your own toolchain.</p>
          </div>

          <div className="ph-create-tabs" role="tablist" aria-label="Create type">
            {CREATE_TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={active === t.id}
                className={`ph-create-tab ph-create-tab-${t.id} ${active === t.id ? "on" : ""}`}
                onClick={() => selectTab(t.id)}
              >
                <span className="ph-create-tab-icon">{t.icon}</span>
                <span className="ph-create-tab-text">
                  <strong>{t.label}</strong>
                  <small>{t.hint}</small>
                </span>
              </button>
            ))}
          </div>
        </header>

        <div className="ph-body">
          {active === "vms" && <Provision embedded />}
          {active === "containers" && <KubernetesInventory mode="provision" embedded />}
          {active === "compose" && <ComposeProvision embedded />}
        </div>
      </div>
    </div>
  );
}
