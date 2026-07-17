import * as pve from "./proxmoxService.js";

const GB = 1024 ** 3;

// Colour band for a projected usage percentage.
//   < 60        -> green
//   60 .. 80    -> amber
//   > 80        -> red (approval blocked)
function levelFor(percent) {
  if (percent < 60) return "green";
  if (percent <= 80) return "amber";
  return "red";
}

// Live node usage: what Proxmox is *actually* using right now (not what's been
// allocated/over-committed across guests). This is the meaningful base for "how
// full will the node be if I approve this" — on an over-committed lab, allocated
// vCPU/RAM can exceed the physical total, which would make every request look
// impossible. Live usage stays within the physical capacity.
export async function getNodeUsage() {
  const [status, storages] = await Promise.all([
    pve.getNodeStatus({}).catch(() => null),
    pve.listStorage({}).catch(() => []),
  ]);

  const cpuTotal = status?.cpuinfo?.cpus || status?.cpuinfo?.cores || 0;
  // status.cpu is a 0..1 load fraction of the whole node.
  const cpuUsed = Math.max(0, Number(status?.cpu || 0)) * cpuTotal;

  const memTotal = status?.memory?.total || 0;
  const memUsed = status?.memory?.used || 0;

  // Storage used/total = sum of storages that can hold guest disks (images /
  // rootdir). Dedupe by name so a shared storage isn't double-counted. Fall back
  // to the node root filesystem if none advertise a total.
  const seen = new Set();
  let storageTotal = 0;
  let storageUsed = 0;
  for (const s of storages || []) {
    if (!s || !s.storage || seen.has(s.storage)) continue;
    if (!/images|rootdir/.test(String(s.content || ""))) continue;
    seen.add(s.storage);
    storageTotal += Number(s.total || 0);
    storageUsed += Number(s.used || 0);
  }
  if (!storageTotal) {
    storageTotal = status?.rootfs?.total || 0;
    storageUsed = status?.rootfs?.used || 0;
  }

  return {
    cpu: { total: cpuTotal, used: cpuUsed, unit: "cores" },
    memory: { total: memTotal, used: memUsed, unit: "bytes" },
    storage: { total: storageTotal, used: storageUsed, unit: "bytes" },
  };
}

function buildResource(label, res, requested) {
  const total = Number(res.total || 0);
  const before = Number(res.used || 0);
  const after = before + requested;
  const pct = (v) => (total > 0 ? (v / total) * 100 : 0);
  const percentAfter = pct(after);
  return {
    label,
    unit: res.unit,
    total,
    requested,
    currentUsed: before,
    projectedUsed: after,
    balanceBefore: total - before,
    balanceAfter: total - after,
    percentBefore: pct(before),
    percentAfter,
    level: levelFor(percentAfter),
  };
}

// How many VMs a stack request will actually provision, so its footprint is
// estimated across every node in the stack, not just one.
function unitCountFor(request) {
  if (request?.kind !== "stack") return 1;
  const nodes = request?.payload?.nodes || request?.payload?.services || request?.payload?.vms;
  return Array.isArray(nodes) && nodes.length ? nodes.length : 1;
}

// Estimate the capacity impact of approving a request: for CPU, RAM and storage,
// how full the node becomes once this request's resources are added on top of
// what's currently in use.
export async function computeRequestImpact(request) {
  const usage = await getNodeUsage();
  const p = request?.payload || {};
  const count = unitCountFor(request);

  // For a resize the node already runs the guest, so the added footprint is the
  // delta from its current specs (can be negative for a downsize). New builds
  // add their full requested size.
  const isResize = request?.kind === "resize";
  const cur = isResize ? (p.current || {}) : {};
  const delta = (target, current) => Number(target || 0) - (isResize ? Number(current || 0) : 0);

  const reqCpu = delta(p.cpu, cur.cpu) * count;
  const reqMemBytes = delta(p.memoryGB, cur.memoryGB) * GB * count;
  const reqDiskBytes = delta(p.diskGB, cur.diskGB) * GB * count;

  const resources = {
    cpu: buildResource("CPU", usage.cpu, reqCpu),
    memory: buildResource("RAM", usage.memory, reqMemBytes),
    storage: buildResource("Storage", usage.storage, reqDiskBytes),
  };

  // Block approval if provisioning would push any resource past 80%.
  const blocking = Object.values(resources).filter((r) => r.level === "red").map((r) => r.label);

  return {
    requested: {
      cpu: reqCpu,
      memoryGB: Number(p.memoryGB || 0) * count,
      diskGB: Number(p.diskGB || 0) * count,
      units: count,
    },
    resources,
    canApprove: blocking.length === 0,
    blocking,
  };
}
