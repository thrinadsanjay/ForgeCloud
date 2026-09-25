import { Link, useSearchParams } from "react-router-dom";
import { useAuth } from "../context/AuthContext.jsx";
import ComputeInventory from "./ComputeInventory.jsx";
import KubernetesInventory from "./KubernetesInventory.jsx";
import DockerInventory from "./DockerInventory.jsx";

const TABS = [
  { id: "compute", label: "Compute" },
  { id: "kubernetes", label: "Kubernetes" },
  { id: "docker", label: "Docker" },
];

const PROVISION_CTA = {
  compute: { to: "/provision", label: "Provision" },
  kubernetes: { to: "/provision?tab=containers", label: "Provision namespace" },
  docker: { to: "/provision?tab=compose", label: "Deploy Docker" },
};

/**
 * Resources — inventory only (view / manage existing).
 * All create flows live under Provisioning.
 */
export default function Resources() {
  const { isAdmin } = useAuth();
  const [params, setParams] = useSearchParams();
  const requested = params.get("tab");
  const active = TABS.some((t) => t.id === requested) ? requested : "compute";
  const initialNs = params.get("ns");
  const cta = PROVISION_CTA[active] || PROVISION_CTA.compute;

  const selectTab = (id) => {
    const next = new URLSearchParams(params);
    if (id === "compute") {
      next.delete("tab");
      next.delete("ns");
    } else {
      next.set("tab", id);
      if (id !== "kubernetes") next.delete("ns");
    }
    setParams(next, { replace: true });
  };

  const blurb = {
    kubernetes: "Namespaces, deployments, and pods you can access. Create new ones under Provisioning.",
    docker: "Compose projects on remote Docker Engines. Deploy new stacks under Provisioning.",
    compute: isAdmin
      ? "Virtual machines and containers on the node. Control power state or delete."
      : "Virtual machines and containers you've created. Control their power state.",
  }[active];

  return (
    <div className="page">
      <div className="page-head row-between" style={{ alignItems: "flex-end" }}>
        <div>
          <div className="eyebrow">Inventory</div>
          <h1>Resources</h1>
          <p>{blurb}</p>
        </div>
        <Link className="btn btn-primary" to={cta.to}>{cta.label}</Link>
      </div>

      <div className="admin-tabs" role="tablist" aria-label="Resource inventory">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
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
        {active === "compute" && <ComputeInventory />}
        {active === "kubernetes" && <KubernetesInventory mode="inventory" initialNs={initialNs} />}
        {active === "docker" && <DockerInventory />}
      </div>
    </div>
  );
}
