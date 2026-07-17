import { useState } from "react";
import { editResource, resizeResource, resourceAction } from "../api/client.js";
import { useDialog } from "./DialogProvider.jsx";

// Edit CPU / memory / disk for an existing VM or container.
// Small changes (within the size policy) apply after a reboot the user confirms;
// larger changes are routed to admin approval, then rebooted on the user's OK.
export default function EditResourceModal({ resource, onClose, onSaved }) {
  const isVm = resource.type === "vm" || resource.type === "qemu";
  const kind = isVm ? "vm" : "container";
  const { confirm, alert } = useDialog();

  const [cpu, setCpu] = useState(resource.cpu || 1);
  const [memoryGB, setMemoryGB] = useState(resource.memGB || 1);
  const [diskGB, setDiskGB] = useState(resource.maxdiskGB || 10);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const minDisk = resource.maxdiskGB || 1;
  const label = resource.name || `VMID ${resource.vmid}`;

  const submit = async (e) => {
    e.preventDefault();
    setError("");

    // Only the fields that actually changed are applied (disk can only grow).
    const changed = {};
    if (Number(cpu) !== resource.cpu) changed.cpu = Number(cpu);
    if (Number(memoryGB) !== resource.memGB) changed.memoryGB = Number(memoryGB);
    if (Number(diskGB) !== resource.maxdiskGB) changed.diskGB = Number(diskGB);

    if (Number(diskGB) < minDisk) {
      setError(`Disk can only grow — minimum ${minDisk} GB.`);
      return;
    }
    if (Object.keys(changed).length === 0) {
      setError("Nothing changed.");
      return;
    }

    setBusy(true);
    try {
      // Ask the backend to decide: within policy → reboot; over policy → approval.
      const decision = await resizeResource(kind, resource.vmid, {
        cpu: Number(cpu),
        memoryGB: Number(memoryGB),
        diskGB: Number(diskGB),
        current: { cpu: resource.cpu, memoryGB: resource.memGB, diskGB: resource.maxdiskGB },
        hostname: resource.name,
      });

      if (decision.approvalRequired) {
        // Large resize — an approval request was created and admins notified.
        onSaved?.();
        onClose();
        alert({
          title: "Approval required",
          message: `This resize exceeds the size policy, so it needs admin approval. Request ${decision.requestId} has been sent — you'll be notified here once it's reviewed, then prompted to reboot.`,
        });
        return;
      }

      // Small resize — confirm the reboot, then apply and reboot.
      const ok = await confirm({
        title: "Reboot required",
        message: `Applying these changes will reboot ${label}. It will be briefly unavailable. Proceed?`,
        confirmLabel: "Resize & reboot",
        tone: "danger",
      });
      if (!ok) { setBusy(false); return; }

      await editResource(kind, resource.vmid, changed);
      await resourceAction(kind, resource.vmid, "reboot");
      onSaved?.();
      onClose();
      alert({ title: "Resize started", message: `${label} is being resized and rebooted. It will be back shortly.` });
    } catch (err) {
      setError(err.response?.data?.error || err.message);
      setBusy(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal-card">
        <div className="modal-header">
          <h3>Edit {resource.name || `VMID ${resource.vmid}`}</h3>
          <button className="close-btn" onClick={onClose}>×</button>
        </div>

        <form onSubmit={submit} className="modal-body">
          <label className="field">
            <span>vCPU cores</span>
            <input type="number" min="1" max="64" value={cpu}
              onChange={(e) => setCpu(e.target.value)} />
          </label>

          <label className="field">
            <span>Memory (GB)</span>
            <input type="number" min="1" max="256" value={memoryGB}
              onChange={(e) => setMemoryGB(e.target.value)} />
          </label>

          <label className="field">
            <span>Disk (GB) <em className="muted">— grow only, min {minDisk}</em></span>
            <input type="number" min={minDisk} max="2048" value={diskGB}
              onChange={(e) => setDiskGB(e.target.value)} />
          </label>

          <p className="muted" style={{ fontSize: 12 }}>
            CPU and memory apply live where the guest supports hotplug; otherwise they
            take effect on the next reboot. Disk grows immediately.
          </p>

          {error && <p className="login-error" style={{ marginTop: 0 }}>{error}</p>}

          <div className="modal-actions">
            <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={busy}>
              {busy ? "Saving…" : "Save changes"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
