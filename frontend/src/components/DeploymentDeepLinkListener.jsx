import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext.jsx";

/**
 * Replaces the old floating LogPanel deep-link behaviour: chat/provision
 * events navigate to the Deployments page instead.
 */
export default function DeploymentDeepLinkListener() {
  const navigate = useNavigate();
  const { canReviewDeployments } = useAuth();

  useEffect(() => {
    const onOpen = (e) => {
      const { jobId, requestId } = e.detail || {};
      if (requestId) {
        const tab = canReviewDeployments ? "hold" : "running";
        navigate(`/deployments?tab=${tab}&request=${encodeURIComponent(requestId)}`);
        return;
      }
      if (jobId) {
        navigate(`/deployments?tab=running&job=${encodeURIComponent(jobId)}`);
        return;
      }
      navigate("/deployments");
    };
    window.addEventListener("forge:open-deployment-monitor", onOpen);
    window.addEventListener("ssp:open-deployment-monitor", onOpen);
    return () => {
      window.removeEventListener("forge:open-deployment-monitor", onOpen);
      window.removeEventListener("ssp:open-deployment-monitor", onOpen);
    };
  }, [navigate, canReviewDeployments]);

  return null;
}
