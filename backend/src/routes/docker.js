import { Router } from "express";
import { requireAuth, requireAdmin } from "../middleware/auth.js";
import { logAudit } from "../services/auditService.js";
import { createJob } from "../services/jobStore.js";
import {
  listDockerHosts,
  getDockerHost,
  getDockerHostSecrets,
  createDockerHost,
  updateDockerHost,
  deleteDockerHost,
  sanitizeHost,
  hostsVisibleTo,
  canUseHost,
} from "../services/dockerHostStore.js";
import * as docker from "../services/dockerService.js";
import { runComposeJob } from "../services/provisioner.js";

const router = Router();

// ── Admin host CRUD ──────────────────────────────────────────────

router.get("/admin/docker-hosts", requireAuth, requireAdmin, (_req, res) => {
  res.json(listDockerHosts().map((h) => sanitizeHost(h)));
});

router.post("/admin/docker-hosts", requireAuth, requireAdmin, (req, res) => {
  try {
    const host = createDockerHost(req.body || {});
    logAudit({
      actor: req.user,
      action: "docker_host.create",
      target: host.id,
      detail: { name: host.name, endpoint: host.endpoint },
    });
    res.status(201).json(sanitizeHost(host));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.patch("/admin/docker-hosts/:id", requireAuth, requireAdmin, (req, res) => {
  try {
    const host = updateDockerHost(req.params.id, req.body || {});
    logAudit({
      actor: req.user,
      action: "docker_host.update",
      target: host.id,
      detail: { name: host.name },
    });
    res.json(sanitizeHost(host));
  } catch (e) {
    const code = /not found/i.test(e.message) ? 404 : 400;
    res.status(code).json({ error: e.message });
  }
});

router.delete("/admin/docker-hosts/:id", requireAuth, requireAdmin, (req, res) => {
  try {
    const existing = getDockerHost(req.params.id);
    deleteDockerHost(req.params.id);
    logAudit({
      actor: req.user,
      action: "docker_host.delete",
      target: req.params.id,
      detail: { name: existing?.name },
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(404).json({ error: e.message });
  }
});

function dockerHostTestCandidate(input = {}) {
  const existing = input.id ? getDockerHostSecrets(input.id) : null;
  if (input.id && !existing) throw new Error("Docker host not found");
  const keepOrReplace = (key) => {
    const next = String(input[key] || "").trim();
    return next || existing?.[key] || "";
  };
  return {
    id: existing?.id,
    name: String(input.name || existing?.name || "").trim(),
    endpoint: String(input.endpoint || existing?.endpoint || "").trim(),
    skipTlsVerify: input.skipTlsVerify == null
      ? !!existing?.skipTlsVerify
      : !!input.skipTlsVerify,
    tlsCa: keepOrReplace("tlsCa"),
    tlsCert: keepOrReplace("tlsCert"),
    tlsKey: keepOrReplace("tlsKey"),
  };
}

// Test form values before saving. Existing secrets are retained when edit fields
// are blank, matching PATCH behavior.
router.post("/admin/docker-hosts/test", requireAuth, requireAdmin, async (req, res) => {
  let candidate;
  try {
    candidate = dockerHostTestCandidate(req.body || {});
    if (!candidate.endpoint) throw new Error("Endpoint is required");
    const result = await docker.testConnection(candidate);
    logAudit({
      actor: req.user,
      action: "docker_host.test",
      target: candidate.id || candidate.name || candidate.endpoint,
      status: "success",
      detail: { endpoint: candidate.endpoint, version: result.version || result.apiVersion },
    });
    res.json(result);
  } catch (e) {
    const endpoint = candidate?.endpoint || String(req.body?.endpoint || "");
    console.warn(`[docker-host:test] ${endpoint || "unknown endpoint"}: ${e.message}`);
    logAudit({
      actor: req.user,
      action: "docker_host.test",
      target: candidate?.id || candidate?.name || endpoint || "unsaved",
      status: "failure",
      detail: { endpoint, error: e.message },
    });
    res.status(400).json({ error: e.message, ok: false });
  }
});

router.post("/admin/docker-hosts/:id/test", requireAuth, requireAdmin, async (req, res) => {
  try {
    const result = await docker.testConnection(req.params.id);
    const host = getDockerHost(req.params.id);
    logAudit({
      actor: req.user,
      action: "docker_host.test",
      target: req.params.id,
      status: "success",
      detail: { endpoint: host?.endpoint, version: result.version || result.apiVersion },
    });
    res.json(result);
  } catch (e) {
    const host = getDockerHost(req.params.id);
    console.warn(`[docker-host:test] ${host?.endpoint || req.params.id}: ${e.message}`);
    logAudit({
      actor: req.user,
      action: "docker_host.test",
      target: req.params.id,
      status: "failure",
      detail: { endpoint: host?.endpoint, error: e.message },
    });
    res.status(400).json({ error: e.message, ok: false });
  }
});

// ── User-facing Docker Compose ───────────────────────────────────

router.use("/docker", requireAuth);

router.get("/docker/hosts", (req, res) => {
  res.json(hostsVisibleTo(req.user).map((h) => sanitizeHost(h)));
});

router.post("/docker/compose/deploy", async (req, res) => {
  try {
    const { hostId, project, source } = req.body || {};
    const host = getDockerHostSecrets(hostId);
    if (!host || !canUseHost(req.user, host)) {
      return res.status(404).json({ error: "Docker host not found" });
    }
    const projectName = docker.validateProjectName(project);
    if (!source || !["paste", "git"].includes(source.type)) {
      return res.status(400).json({ error: "source.type must be paste or git" });
    }
    if (source.type === "paste" && !String(source.composeYaml || "").trim()) {
      return res.status(400).json({ error: "composeYaml is required for paste source" });
    }
    if (source.type === "git" && !String(source.gitUrl || "").trim()) {
      return res.status(400).json({ error: "gitUrl is required for git source" });
    }

    const job = createJob("compose", {
      hostId: host.id,
      hostName: host.name,
      project: projectName,
      source: {
        type: source.type,
        composeYaml: source.type === "paste" ? source.composeYaml : undefined,
        envFile: source.type === "paste" ? source.envFile : undefined,
        gitUrl: source.type === "git" ? source.gitUrl : undefined,
        branch: source.type === "git" ? source.branch : undefined,
        composePath: source.type === "git" ? source.composePath : undefined,
        // gitToken intentionally omitted from persisted job payload
      },
      requestedBy: req.user.username,
    });

    logAudit({
      actor: req.user,
      action: "compose.deploy",
      target: `${host.id}/${projectName}`,
      detail: { hostName: host.name, sourceType: source.type, jobId: job.id },
    });

    // Token only in the in-flight runner — not written to job history.
    runComposeJob(job.id, {
      ...job.payload,
      source: {
        ...job.payload.source,
        gitToken: source.type === "git" ? source.gitToken : undefined,
      },
    });
    res.status(202).json({ job });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.get("/docker/projects", async (req, res) => {
  try {
    const visible = hostsVisibleTo(req.user);
    const results = [];
    for (const h of visible) {
      const full = getDockerHostSecrets(h.id);
      try {
        const projects = await docker.listProjects(full);
        results.push({
          host: sanitizeHost(h),
          projects,
          error: null,
        });
      } catch (e) {
        results.push({
          host: sanitizeHost(h),
          projects: [],
          error: e.message,
        });
      }
    }
    res.json(results);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/docker/projects/:hostId/:project/down", async (req, res) => {
  try {
    const host = getDockerHostSecrets(req.params.hostId);
    if (!host || !canUseHost(req.user, host)) {
      return res.status(404).json({ error: "Docker host not found" });
    }
    const project = docker.validateProjectName(req.params.project);
    const result = await docker.downProject(host, project);
    logAudit({
      actor: req.user,
      action: "compose.down",
      target: `${host.id}/${project}`,
      detail: result,
    });
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post("/docker/containers/:hostId/:id/start", async (req, res) => {
  try {
    const host = getDockerHostSecrets(req.params.hostId);
    if (!host || !canUseHost(req.user, host)) {
      return res.status(404).json({ error: "Docker host not found" });
    }
    await docker.startContainer(host, req.params.id);
    logAudit({
      actor: req.user,
      action: "compose.container.start",
      target: `${host.id}/${req.params.id}`,
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post("/docker/containers/:hostId/:id/stop", async (req, res) => {
  try {
    const host = getDockerHostSecrets(req.params.hostId);
    if (!host || !canUseHost(req.user, host)) {
      return res.status(404).json({ error: "Docker host not found" });
    }
    await docker.stopContainer(host, req.params.id);
    logAudit({
      actor: req.user,
      action: "compose.container.stop",
      target: `${host.id}/${req.params.id}`,
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post("/docker/containers/:hostId/:id/restart", async (req, res) => {
  try {
    const host = getDockerHostSecrets(req.params.hostId);
    if (!host || !canUseHost(req.user, host)) {
      return res.status(404).json({ error: "Docker host not found" });
    }
    await docker.restartContainer(host, req.params.id);
    logAudit({
      actor: req.user,
      action: "compose.container.restart",
      target: `${host.id}/${req.params.id}`,
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.delete("/docker/containers/:hostId/:id", async (req, res) => {
  try {
    const host = getDockerHostSecrets(req.params.hostId);
    if (!host || !canUseHost(req.user, host)) {
      return res.status(404).json({ error: "Docker host not found" });
    }
    await docker.removeContainer(host, req.params.id, { force: true });
    logAudit({
      actor: req.user,
      action: "compose.container.delete",
      target: `${host.id}/${req.params.id}`,
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.get("/docker/containers/:hostId/:id/inspect", async (req, res) => {
  try {
    const host = getDockerHostSecrets(req.params.hostId);
    if (!host || !canUseHost(req.user, host)) {
      return res.status(404).json({ error: "Docker host not found" });
    }
    const info = await docker.inspectContainer(host, req.params.id);
    const { _create, ...publicInfo } = info;
    res.json(publicInfo);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.put("/docker/containers/:hostId/:id/env", async (req, res) => {
  try {
    const host = getDockerHostSecrets(req.params.hostId);
    if (!host || !canUseHost(req.user, host)) {
      return res.status(404).json({ error: "Docker host not found" });
    }
    const env = req.body?.env;
    if (!Array.isArray(env)) {
      return res.status(400).json({ error: "env must be an array of KEY=value strings" });
    }
    const result = await docker.updateContainerEnv(host, req.params.id, env);
    logAudit({
      actor: req.user,
      action: "compose.container.env_update",
      target: `${host.id}/${req.params.id}`,
      detail: { restarted: result.restarted, envCount: env.length },
    });
    res.json({
      ok: true,
      ...result,
      message: result.restarted
        ? "Environment updated. The container was recreated and restarted."
        : "Environment updated. The container was recreated.",
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post("/docker/projects/:hostId/:project/restart", async (req, res) => {
  try {
    const host = getDockerHostSecrets(req.params.hostId);
    if (!host || !canUseHost(req.user, host)) {
      return res.status(404).json({ error: "Docker host not found" });
    }
    const project = docker.validateProjectName(req.params.project);
    const result = await docker.restartProject(host, project);
    logAudit({
      actor: req.user,
      action: "compose.restart",
      target: `${host.id}/${project}`,
      detail: result,
    });
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.get("/docker/containers/:hostId/:id/logs", async (req, res) => {
  try {
    const host = getDockerHostSecrets(req.params.hostId);
    if (!host || !canUseHost(req.user, host)) {
      return res.status(404).json({ error: "Docker host not found" });
    }
    const logs = await docker.getContainerLogs(host, req.params.id, { tail: req.query.tail });
    res.type("text/plain").send(logs);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.get("/docker/containers/:hostId/:id/health", async (req, res) => {
  try {
    const host = getDockerHostSecrets(req.params.hostId);
    if (!host || !canUseHost(req.user, host)) {
      return res.status(404).json({ error: "Docker host not found" });
    }
    const info = await docker.inspectContainer(host, req.params.id);
    res.json(info);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

export default router;
