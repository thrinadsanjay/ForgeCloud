import { useSearchParams } from "react-router-dom";
import Provision from "./Provision.jsx";
import ContainerHosting from "./ContainerHosting.jsx";

const TABS = [
  { id: "vms", label: "Virtual machines" },
  { id: "containers", label: "Container hosting" },
];

export default function ProvisionHub() {
  const [params, setParams] = useSearchParams();
  const requested = params.get("tab");
  const active = TABS.some((t) => t.id === requested) ? requested : "vms";

  const selectTab = (id) => setParams(id === "vms" ? {} : { tab: id }, { replace: true });

  return (
    <div className="page">
      <div className="admin-tabs" role="tablist" aria-label="Provisioning sections">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={active === t.id}
            className={`admin-tab ${active === t.id ? "active" : ""}`}
            onClick={() => selectTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="admin-tab-panel">
        {active === "vms" && <Provision embedded />}
        {active === "containers" && <ContainerHosting embedded />}
      </div>
    </div>
  );
}
