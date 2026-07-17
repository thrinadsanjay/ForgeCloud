import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { logAudit } from "../services/auditService.js";
import { groupsForUser } from "../services/groupStore.js";
import * as k8s from "../services/k3sService.js";

const router = Router();
router.use(requireAuth);

const LBL = k8s.LABELS;
const LEGACY = k8s.LEGACY_LABELS;
const MANAGED = "forge";
const LEGACY_MANAGED = "ssp";

function nsLabels(ns) {
  return ns.metadata?.labels || {};
}

function isManagedNs(labels) {
  return labels[LBL.managed] === MANAGED || labels[LEGACY.managed] === LEGACY_MANAGED;
}

function ownerLabel(labels) {
  return labels[LBL.owner] || labels[LEGACY.owner];
}

function teamLabel(labels) {
  return labels[LBL.team] || labels[LEGACY.team];
}

// A user may see a namespace if they're an admin, its owner, or a member of the
// team (group) it belongs to. Only Forge-managed namespaces are ever considered.
function canSee(user, ns) {
  const labels = nsLabels(ns);
  if (!isManagedNs(labels)) return false;
  if (user.role === "admin") return true;
  if (ownerLabel(labels) === k8s.k8sLabelValue(user.username)) return true;
  const team = teamLabel(labels);
  if (!team) return false;
  return groupsForUser(user.username).map(k8s.k8sLabelValue).includes(team);
}

// Owner-or-admin gate for destructive actions.
function isOwnerOrAdmin(user, ns) {
  const labels = nsLabels(ns);
  return user.role === "admin" || ownerLabel(labels) === k8s.k8sLabelValue(user.username);
}

function nsView(ns) {
  const labels = ns.metadata?.labels || {};
  const ann = ns.metadata?.annotations || {};
  return {
    name: ns.metadata?.name,
    status: ns.status?.phase || "Unknown",
    createdAt: ns.metadata?.creationTimestamp || null,
    owner: ann[LBL.owner] || labels[LBL.owner] || ann[LEGACY.owner] || labels[LEGACY.owner] || "",
    team: ann[LBL.team] || labels[LBL.team] || ann[LEGACY.team] || labels[LEGACY.team] || "",
    env: labels[LBL.env] || labels[LEGACY.env] || "",
    project: ann[LBL.project] || labels[LBL.project] || ann[LEGACY.project] || labels[LEGACY.project] || "",
  };
}

function podView(pod) {
  const containers = pod.spec?.containers || [];
  const statuses = pod.status?.containerStatuses || [];
  const ready = statuses.filter((c) => c.ready).length;
  const restarts = statuses.reduce((n, c) => n + (c.restartCount || 0), 0);
  return {
    name: pod.metadata?.name,
    phase: pod.status?.phase || "Unknown",
    ready: `${ready}/${containers.length}`,
    restarts,
    node: pod.spec?.nodeName || "",
    images: containers.map((c) => c.image),
    createdAt: pod.metadata?.creationTimestamp || null,
  };
}

function deploymentView(dep) {
  return {
    name: dep.metadata?.name,
    replicas: dep.spec?.replicas ?? 0,
    ready: dep.status?.readyReplicas ?? 0,
    available: dep.status?.availableReplicas ?? 0,
    images: (dep.spec?.template?.spec?.containers || []).map((c) => c.image),
    createdAt: dep.metadata?.creationTimestamp || null,
  };
}

// Resolve a namespace the caller is allowed to see, or throw a 404 so we never
// reveal the existence of namespaces outside their scope.
async function requireVisibleNs(user, name) {
  let ns;
  try {
    ns = await k8s.getNamespace(name);
  } catch {
    const e = new Error("Namespace not found"); e.status = 404; throw e;
  }
  if (!canSee(user, ns)) { const e = new Error("Namespace not found"); e.status = 404; throw e; }
  return ns;
}

const RES = (res, e) => res.status(e.status || 502).json({ error: e.message });

// Context for the create form: the teams (groups) the caller belongs to.
router.get("/k3s/context", (req, res) => {
  res.json({
    isAdmin: req.user.role === "admin",
    teams: groupsForUser(req.user.username),
    envs: ["dev", "test", "staging", "prod"],
  });
});

// List namespaces visible to the caller.
router.get("/k3s/namespaces", async (req, res) => {
  try {
    const [forgeNs, legacyNs] = await Promise.all([
      k8s.listNamespaces({ labelSelector: `${LBL.managed}=${MANAGED}` }),
      k8s.listNamespaces({ labelSelector: `${LEGACY.managed}=${LEGACY_MANAGED}` }),
    ]);
    const byName = new Map();
    for (const ns of [...forgeNs, ...legacyNs]) {
      byName.set(ns.metadata?.name, ns);
    }
    const all = [...byName.values()];
    res.json(all.filter((ns) => canSee(req.user, ns)).map(nsView));
  } catch (e) { RES(res, e); }
});

// Create a namespace owned by the caller (optionally assigned to a team).
router.post("/k3s/namespaces", async (req, res) => {
  const { name, team = "", env = "", project = "" } = req.body || {};
  const clean = String(name || "").trim().toLowerCase();
  if (!/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(clean) || clean.length > 63) {
    return res.status(400).json({ error: "Name must be lowercase letters/numbers/'-', start and end alphanumeric, max 63 chars" });
  }
  // A team assignment is only allowed if the caller belongs to that group.
  if (team && req.user.role !== "admin" && !groupsForUser(req.user.username).includes(team)) {
    return res.status(403).json({ error: `You are not a member of team "${team}"` });
  }

  const labels = {
    [LBL.managed]: MANAGED,
    [LBL.owner]: k8s.k8sLabelValue(req.user.username),
    ...(team ? { [LBL.team]: k8s.k8sLabelValue(team) } : {}),
    ...(env ? { [LBL.env]: k8s.k8sLabelValue(env) } : {}),
    ...(project ? { [LBL.project]: k8s.k8sLabelValue(project) } : {}),
  };
  // Originals (may contain chars invalid for label values) kept for display.
  const annotations = {
    [LBL.owner]: req.user.username,
    ...(team ? { [LBL.team]: team } : {}),
    ...(project ? { [LBL.project]: project } : {}),
  };

  try {
    const created = await k8s.createNamespace({ name: clean, labels, annotations });
    logAudit({ actor: req.user, action: "k8s.namespace.create", target: clean, detail: { team, env, project } });
    res.status(201).json(nsView(created));
  } catch (e) { RES(res, e); }
});

// Delete a namespace (owner or admin only). ?force=true also clears finalizers
// to force-terminate a namespace stuck in "Terminating".
router.delete("/k3s/namespaces/:name", async (req, res) => {
  const force = String(req.query.force) === "true";
  try {
    const ns = await requireVisibleNs(req.user, req.params.name);
    if (!isOwnerOrAdmin(req.user, ns)) {
      return res.status(403).json({ error: "Only the owner or an admin can delete this namespace" });
    }
    if (force) {
      await k8s.deleteNamespace(req.params.name).catch(() => {}); // may already be terminating
      await k8s.forceFinalizeNamespace(req.params.name);
      logAudit({ actor: req.user, action: "k8s.namespace.force-terminate", target: req.params.name });
    } else {
      await k8s.deleteNamespace(req.params.name);
      logAudit({ actor: req.user, action: "k8s.namespace.delete", target: req.params.name });
    }
    res.json({ ok: true });
  } catch (e) { RES(res, e); }
});

// List pods in a namespace the caller can see.
router.get("/k3s/namespaces/:name/pods", async (req, res) => {
  try {
    await requireVisibleNs(req.user, req.params.name);
    const pods = await k8s.listPods(req.params.name);
    res.json(pods.map(podView));
  } catch (e) { RES(res, e); }
});

// List deployments in a namespace the caller can see.
router.get("/k3s/namespaces/:name/deployments", async (req, res) => {
  try {
    await requireVisibleNs(req.user, req.params.name);
    const deps = await k8s.listDeployments(req.params.name);
    res.json(deps.map(deploymentView));
  } catch (e) { RES(res, e); }
});

// Deploy pods (a Deployment) into a namespace the caller can see.
router.post("/k3s/namespaces/:name/deployments", async (req, res) => {
  const { name, image, replicas = 1, port } = req.body || {};
  const clean = String(name || "").trim().toLowerCase();
  if (!/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(clean) || clean.length > 63) {
    return res.status(400).json({ error: "Workload name must be lowercase letters/numbers/'-', max 63 chars" });
  }
  if (!image || !String(image).trim()) {
    return res.status(400).json({ error: "Container image is required" });
  }
  const reps = Number(replicas);
  if (!Number.isInteger(reps) || reps < 1 || reps > 20) {
    return res.status(400).json({ error: "Replicas must be a whole number between 1 and 20" });
  }
  const portNum = port ? Number(port) : undefined;
  if (portNum != null && (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535)) {
    return res.status(400).json({ error: "Port must be between 1 and 65535" });
  }

  try {
    await requireVisibleNs(req.user, req.params.name);
    await k8s.createDeployment({
      namespace: req.params.name,
      name: clean,
      image: String(image).trim(),
      replicas: reps,
      port: portNum,
      labels: { [LBL.managed]: MANAGED, [LBL.owner]: k8s.k8sLabelValue(req.user.username) },
    });
    logAudit({ actor: req.user, action: "k8s.deployment.create", target: `${req.params.name}/${clean}`, detail: { image, replicas: reps } });
    res.status(201).json({ ok: true, name: clean });
  } catch (e) { RES(res, e); }
});

// Delete a deployment from a namespace the caller can see.
router.delete("/k3s/namespaces/:name/deployments/:dep", async (req, res) => {
  try {
    await requireVisibleNs(req.user, req.params.name);
    await k8s.deleteDeployment(req.params.name, req.params.dep);
    logAudit({ actor: req.user, action: "k8s.deployment.delete", target: `${req.params.name}/${req.params.dep}` });
    res.json({ ok: true });
  } catch (e) { RES(res, e); }
});

export default router;
