/**
 * Legacy entry for Kubernetes provisioning.
 * Prefer Provisioning → Kubernetes (`/provision?tab=containers`).
 */
import KubernetesInventory from "./KubernetesInventory.jsx";

export default function ContainerHosting({ embedded = false }) {
  return <KubernetesInventory mode="provision" embedded={embedded} />;
}
