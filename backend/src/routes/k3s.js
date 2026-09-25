import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { logAudit } from "../services/auditService.js";
import { groupsForUser } from "../services/groupStore.js";
import { createJob } from "../services/jobStore.js";
import { runK8sApplyJob, runK8sDeleteJob } from "../services/k8sJobService.js";
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

function podDeploymentName(pod) {
  const owners = pod.metadata?.ownerReferences || [];
  const rs = owners.find((o) => o.kind === "ReplicaSet");
  // ReplicaSet name is typically "<deployment>-<hash>"; prefer label if present.
  const labels = pod.metadata?.labels || {};
  const fromLabel =
    labels["app.kubernetes.io/name"]
    || labels.app
    || labels["app.kubernetes.io/instance"];
  if (fromLabel) return fromLabel;
  if (rs?.name) {
    // Strip ReplicaSet hash suffix: my-deploy-7d9f8c → my-deploy
    const m = String(rs.name).match(/^(.*)-[a-z0-9]{5,10}$/i);
    return m ? m[1] : rs.name;
  }
  const depOwner = owners.find((o) => o.kind === "Deployment");
  return depOwner?.name || null;
}

function podWaitingInfo(pod) {
  const pick = (statuses = []) => {
    for (const c of statuses) {
      const waiting = c.state?.waiting;
      if (waiting?.reason) {
        return { reason: waiting.reason, message: waiting.message || "" };
      }
      const term = c.state?.terminated;
      if (term?.reason && term.exitCode) {
        return { reason: term.reason, message: term.message || `exit ${term.exitCode}` };
      }
    }
    return null;
  };
  return (
    pick(pod.status?.containerStatuses)
    || pick(pod.status?.initContainerStatuses)
    || (() => {
      const cond = (pod.status?.conditions || []).find(
        (c) => c.type === "PodScheduled" && c.status === "False",
      );
      if (cond) return { reason: cond.reason || "Unschedulable", message: cond.message || "" };
      return { reason: "", message: "" };
    })()
  );
}

function podView(pod) {
  const containers = pod.spec?.containers || [];
  const statuses = pod.status?.containerStatuses || [];
  const ready = statuses.filter((c) => c.ready).length;
  const restarts = statuses.reduce((n, c) => n + (c.restartCount || 0), 0);
  const wait = podWaitingInfo(pod);
  return {
    name: pod.metadata?.name,
    phase: pod.status?.phase || "Unknown",
    reason: wait.reason || "",
    message: wait.message || "",
    ready: `${ready}/${containers.length}`,
    restarts,
    node: pod.spec?.nodeName || "",
    images: containers.map((c) => c.image),
    deployment: podDeploymentName(pod),
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

function serviceView(svc) {
  const ports = (svc.spec?.ports || []).map((p) => ({
    name: p.name || "",
    port: p.port,
    targetPort: p.targetPort,
    nodePort: p.nodePort || null,
    protocol: p.protocol || "TCP",
  }));
  return {
    name: svc.metadata?.name,
    type: svc.spec?.type || "ClusterIP",
    clusterIP: svc.spec?.clusterIP || "",
    ports,
    selector: svc.spec?.selector || {},
    createdAt: svc.metadata?.creationTimestamp || null,
  };
}

function ingressView(ing) {
  const rules = (ing.spec?.rules || []).map((r) => ({
    host: r.host || "",
    paths: (r.http?.paths || []).map((p) => ({
      path: p.path || "/",
      service: p.backend?.service?.name || "",
      port: p.backend?.service?.port?.number || p.backend?.service?.port?.name || null,
    })),
  }));
  const lb = (ing.status?.loadBalancer?.ingress || [])
    .map((i) => i.hostname || i.ip)
    .filter(Boolean);
  return {
    name: ing.metadata?.name,
    className: ing.spec?.ingressClassName || "",
    rules,
    loadBalancer: lb,
    createdAt: ing.metadata?.creationTimestamp || null,
  };
}

function pvcView(pvc) {
  return {
    name: pvc.metadata?.name,
    status: pvc.status?.phase || "Unknown",
    capacity: pvc.status?.capacity?.storage || pvc.spec?.resources?.requests?.storage || "",
    accessModes: pvc.spec?.accessModes || [],
    storageClass: pvc.spec?.storageClassName || "",
    createdAt: pvc.metadata?.creationTimestamp || null,
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
// to force-terminate a namespace stuck in "Terminating". Tracked in the deployment monitor.
router.delete("/k3s/namespaces/:name", async (req, res) => {
  const force = String(req.query.force) === "true";
  try {
    const ns = await requireVisibleNs(req.user, req.params.name);
    if (!isOwnerOrAdmin(req.user, ns)) {
      return res.status(403).json({ error: "Only the owner or an admin can delete this namespace" });
    }
    const name = req.params.name;
    const job = createJob("k8s", {
      action: "delete",
      namespace: name,
      hostname: name,
      target: { kind: "namespace", name },
      force: !!force,
      requestedBy: req.user.username,
    });
    logAudit({
      actor: req.user,
      action: force ? "k8s.namespace.force-terminate" : "k8s.namespace.delete",
      target: name,
      detail: { jobId: job.id, force: !!force },
    });
    runK8sDeleteJob(job.id, { namespace: name, target: { kind: "namespace", name }, force: !!force });
    res.status(202).json({ job });
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

// Deploy a workload stack: Deployment + optional Service / Ingress / PVC.
router.post("/k3s/namespaces/:name/deployments", async (req, res) => {
  const {
    name,
    image,
    replicas = 1,
    port,
    serviceType = "ClusterIP",
    createService = true,
    ingressHost = "",
    ingressPath = "/",
    pvcSizeGi,
    pvcMountPath = "/data",
  } = req.body || {};
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
  const host = String(ingressHost || "").trim();
  if (host && !portNum) {
    return res.status(400).json({ error: "Container port is required to create an Ingress route" });
  }
  const pvcGi = pvcSizeGi != null && pvcSizeGi !== "" ? Number(pvcSizeGi) : undefined;
  if (pvcGi != null && (!Number.isFinite(pvcGi) || pvcGi <= 0 || pvcGi > 1024)) {
    return res.status(400).json({ error: "PVC size must be between 1 and 1024 Gi" });
  }

  try {
    await requireVisibleNs(req.user, req.params.name);
    const created = await k8s.createWorkloadStack({
      namespace: req.params.name,
      name: clean,
      image: String(image).trim(),
      replicas: reps,
      port: portNum,
      serviceType,
      createService: createService !== false && createService !== "false",
      ingressHost: host,
      ingressPath: String(ingressPath || "/").trim() || "/",
      pvcSizeGi: pvcGi,
      pvcMountPath: String(pvcMountPath || "/data").trim() || "/data",
      labels: {
        [LBL.managed]: MANAGED,
        [LBL.owner]: k8s.k8sLabelValue(req.user.username),
        ...(req.body?.labels && typeof req.body.labels === "object" ? req.body.labels : {}),
      },
      env: Array.isArray(req.body?.env) ? req.body.env : [],
      resources: req.body?.resources && typeof req.body.resources === "object" ? req.body.resources : null,
      imagePullPolicy: String(req.body?.imagePullPolicy || "IfNotPresent").trim(),
      probePath: String(req.body?.probePath || "").trim(),
      command: String(req.body?.command || "").trim(),
      args: String(req.body?.args || "").trim(),
    });
    logAudit({
      actor: req.user,
      action: "k8s.deployment.create",
      target: `${req.params.name}/${clean}`,
      detail: {
        image,
        replicas: reps,
        service: !!created.service,
        ingress: !!created.ingress,
        pvc: !!created.pvc,
      },
    });
    res.status(201).json({
      ok: true,
      name: clean,
      created: {
        deployment: !!created.deployment,
        service: !!created.service,
        ingress: !!created.ingress,
        pvc: !!created.pvc,
      },
    });
  } catch (e) { RES(res, e); }
});

// Terminate a deployment stack — tracked in the shared deployment monitor.
router.delete("/k3s/namespaces/:name/deployments/:dep", async (req, res) => {
  try {
    await requireVisibleNs(req.user, req.params.name);
    const force = req.query.force === "true" || req.query.force === "1";
    const namespace = req.params.name;
    const name = req.params.dep;
    const job = createJob("k8s", {
      action: "delete",
      namespace,
      hostname: `${namespace}/${name}`,
      target: { kind: "deployment", name },
      force: !!force,
      requestedBy: req.user.username,
    });
    logAudit({
      actor: req.user,
      action: force ? "k8s.deployment.force-terminate" : "k8s.deployment.terminate",
      target: `${namespace}/${name}`,
      detail: { force: !!force, jobId: job.id },
    });
    runK8sDeleteJob(job.id, { namespace, target: { kind: "deployment", name }, force: !!force });
    res.status(202).json({ job });
  } catch (e) { RES(res, e); }
});

router.delete("/k3s/namespaces/:name/pods/:pod", async (req, res) => {
  try {
    await requireVisibleNs(req.user, req.params.name);
    const force = req.query.force === "true" || req.query.force === "1";
    const namespace = req.params.name;
    const name = req.params.pod;
    const job = createJob("k8s", {
      action: "delete",
      namespace,
      hostname: `${namespace}/${name}`,
      target: { kind: "pod", name },
      force: !!force,
      requestedBy: req.user.username,
    });
    logAudit({
      actor: req.user,
      action: force ? "k8s.pod.force-terminate" : "k8s.pod.terminate",
      target: `${namespace}/${name}`,
      detail: { force: !!force, jobId: job.id },
    });
    runK8sDeleteJob(job.id, { namespace, target: { kind: "pod", name }, force: !!force });
    res.status(202).json({ job });
  } catch (e) { RES(res, e); }
});

router.get("/k3s/namespaces/:name/deployments/:dep", async (req, res) => {
  try {
    await requireVisibleNs(req.user, req.params.name);
    const dep = await k8s.getDeployment(req.params.name, req.params.dep);
    res.json(k8s.deploymentEditView(dep));
  } catch (e) { RES(res, e); }
});

router.get("/k3s/namespaces/:name/deployments/:dep/stack", async (req, res) => {
  try {
    await requireVisibleNs(req.user, req.params.name);
    const stack = await k8s.getWorkloadStack(req.params.name, req.params.dep);
    res.json(stack);
  } catch (e) { RES(res, e); }
});

router.patch("/k3s/namespaces/:name/deployments/:dep", async (req, res) => {
  try {
    await requireVisibleNs(req.user, req.params.name);
    const result = await k8s.updateDeployment(req.params.name, req.params.dep, req.body || {});
    logAudit({
      actor: req.user,
      action: "k8s.deployment.update",
      target: `${req.params.name}/${req.params.dep}`,
      detail: {
        image: req.body?.image,
        replicas: req.body?.replicas,
      },
    });
    res.json(result);
  } catch (e) { RES(res, e); }
});

router.get("/k3s/namespaces/:name/services", async (req, res) => {
  try {
    await requireVisibleNs(req.user, req.params.name);
    const items = await k8s.listServices(req.params.name);
    res.json(items.map(serviceView));
  } catch (e) { RES(res, e); }
});

router.post("/k3s/namespaces/:name/services", async (req, res) => {
  const { name, port, targetPort, type = "ClusterIP", selector } = req.body || {};
  const clean = String(name || "").trim().toLowerCase();
  if (!/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(clean)) {
    return res.status(400).json({ error: "Service name must be a valid DNS label" });
  }
  try {
    await requireVisibleNs(req.user, req.params.name);
    const created = await k8s.createService({
      namespace: req.params.name,
      name: clean,
      port,
      targetPort,
      type,
      selector: selector && typeof selector === "object" ? selector : { app: clean },
      labels: { [LBL.managed]: MANAGED, [LBL.owner]: k8s.k8sLabelValue(req.user.username) },
    });
    logAudit({ actor: req.user, action: "k8s.service.create", target: `${req.params.name}/${clean}` });
    res.status(201).json(serviceView(created));
  } catch (e) { RES(res, e); }
});

router.delete("/k3s/namespaces/:name/services/:svc", async (req, res) => {
  try {
    await requireVisibleNs(req.user, req.params.name);
    await k8s.deleteService(req.params.name, req.params.svc);
    logAudit({ actor: req.user, action: "k8s.service.delete", target: `${req.params.name}/${req.params.svc}` });
    res.json({ ok: true });
  } catch (e) { RES(res, e); }
});

router.get("/k3s/namespaces/:name/ingresses", async (req, res) => {
  try {
    await requireVisibleNs(req.user, req.params.name);
    const items = await k8s.listIngresses(req.params.name);
    res.json(items.map(ingressView));
  } catch (e) { RES(res, e); }
});

router.post("/k3s/namespaces/:name/ingresses", async (req, res) => {
  const { name, host, path = "/", serviceName, servicePort, ingressClassName } = req.body || {};
  const clean = String(name || "").trim().toLowerCase();
  if (!/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(clean)) {
    return res.status(400).json({ error: "Ingress name must be a valid DNS label" });
  }
  try {
    await requireVisibleNs(req.user, req.params.name);
    const created = await k8s.createIngress({
      namespace: req.params.name,
      name: clean,
      host,
      path,
      serviceName: serviceName || clean,
      servicePort,
      ingressClassName: ingressClassName || "traefik",
      labels: { [LBL.managed]: MANAGED, [LBL.owner]: k8s.k8sLabelValue(req.user.username) },
    });
    logAudit({ actor: req.user, action: "k8s.ingress.create", target: `${req.params.name}/${clean}` });
    res.status(201).json(ingressView(created));
  } catch (e) { RES(res, e); }
});

router.delete("/k3s/namespaces/:name/ingresses/:ing", async (req, res) => {
  try {
    await requireVisibleNs(req.user, req.params.name);
    await k8s.deleteIngress(req.params.name, req.params.ing);
    logAudit({ actor: req.user, action: "k8s.ingress.delete", target: `${req.params.name}/${req.params.ing}` });
    res.json({ ok: true });
  } catch (e) { RES(res, e); }
});

router.get("/k3s/namespaces/:name/pvcs", async (req, res) => {
  try {
    await requireVisibleNs(req.user, req.params.name);
    const items = await k8s.listPersistentVolumeClaims(req.params.name);
    res.json(items.map(pvcView));
  } catch (e) { RES(res, e); }
});

router.post("/k3s/namespaces/:name/pvcs", async (req, res) => {
  const { name, sizeGi = 1, storageClassName } = req.body || {};
  const clean = String(name || "").trim().toLowerCase();
  if (!/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(clean)) {
    return res.status(400).json({ error: "PVC name must be a valid DNS label" });
  }
  try {
    await requireVisibleNs(req.user, req.params.name);
    const created = await k8s.createPersistentVolumeClaim({
      namespace: req.params.name,
      name: clean,
      sizeGi,
      storageClassName,
      labels: { [LBL.managed]: MANAGED, [LBL.owner]: k8s.k8sLabelValue(req.user.username) },
    });
    logAudit({ actor: req.user, action: "k8s.pvc.create", target: `${req.params.name}/${clean}` });
    res.status(201).json(pvcView(created));
  } catch (e) { RES(res, e); }
});

router.delete("/k3s/namespaces/:name/pvcs/:pvc", async (req, res) => {
  try {
    await requireVisibleNs(req.user, req.params.name);
    await k8s.deletePersistentVolumeClaim(req.params.name, req.params.pvc);
    logAudit({ actor: req.user, action: "k8s.pvc.delete", target: `${req.params.name}/${req.params.pvc}` });
    res.json({ ok: true });
  } catch (e) { RES(res, e); }
});

router.post("/k3s/namespaces/:name/apply", async (req, res) => {
  const yaml = String(req.body?.yaml || req.body?.manifest || "").trim();
  if (!yaml) return res.status(400).json({ error: "YAML manifest is required" });
  try {
    await requireVisibleNs(req.user, req.params.name);
    const namespace = req.params.name;
    const job = createJob("k8s", {
      action: "apply",
      namespace,
      hostname: `${namespace}/apply`,
      // Persist for Retry on the Deployments page when pods fail to become Ready.
      yamlText: yaml,
      requestedBy: req.user.username,
    });
    logAudit({
      actor: req.user,
      action: "k8s.yaml.apply",
      target: namespace,
      detail: { bytes: yaml.length, jobId: job.id },
    });
    runK8sApplyJob(job.id, { namespace, yamlText: yaml });
    res.status(202).json({ job });
  } catch (e) { RES(res, e); }
});

router.post("/k3s/namespaces/:name/deployments/:dep/scale", async (req, res) => {
  try {
    await requireVisibleNs(req.user, req.params.name);
    const replicas = Number(req.body?.replicas);
    await k8s.scaleDeployment(req.params.name, req.params.dep, replicas);
    logAudit({
      actor: req.user,
      action: "k8s.deployment.scale",
      target: `${req.params.name}/${req.params.dep}`,
      detail: { replicas },
    });
    res.json({ ok: true, replicas });
  } catch (e) { RES(res, e); }
});

router.post("/k3s/namespaces/:name/deployments/:dep/restart", async (req, res) => {
  try {
    await requireVisibleNs(req.user, req.params.name);
    await k8s.restartDeployment(req.params.name, req.params.dep);
    logAudit({
      actor: req.user,
      action: "k8s.deployment.restart",
      target: `${req.params.name}/${req.params.dep}`,
    });
    res.json({ ok: true });
  } catch (e) { RES(res, e); }
});

router.get("/k3s/namespaces/:name/deployments/:dep/env", async (req, res) => {
  try {
    await requireVisibleNs(req.user, req.params.name);
    const containers = await k8s.getDeploymentEnv(req.params.name, req.params.dep);
    res.json({ containers });
  } catch (e) { RES(res, e); }
});

router.put("/k3s/namespaces/:name/deployments/:dep/env", async (req, res) => {
  try {
    await requireVisibleNs(req.user, req.params.name);
    const result = await k8s.updateDeploymentEnv(req.params.name, req.params.dep, {
      container: req.body?.container,
      env: req.body?.env,
    });
    logAudit({
      actor: req.user,
      action: "k8s.deployment.env_update",
      target: `${req.params.name}/${req.params.dep}`,
      detail: { container: req.body?.container, envCount: Array.isArray(req.body?.env) ? req.body.env.length : 0 },
    });
    res.json(result);
  } catch (e) { RES(res, e); }
});

router.get("/k3s/namespaces/:name/pods/:pod/logs", async (req, res) => {
  try {
    await requireVisibleNs(req.user, req.params.name);
    const logs = await k8s.getPodLogs(req.params.name, req.params.pod, {
      tailLines: req.query.tail,
      container: req.query.container,
    });
    res.type("text/plain").send(logs);
  } catch (e) { RES(res, e); }
});

router.post("/k3s/namespaces/:name/pods/:pod/exec", async (req, res) => {
  try {
    await requireVisibleNs(req.user, req.params.name);
    const command = req.body?.command || "id";
    const result = await k8s.execInPod(req.params.name, req.params.pod, {
      command,
      container: req.body?.container,
    });
    logAudit({
      actor: req.user,
      action: "k8s.pod.exec",
      target: `${req.params.name}/${req.params.pod}`,
      detail: { command: String(command).slice(0, 120) },
    });
    res.json(result);
  } catch (e) { RES(res, e); }
});

export default router;
