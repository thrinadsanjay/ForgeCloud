import { etaFor, recordDuration } from "./stepTimingsStore.js";
import { getDefaultPackages, getDefaultPackagesLabel } from "./catalogService.js";

export { getDefaultPackages as getDefaultAgents, resolveInstallPkg } from "./catalogService.js";

export const VM_STEP_DEFS = [
  { key: "submitted",          label: "Request submitted",     active: "Receiving your new-server request…",                                  done: "New server request submitted",                 eta: 2,  group: "request" },
  { key: "approval",           label: "Approvals",             active: "Checking approval requirements…",                                     done: "Standard request — auto-approved",             eta: 2,  group: "request" },
  { key: "approved",           label: "Approved",              active: "Locking in the approval…",                                            done: "Request approved — kicking off the build",     eta: 1,  group: "request" },
  { key: "provision_vm",       label: "Provisioning the VM",   active: "Carving out your virtual machine on the cluster…",                    done: "Virtual machine provisioned",                  eta: 45, group: "build" },
  { key: "deploy_os",          label: "Deploying the OS",      active: "Laying down the golden OS image…",                                    done: "Operating system deployed",                    eta: 40, group: "build" },
  { key: "allocate_resources", label: "Allocating resources",  active: "Dialing in your CPU, memory and storage…",                            done: "Requested resources allocated",                eta: 15, group: "build" },
  { key: "assign_ip",          label: "Attaching network",     active: "Connecting the NIC — IP via DHCP…",                                   done: "Network attached · DHCP",                      eta: 12, group: "build" },
  { key: "power_on",           label: "Powering on",           active: "Powering on your virtual machine…",                                   done: "Powered on",                                   eta: 10, group: "boot" },
  { key: "system_startup",     label: "System startup",        active: "Waiting for the system to come alive…",                               done: "System is online",                             eta: 90, group: "boot" },
  { key: "initial_setup",      label: "Initial setup",         active: "Running first-boot initialization and creating your account…",        done: "Initial setup complete",                       eta: 25, group: "config" },
  { key: "default_packages", label: "Default packages", active: "Installing default packages via cloud-init…", done: "Default packages installed", eta: 45, group: "config" },
  { key: "requested_packages", label: "Requested software",    active: "Installing your requested software…",                                 done: "Requested software installed",                 eta: 35, group: "config" },
  { key: "validate",           label: "Validation",            active: "Running final health checks on your server…",                         done: "Server validated end-to-end",                  eta: 15, group: "config" },
  { key: "summarize",          label: "Summary",               active: "Wrapping up and preparing your summary…",                             done: "All done — your server is ready",              eta: 3,  group: "done" },
];

export const VM_STEP_KEYS = VM_STEP_DEFS.map((d) => d.key);

export function vmStepIndex(key) {
  return VM_STEP_KEYS.indexOf(key);
}

function nowIso() { return new Date().toISOString(); }

export function buildVmSteps(templateKey) {
  const defaultActive = `Installing default packages — ${getDefaultPackagesLabel().replace(/^Default packages —?\s*/, "") || "standard set"}…`;
  return VM_STEP_DEFS.map((d) => {
    const def = d.key === "default_packages" ? { ...d, active: defaultActive } : d;
    return {
      key: def.key,
      label: def.label,
      active: def.active,
      done: def.done,
      group: def.group,
      state: "pending",
      etaSec: etaFor(templateKey, def.key, def.eta),
      startedAt: null,
      endedAt: null,
      tookSec: null,
    };
  });
}

export function createStepTracker({ templateKey, emit, onStepEvent }) {
  const steps = buildVmSteps(templateKey);
  let activeKey = null;

  const push = (extra = {}) => emit({ steps: [...steps], ...extra });

  const find = (key) => steps.find((s) => s.key === key);

  const emitStep = (stepKey, state, patch = {}) => {
    if (!onStepEvent) return;
    const s = find(stepKey);
    onStepEvent({
      stepKey,
      label: s?.label || stepKey,
      message: patch.done || patch.active || s?.done || s?.active || stepKey,
      state,
    });
  };

  const quickDone = (key, patch = {}) => {
    const s = find(key);
    if (!s) return;
    const now = nowIso();
    s.state = "done";
    s.startedAt = s.startedAt || now;
    s.endedAt = now;
    if (patch.done) s.done = patch.done;
    if (patch.active) s.active = patch.active;
    push();
    emitStep(key, "done", patch);
  };

  const start = (key, patch = {}) => {
    const s = find(key);
    if (!s) return;
    if (activeKey && activeKey !== key) {
      const prev = find(activeKey);
      if (prev?.state === "active") {
        prev.state = "done";
        prev.endedAt = nowIso();
        if (prev.startedAt) {
          prev.tookSec = Math.round((Date.now() - new Date(prev.startedAt).getTime()) / 1000);
          recordDuration(templateKey, prev.key, prev.tookSec);
        }
      }
    }
    activeKey = key;
    s.state = "active";
    s.startedAt = s.startedAt || nowIso();
    if (patch.active) s.active = patch.active;
    push();
    emitStep(key, "active", patch);
  };

  const done = (key, patch = {}) => {
    const s = find(key);
    if (!s) return;
    s.state = "done";
    s.endedAt = nowIso();
    if (patch.done) s.done = patch.done;
    if (s.startedAt) {
      s.tookSec = Math.round((Date.now() - new Date(s.startedAt).getTime()) / 1000);
      recordDuration(templateKey, key, s.tookSec);
    }
    if (activeKey === key) activeKey = null;
    push();
    emitStep(key, "done", patch);
  };

  const skip = (key, patch = {}) => {
    const s = find(key);
    if (!s) return;
    s.state = "skipped";
    if (patch.done) s.done = patch.done;
    push();
    emitStep(key, "skipped", patch);
  };

  const stall = (message) => {
    if (activeKey) {
      const s = find(activeKey);
      if (s) {
        s.state = "done";
        s.done = message;
        s.endedAt = nowIso();
      }
      activeKey = null;
    }
    for (const s of steps) {
      if (s.state === "pending" || s.state === "active") {
        s.state = "skipped";
      }
    }
    push({ message });
  };

  const fail = (message, error) => {
    if (activeKey) {
      const s = find(activeKey);
      if (s) {
        s.state = "failed";
        s.done = message;
        s.endedAt = nowIso();
      }
    }
    for (const s of steps) {
      if (s.state === "pending") s.state = "skipped";
    }
    push({ status: "failed", error, message });
    if (activeKey) emitStep(activeKey, "failed", { done: message });
  };

  return { steps, start, done, skip, quickDone, stall, fail };
}
