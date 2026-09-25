import https from "https";
import http from "http";
import fs from "fs";
import fsPromises from "fs/promises";
import os from "os";
import path from "path";
import { spawn } from "child_process";

// K3s / Kubernetes API config is read from process.env at call time so changes
// saved in the admin Settings tab take effect without a restart.
export function k3sConfig() {
  return {
    url: (process.env.K3S_API_URL || "").replace(/\/+$/, ""),
    token: process.env.K3S_API_TOKEN,
    verifyTls: process.env.K3S_VERIFY_TLS === "true",
  };
}

function formatK3sErr(method, pathName, err) {
  if (err?.code === "ECONNABORTED" || /timeout/i.test(err?.message || "")) {
    return `K3s API error [${method.toUpperCase()} ${pathName}]: Timeout: request did not complete within the allotted timeout`;
  }
  if (String(err?.message || "").startsWith("K3s API error")) return err.message;
  const detail = err?.response?.data?.message || err?.response?.data || err?.message || "Unknown error";
  return `K3s API error [${method.toUpperCase()} ${pathName}]: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`;
}

/**
 * Talk to the Kubernetes API via curl --http2.
 * Node's axios/http2 clients hang or take 20–60s against this cluster; curl is reliable.
 */
async function curlApiOnce(cfg, method, apiPath, body, extraHeaders, timeoutMs, raw) {
  const marker = "__FORGE_CURL_CODE__:";
  const args = [
    "-sS",
    "--http2",
    "--connect-timeout", "10",
    "--max-time", String(Math.max(5, Math.ceil(timeoutMs / 1000))),
    "-X", String(method || "GET").toUpperCase(),
    "-w", `\n${marker}%{http_code}`,
    "-H", `Authorization: Bearer ${cfg.token}`,
    "-H", "Accept: */*",
  ];
  if (!cfg.verifyTls) args.push("-k");

  const headers = {};
  for (const [k, v] of Object.entries(extraHeaders || {})) {
    if (v == null || k.startsWith(":")) continue;
    headers[String(k).toLowerCase()] = String(v);
  }

  let bodyFile = null;
  if (body != null) {
    const payload = Buffer.isBuffer(body) || typeof body === "string" ? body : JSON.stringify(body);
    if (!headers["content-type"]) headers["content-type"] = "application/json";
    bodyFile = path.join(os.tmpdir(), `forge-k3s-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.body`);
    await fsPromises.writeFile(bodyFile, payload);
    args.push("--data-binary", `@${bodyFile}`);
  }
  for (const [k, v] of Object.entries(headers)) {
    args.push("-H", `${k}: ${v}`);
  }
  args.push(`${cfg.url}${apiPath}`);

  try {
    const { code, out, errText } = await new Promise((resolve, reject) => {
      const child = spawn("curl", args, { stdio: ["ignore", "pipe", "pipe"] });
      const chunks = [];
      const errChunks = [];
      child.stdout.on("data", (c) => chunks.push(c));
      child.stderr.on("data", (c) => errChunks.push(c));
      child.on("error", reject);
      child.on("close", (exitCode) => {
        resolve({
          code: exitCode,
          out: Buffer.concat(chunks).toString("utf8"),
          errText: Buffer.concat(errChunks).toString("utf8").trim(),
        });
      });
    });

    const needle = `\n${marker}`;
    const idx = out.lastIndexOf(needle);
    let status = 0;
    let text = out;
    if (idx >= 0) {
      status = Number(out.slice(idx + needle.length).trim()) || 0;
      text = out.slice(0, idx);
    }

    if ((code !== 0 && !status) || !status) {
      const err = new Error(errText || (code !== 0 ? `curl exited ${code}` : "K3s API returned no HTTP status (connection failed)"));
      if (/timed out|timeout/i.test(err.message) || !status) err.code = "ECONNABORTED";
      throw err;
    }

    let data = text;
    if (!raw) {
      try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    }

    if (status >= 400) {
      const detail = (data && data.message) || data || text || `HTTP ${status}`;
      const err = new Error(typeof detail === "string" ? detail : JSON.stringify(detail));
      err.response = { status, data };
      throw err;
    }
    return data;
  } finally {
    if (bodyFile) {
      try { await fsPromises.unlink(bodyFile); } catch { /* ignore */ }
    }
  }
}

/** Authenticated request against the cluster API (curl HTTP/2 + bearer token). */
async function request(method, pathName, body = null, extraHeaders = {}, { timeout, raw = false } = {}) {
  const cfg = k3sConfig();
  if (!cfg.url) throw new Error("K3s API URL is not configured");
  if (!cfg.token) throw new Error("K3s API token is not configured");
  const timeoutMs = timeout ?? 60_000;

  const run = () => curlApiOnce(cfg, method, pathName, body, extraHeaders, timeoutMs, raw);
  try {
    return await run();
  } catch (err) {
    const retryable = err.code === "ECONNABORTED"
      || /ECONNRESET|timed out|timeout|connection failed|curl exited|Empty reply/i.test(err.message || "");
    if (retryable) {
      try {
        return await run();
      } catch (err2) {
        throw new Error(formatK3sErr(method, pathName, err2));
      }
    }
    throw new Error(formatK3sErr(method, pathName, err));
  }
}

// GET helper (kept for the Settings connectivity test).
export const k3sRequest = (pathName) => request("get", pathName);

// Lightweight connectivity check. Reads /version.
// `timeoutMs` keeps provisioning health probes snappy (admin Settings can use default).
export async function testConnection({ timeoutMs = 8_000 } = {}) {
  const v = await request("get", "/version", null, {}, { timeout: timeoutMs });
  return {
    url: k3sConfig().url,
    gitVersion: v?.gitVersion ?? null,
    platform: v?.platform ?? null,
  };
}

// --- Ownership labels ------------------------------------------------------
// Forge stamps every namespace it creates with these labels so the UI can filter
// by owner / team. Keys are a valid DNS-subdomain-prefixed name.
export const LABELS = {
  managed: "forge.io/managed",
  owner: "forge.io/owner",
  team: "forge.io/team",
  env: "forge.io/env",
  project: "forge.io/project",
};

/** @deprecated Legacy label keys from Proxmox SSP — still matched when listing namespaces. */
export const LEGACY_LABELS = {
  managed: "ssp.io/managed",
  owner: "ssp.io/owner",
  team: "ssp.io/team",
  env: "ssp.io/env",
  project: "ssp.io/project",
};

// Kubernetes label VALUES must be ≤63 chars, alphanumeric plus -_. and must
// start/end alphanumeric. Usernames can be emails ("@", etc.), so sanitize the
// same way on write and on read to keep filtering consistent. The original
// human-readable value is kept in an annotation for display.
export function k8sLabelValue(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^[-_.]+|[-_.]+$/g, "")
    .slice(0, 63)
    .replace(/[-_.]+$/g, "");
}

// --- Namespaces ------------------------------------------------------------
export async function listNamespaces({ labelSelector } = {}) {
  const q = labelSelector ? `?labelSelector=${encodeURIComponent(labelSelector)}` : "";
  const data = await request("get", `/api/v1/namespaces${q}`);
  return data.items || [];
}

export async function getNamespace(name) {
  return request("get", `/api/v1/namespaces/${encodeURIComponent(name)}`);
}

export async function createNamespace({ name, labels = {}, annotations = {} }) {
  return request("post", "/api/v1/namespaces", {
    apiVersion: "v1",
    kind: "Namespace",
    metadata: { name, labels, annotations },
  });
}

export async function deleteNamespace(name) {
  return request("delete", `/api/v1/namespaces/${encodeURIComponent(name)}`);
}

// Force-terminate a namespace that's stuck (e.g. hanging in "Terminating"):
// clear its finalizers via the /finalize subresource so the API server can
// remove it. Use with care — it drops the normal cleanup guarantees.
export async function forceFinalizeNamespace(name) {
  const ns = await getNamespace(name);
  ns.spec = { ...(ns.spec || {}), finalizers: [] };
  return request("put", `/api/v1/namespaces/${encodeURIComponent(name)}/finalize`, ns);
}

// --- Workloads (Deployments) + Pods ---------------------------------------
export async function listPods(namespace) {
  const data = await request("get", `/api/v1/namespaces/${encodeURIComponent(namespace)}/pods`);
  return data.items || [];
}

export async function listDeployments(namespace) {
  const data = await request("get", `/apis/apps/v1/namespaces/${encodeURIComponent(namespace)}/deployments`);
  return data.items || [];
}

export async function createDeployment({ namespace, name, image, replicas = 1, port, labels = {} }) {
  const selector = { app: name };
  return request("post", `/apis/apps/v1/namespaces/${encodeURIComponent(namespace)}/deployments`, {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: { name, namespace, labels: { ...labels, app: name } },
    spec: {
      replicas,
      selector: { matchLabels: selector },
      template: {
        metadata: { labels: selector },
        spec: {
          containers: [{
            name,
            image,
            ...(port ? { ports: [{ containerPort: port }] } : {}),
          }],
        },
      },
    },
  });
}

export async function deleteDeployment(namespace, name) {
  return request("delete", `/apis/apps/v1/namespaces/${encodeURIComponent(namespace)}/deployments/${encodeURIComponent(name)}`);
}

/**
 * Delete a Deployment and make a best-effort cleanup of ReplicaSets / Pods.
 * Slow or stuck K3s nodes often leave Terminating pods behind a normal DELETE;
 * we scale to 0, cascade with Foreground, then remove leftovers (optionally force).
 */
export async function deleteWorkloadStack(namespace, name, { force = false, onProgress } = {}) {
  const grace = force ? 0 : 15;
  const cleaned = { deployment: false, replicaSets: 0, pods: 0, service: false, ingress: false, pvc: false };
  const progress = (phase) => {
    try { onProgress?.(phase); } catch { /* ignore */ }
  };

  // 1) Scale to zero so the controller stops recreating pods while we tear down.
  progress("scale");
  try {
    await scaleDeployment(namespace, name, 0);
  } catch {
    /* deployment may already be gone / unreachable */
  }

  // 2) Delete Deployment with explicit cascading policy.
  progress("delete-dep");
  try {
    await request(
      "delete",
      `/apis/apps/v1/namespaces/${encodeURIComponent(namespace)}/deployments/${encodeURIComponent(name)}`
        + `?propagationPolicy=Foreground&gracePeriodSeconds=${grace}`,
      {
        kind: "DeleteOptions",
        apiVersion: "v1",
        propagationPolicy: "Foreground",
        gracePeriodSeconds: grace,
      },
    );
    cleaned.deployment = true;
  } catch (err) {
    const msg = String(err.message || "");
    if (!/404|not found/i.test(msg)) throw err;
  }

  // 3) Sweep ReplicaSets that still belong to this app/deployment.
  try {
    const rsData = await request(
      "get",
      `/apis/apps/v1/namespaces/${encodeURIComponent(namespace)}/replicasets?labelSelector=${encodeURIComponent(`app=${name}`)}`,
    );
    for (const rs of rsData.items || []) {
      const rsName = rs.metadata?.name;
      if (!rsName) continue;
      try {
        await request(
          "delete",
          `/apis/apps/v1/namespaces/${encodeURIComponent(namespace)}/replicasets/${encodeURIComponent(rsName)}`
            + `?propagationPolicy=Foreground&gracePeriodSeconds=${grace}`,
          {
            kind: "DeleteOptions",
            apiVersion: "v1",
            propagationPolicy: "Foreground",
            gracePeriodSeconds: grace,
          },
        );
        cleaned.replicaSets += 1;
      } catch { /* ignore */ }
    }
  } catch { /* ignore RS list errors */ }

  // 4) Sweep pods still matching the workload (stuck Terminating / orphans).
  progress("clean-pods");
  cleaned.pods = await deletePodsForApp(namespace, name, { force: true });

  // 5) Companions after pods are gone (PVC delete while mounted leaves pods stuck).
  progress("companions");
  try {
    await deleteService(namespace, name);
    cleaned.service = true;
  } catch { /* ignore */ }
  try {
    await deleteIngress(namespace, name);
    cleaned.ingress = true;
  } catch { /* ignore */ }
  try {
    await deletePersistentVolumeClaim(namespace, `${name}-data`);
    cleaned.pvc = true;
  } catch { /* ignore */ }

  return { ok: true, cleaned };
}

export async function deletePod(namespace, pod, { force = false } = {}) {
  const grace = force ? 0 : 15;
  const qs = `?gracePeriodSeconds=${grace}${force ? "&propagationPolicy=Background" : ""}`;
  return request(
    "delete",
    `/api/v1/namespaces/${encodeURIComponent(namespace)}/pods/${encodeURIComponent(pod)}${qs}`,
    {
      kind: "DeleteOptions",
      apiVersion: "v1",
      gracePeriodSeconds: grace,
      ...(force ? { propagationPolicy: "Background" } : {}),
    },
  );
}

/** Force-remove pods labeled app=<name>. */
export async function deletePodsForApp(namespace, appName, { force = true } = {}) {
  let removed = 0;
  let pods = [];
  try {
    const data = await request(
      "get",
      `/api/v1/namespaces/${encodeURIComponent(namespace)}/pods?labelSelector=${encodeURIComponent(`app=${appName}`)}`,
    );
    pods = data.items || [];
  } catch {
    return 0;
  }

  for (const p of pods) {
    const podName = p.metadata?.name;
    if (!podName) continue;
    try {
      // Clear common stuck finalizers when force-deleting.
      if (force && (p.metadata?.finalizers || []).length) {
        try {
          await request(
            "patch",
            `/api/v1/namespaces/${encodeURIComponent(namespace)}/pods/${encodeURIComponent(podName)}`,
            { metadata: { finalizers: [] } },
            { "Content-Type": "application/merge-patch+json" },
          );
        } catch { /* ignore */ }
      }
      await deletePod(namespace, podName, { force });
      removed += 1;
    } catch { /* ignore individual pod errors */ }
  }
  return removed;
}

export async function scaleDeployment(namespace, name, replicas) {
  const reps = Number(replicas);
  if (!Number.isInteger(reps) || reps < 0 || reps > 50) {
    throw new Error("Replicas must be a whole number between 0 and 50");
  }
  try {
    return await request(
      "patch",
      `/apis/apps/v1/namespaces/${encodeURIComponent(namespace)}/deployments/${encodeURIComponent(name)}/scale`,
      { spec: { replicas: reps } },
      { "Content-Type": "application/merge-patch+json" },
    );
  } catch {
    return request(
      "patch",
      `/apis/apps/v1/namespaces/${encodeURIComponent(namespace)}/deployments/${encodeURIComponent(name)}`,
      { spec: { replicas: reps } },
      { "Content-Type": "application/strategic-merge-patch+json" },
    );
  }
}

export async function restartDeployment(namespace, name) {
  const ts = new Date().toISOString();
  return request(
    "patch",
    `/apis/apps/v1/namespaces/${encodeURIComponent(namespace)}/deployments/${encodeURIComponent(name)}`,
    {
      spec: {
        template: {
          metadata: {
            annotations: {
              "kubectl.kubernetes.io/restartedAt": ts,
              "forge.io/restartedAt": ts,
            },
          },
        },
      },
    },
    { "Content-Type": "application/strategic-merge-patch+json" },
  );
}

export async function getDeployment(namespace, name) {
  return request(
    "get",
    `/apis/apps/v1/namespaces/${encodeURIComponent(namespace)}/deployments/${encodeURIComponent(name)}`,
  );
}

const FATAL_POD_REASONS = new Set([
  "CrashLoopBackOff",
  "ImagePullBackOff",
  "ErrImagePull",
  "InvalidImageName",
  "CreateContainerConfigError",
  "CreateContainerError",
  "RunContainerError",
]);

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Extract waiting/terminated reason from a Pod (Pending, CrashLoop, etc.). */
export function podProgressInfo(pod) {
  const pick = (statuses = []) => {
    for (const c of statuses) {
      const waiting = c.state?.waiting;
      if (waiting?.reason) {
        return { reason: waiting.reason, message: waiting.message || "", fatal: FATAL_POD_REASONS.has(waiting.reason) };
      }
      const term = c.state?.terminated;
      if (term?.reason && term.exitCode) {
        return {
          reason: term.reason,
          message: term.message || `exit ${term.exitCode}`,
          fatal: FATAL_POD_REASONS.has(term.reason) || Number(term.exitCode) !== 0,
        };
      }
    }
    return null;
  };
  const fromContainers =
    pick(pod.status?.containerStatuses)
    || pick(pod.status?.initContainerStatuses);
  if (fromContainers) return fromContainers;

  const cond = (pod.status?.conditions || []).find(
    (c) => c.type === "PodScheduled" && c.status === "False",
  );
  if (cond) {
    return {
      reason: cond.reason || "Unschedulable",
      message: cond.message || "",
      fatal: false,
    };
  }
  const phase = pod.status?.phase || "Unknown";
  if (phase === "Failed" || phase === "Unknown") {
    return { reason: phase, message: pod.status?.message || "", fatal: true };
  }
  if (phase === "Pending") {
    return { reason: "Pending", message: pod.status?.message || "Waiting for scheduling / image pull", fatal: false };
  }
  return { reason: "", message: "", fatal: false };
}

function labelSelectorFromMatchLabels(matchLabels = {}) {
  return Object.entries(matchLabels)
    .map(([k, v]) => `${k}=${v}`)
    .join(",");
}

async function listPodsForDeployment(namespace, deployment) {
  const matchLabels = deployment?.spec?.selector?.matchLabels || {};
  const selector = labelSelectorFromMatchLabels(matchLabels);
  if (!selector) {
    // Fallback: pods owned by this deployment name via app= label (guided stacks).
    const name = deployment?.metadata?.name;
    if (!name) return [];
    const data = await request(
      "get",
      `/api/v1/namespaces/${encodeURIComponent(namespace)}/pods?labelSelector=${encodeURIComponent(`app=${name}`)}`,
    );
    return data.items || [];
  }
  const data = await request(
    "get",
    `/api/v1/namespaces/${encodeURIComponent(namespace)}/pods?labelSelector=${encodeURIComponent(selector)}`,
  );
  return data.items || [];
}

/**
 * Poll until each Deployment has readyReplicas >= desired (or desired is 0).
 * Fails early on CrashLoop / ImagePull after fatalGraceMs; otherwise on timeout
 * with the last pod Pending/failed reason.
 */
export async function waitForDeploymentsReady({
  namespace,
  names = [],
  timeoutMs = 300_000,
  intervalMs = 4_000,
  fatalGraceMs = 45_000,
  onTick,
} = {}) {
  const unique = [...new Set((names || []).map((n) => String(n || "").trim()).filter(Boolean))];
  if (!unique.length) {
    return { ok: true, skipped: true, deployments: [] };
  }

  const deadline = Date.now() + timeoutMs;
  const fatalSince = new Map(); // `${dep}/${pod}/${reason}` -> firstSeenMs
  let lastDetail = "";

  while (true) {
    const snapshots = [];
    let allReady = true;

    for (const name of unique) {
      let dep;
      try {
        dep = await getDeployment(namespace, name);
      } catch (err) {
        allReady = false;
        snapshots.push({
          name,
          ready: 0,
          desired: 1,
          pods: [],
          detail: `Deployment/${name}: ${err.message}`,
        });
        continue;
      }

      const desired = Number(dep.spec?.replicas ?? 1);
      const ready = Number(dep.status?.readyReplicas || 0);
      const available = Number(dep.status?.availableReplicas || 0);
      const pods = await listPodsForDeployment(namespace, dep);
      const podInfos = pods.map((p) => {
        const info = podProgressInfo(p);
        const readyCount = (p.status?.containerStatuses || []).filter((c) => c.ready).length;
        const containerCount = (p.spec?.containers || []).length || 1;
        return {
          name: p.metadata?.name,
          phase: p.status?.phase || "Unknown",
          ready: `${readyCount}/${containerCount}`,
          reason: info.reason,
          message: info.message,
          fatal: info.fatal,
        };
      });

      const depReady = desired === 0 ? true : (ready >= desired && available >= desired);
      if (!depReady) allReady = false;

      const problem = podInfos.find((p) => p.fatal || p.reason)
        || (!depReady ? { reason: "Waiting", message: `ready ${ready}/${desired}` } : null);

      snapshots.push({
        name,
        ready,
        desired,
        available,
        pods: podInfos,
        detail: problem
          ? `Deployment/${name}: ${problem.reason || "not ready"}${problem.message ? ` — ${problem.message}` : ""} (ready ${ready}/${desired})`
          : `Deployment/${name}: ready ${ready}/${desired}`,
      });

      // Early fail on fatal container states.
      for (const p of podInfos) {
        if (!p.fatal || !p.reason) continue;
        const key = `${name}/${p.name}/${p.reason}`;
        if (!fatalSince.has(key)) fatalSince.set(key, Date.now());
        if (Date.now() - fatalSince.get(key) >= fatalGraceMs) {
          const err = new Error(
            `Pod ${p.name} stuck in ${p.reason}${p.message ? `: ${p.message}` : ""}`,
          );
          err.code = "K8S_POD_FAILED";
          err.detail = snapshots.map((s) => s.detail).join("\n");
          err.snapshots = snapshots;
          throw err;
        }
      }
    }

    lastDetail = snapshots.map((s) => s.detail).join(" · ");
    try {
      onTick?.({ snapshots, allReady, detail: lastDetail });
    } catch (tickErr) {
      if (tickErr?.cancelled) throw tickErr;
      // ignore non-cancel tick errors
    }

    if (allReady) {
      return { ok: true, deployments: snapshots };
    }

    if (Date.now() >= deadline) {
      const err = new Error(
        `Timed out waiting for pods to become Ready. ${lastDetail || "No status available."}`,
      );
      err.code = "K8S_READY_TIMEOUT";
      err.detail = lastDetail;
      err.snapshots = snapshots;
      throw err;
    }

    await sleep(intervalMs);
  }
}

/** Collect Ingress host URLs from applied Ingress objects (for job summary). */
export function ingressUrlsFromDocs(docs = []) {
  const urls = [];
  for (const doc of docs) {
    if (String(doc?.kind || "") !== "Ingress") continue;
    for (const rule of doc.spec?.rules || []) {
      const host = String(rule?.host || "").trim();
      if (!host) continue;
      const path = rule?.http?.paths?.[0]?.path || "/";
      const p = path.startsWith("/") ? path : `/${path}`;
      urls.push(`http://${host}${p === "/" ? "/" : p}`);
    }
  }
  return [...new Set(urls)];
}

/** Flatten a Deployment into fields the Resources edit form can bind. */
export function deploymentEditView(dep) {
  const containers = dep?.spec?.template?.spec?.containers || [];
  const primary = containers[0] || {};
  const resources = primary.resources || {};
  const probe =
    primary.readinessProbe?.httpGet?.path
    || primary.livenessProbe?.httpGet?.path
    || "";
  return {
    name: dep?.metadata?.name || "",
    namespace: dep?.metadata?.namespace || "",
    replicas: dep?.spec?.replicas ?? 1,
    container: primary.name || "",
    containers: containers.map((c) => c.name),
    image: primary.image || "",
    imagePullPolicy: primary.imagePullPolicy || "IfNotPresent",
    port: primary.ports?.[0]?.containerPort ?? "",
    cpuRequest: resources.requests?.cpu || "",
    memoryRequest: resources.requests?.memory || "",
    cpuLimit: resources.limits?.cpu || "",
    memoryLimit: resources.limits?.memory || "",
    probePath: probe,
    command: Array.isArray(primary.command) ? primary.command.join(" ") : "",
    args: Array.isArray(primary.args) ? primary.args.join("\n") : "",
  };
}

function parseStorageGi(storage) {
  const s = String(storage || "").trim();
  const gi = s.match(/^(\d+(?:\.\d+)?)\s*Gi$/i);
  if (gi) return String(Math.max(1, Math.round(Number(gi[1]))));
  const mi = s.match(/^(\d+(?:\.\d+)?)\s*Mi$/i);
  if (mi) return String(Math.max(1, Math.round(Number(mi[1]) / 1024)));
  const n = s.match(/^(\d+)/);
  return n ? n[1] : "";
}

/**
 * Load Deployment + companion Service / Ingress / PVC into the guided-form shape
 * used by K8sDeployPanel (create + edit).
 */
export async function getWorkloadStack(namespace, name) {
  const dep = await getDeployment(namespace, name);
  const primary = dep?.spec?.template?.spec?.containers?.[0] || {};
  const resources = primary.resources || {};
  const labels = { ...(dep?.metadata?.labels || {}) };
  delete labels.app;
  const labelsText = Object.entries(labels)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  const envText = (primary.env || [])
    .filter((e) => e && e.name && e.value != null && !e.valueFrom)
    .map((e) => `${e.name}=${e.value}`)
    .join("\n");

  const form = {
    name: dep?.metadata?.name || name,
    image: primary.image || "",
    replicas: dep?.spec?.replicas ?? 1,
    port: primary.ports?.[0]?.containerPort != null ? String(primary.ports[0].containerPort) : "",
    imagePullPolicy: primary.imagePullPolicy || "IfNotPresent",
    command: Array.isArray(primary.command) ? primary.command.join(" ") : "",
    args: Array.isArray(primary.args) ? primary.args.join("\n") : "",
    probePath:
      primary.readinessProbe?.httpGet?.path
      || primary.livenessProbe?.httpGet?.path
      || "",
    createService: false,
    serviceType: "ClusterIP",
    ingressHost: "",
    ingressPath: "/",
    pvcSizeGi: "",
    pvcMountPath: "/data",
    labelsText: labelsText || "app.kubernetes.io/managed-by=forge",
    envText,
    cpuRequest: resources.requests?.cpu || "",
    memoryRequest: resources.requests?.memory || "",
    cpuLimit: resources.limits?.cpu || "",
    memoryLimit: resources.limits?.memory || "",
  };

  try {
    const svc = await request(
      "get",
      `/api/v1/namespaces/${encodeURIComponent(namespace)}/services/${encodeURIComponent(name)}`,
    );
    form.createService = true;
    form.serviceType = svc.spec?.type || "ClusterIP";
    if (!form.port && svc.spec?.ports?.[0]?.port != null) {
      form.port = String(svc.spec.ports[0].targetPort || svc.spec.ports[0].port);
    }
  } catch {
    /* no companion service */
  }

  try {
    const ings = await listIngresses(namespace);
    const match = ings.find((i) => i.metadata?.name === name)
      || ings.find((i) => (i.spec?.rules || []).some((r) =>
        (r.http?.paths || []).some((p) => p.backend?.service?.name === name)));
    if (match) {
      const rule = (match.spec?.rules || [])[0] || {};
      const path = (rule.http?.paths || [])[0] || {};
      form.ingressHost = rule.host || "";
      form.ingressPath = path.path || "/";
      form.createService = true;
    }
  } catch {
    /* ignore ingress lookup errors */
  }

  try {
    const pvc = await request(
      "get",
      `/api/v1/namespaces/${encodeURIComponent(namespace)}/persistentvolumeclaims/${encodeURIComponent(`${name}-data`)}`,
    );
    const storage = pvc.status?.capacity?.storage || pvc.spec?.resources?.requests?.storage || "";
    form.pvcSizeGi = parseStorageGi(storage);
    const mount = (primary.volumeMounts || []).find((m) => m.name === "data")
      || (primary.volumeMounts || [])[0];
    if (mount?.mountPath) form.pvcMountPath = mount.mountPath;
  } catch {
    /* no companion PVC */
  }

  return { form };
}

/**
 * Patch common Deployment fields (image, replicas, resources, probes, command).
 * Triggers a rolling update when the pod template changes.
 */
export async function updateDeployment(namespace, name, patch = {}) {
  const dep = await getDeployment(namespace, name);
  const containers = structuredClone(dep?.spec?.template?.spec?.containers || []);
  if (!containers.length) throw new Error("Deployment has no containers");

  const containerName = String(patch.container || "").trim();
  const idx = containerName
    ? containers.findIndex((c) => c.name === containerName)
    : 0;
  if (idx < 0) throw new Error(`Container "${containerName}" not found`);

  const next = containers[idx];

  if (patch.image != null && String(patch.image).trim()) {
    next.image = String(patch.image).trim();
  }
  if (patch.imagePullPolicy) {
    next.imagePullPolicy = String(patch.imagePullPolicy).trim();
  }

  const portNum = patch.port !== undefined && patch.port !== "" && patch.port != null
    ? Number(patch.port)
    : undefined;
  if (portNum != null) {
    if (!Number.isFinite(portNum) || portNum < 1 || portNum > 65535) {
      throw new Error("Container port must be between 1 and 65535");
    }
    next.ports = [{ containerPort: portNum }];
  }

  const hasRes =
    patch.cpuRequest != null || patch.memoryRequest != null
    || patch.cpuLimit != null || patch.memoryLimit != null;
  if (hasRes) {
    const req = {};
    const lim = {};
    if (patch.cpuRequest) req.cpu = String(patch.cpuRequest).trim();
    if (patch.memoryRequest) req.memory = String(patch.memoryRequest).trim();
    if (patch.cpuLimit) lim.cpu = String(patch.cpuLimit).trim();
    if (patch.memoryLimit) lim.memory = String(patch.memoryLimit).trim();
    next.resources = {
      ...(Object.keys(req).length ? { requests: req } : {}),
      ...(Object.keys(lim).length ? { limits: lim } : {}),
    };
    if (!Object.keys(next.resources).length) delete next.resources;
  }

  if (patch.command !== undefined) {
    const cmd = String(patch.command || "").trim();
    if (cmd) next.command = cmd.split(/\s+/).filter(Boolean);
    else delete next.command;
  }
  if (patch.args !== undefined) {
    const argList = String(patch.args || "")
      .split(/\r?\n|,/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (argList.length) next.args = argList;
    else delete next.args;
  }

  if (patch.probePath !== undefined) {
    const probe = String(patch.probePath || "").trim();
    const probePort = portNum
      || next.ports?.[0]?.containerPort
      || 80;
    if (probe) {
      next.readinessProbe = {
        httpGet: { path: probe, port: probePort },
        initialDelaySeconds: 5,
        periodSeconds: 10,
      };
      next.livenessProbe = {
        httpGet: { path: probe, port: probePort },
        initialDelaySeconds: 15,
        periodSeconds: 20,
      };
    } else {
      delete next.readinessProbe;
      delete next.livenessProbe;
    }
  }

  containers[idx] = next;

  const body = {
    spec: {
      template: {
        metadata: {
          annotations: {
            ...(dep.spec?.template?.metadata?.annotations || {}),
            "forge.io/editedAt": new Date().toISOString(),
          },
        },
        spec: {
          containers,
        },
      },
    },
  };

  if (patch.replicas != null && patch.replicas !== "") {
    const reps = Number(patch.replicas);
    if (!Number.isInteger(reps) || reps < 0 || reps > 50) {
      throw new Error("Replicas must be a whole number between 0 and 50");
    }
    body.spec.replicas = reps;
  }

  await request(
    "patch",
    `/apis/apps/v1/namespaces/${encodeURIComponent(namespace)}/deployments/${encodeURIComponent(name)}`,
    body,
    { "Content-Type": "application/merge-patch+json" },
  );

  return { ok: true, message: "Deployment updated. Kubernetes will roll out changes." };
}

/** Read env from the first container in a Deployment. */
export async function getDeploymentEnv(namespace, name) {
  const dep = await getDeployment(namespace, name);
  const containers = dep?.spec?.template?.spec?.containers || [];
  return containers.map((c) => ({
    name: c.name,
    env: (c.env || []).map((e) => ({
      name: e.name,
      value: e.value != null ? String(e.value) : "",
      valueFrom: !!e.valueFrom,
    })),
  }));
}

/**
 * Replace plain KEY=value env entries on the first (or named) container.
 * Triggers a rolling restart. valueFrom entries are preserved.
 */
export async function updateDeploymentEnv(namespace, name, { container, env } = {}) {
  const dep = await getDeployment(namespace, name);
  const containers = dep?.spec?.template?.spec?.containers || [];
  if (!containers.length) throw new Error("Deployment has no containers");
  const idx = container
    ? containers.findIndex((c) => c.name === container)
    : 0;
  if (idx < 0) throw new Error(`Container "${container}" not found`);

  const current = containers[idx];
  const preserved = (current.env || []).filter((e) => e.valueFrom);
  const plain = (Array.isArray(env) ? env : [])
    .map((line) => String(line || "").trim())
    .filter(Boolean)
    .map((line) => {
      const eq = line.indexOf("=");
      if (eq <= 0) throw new Error(`Invalid environment entry "${line}" (expected KEY=value)`);
      return { name: line.slice(0, eq), value: line.slice(eq + 1) };
    });

  const nextContainers = containers.map((c, i) => {
    if (i !== idx) return { name: c.name };
    return {
      name: c.name,
      env: [...preserved, ...plain],
    };
  });

  await request(
    "patch",
    `/apis/apps/v1/namespaces/${encodeURIComponent(namespace)}/deployments/${encodeURIComponent(name)}`,
    {
      spec: {
        template: {
          spec: { containers: nextContainers },
          metadata: {
            annotations: {
              "forge.io/envUpdatedAt": new Date().toISOString(),
            },
          },
        },
      },
    },
    { "Content-Type": "application/strategic-merge-patch+json" },
  );

  return {
    ok: true,
    restarted: true,
    message: "Environment updated. Kubernetes will roll out new pods (restart required).",
  };
}

export async function getPodLogs(namespace, pod, { tailLines = 200, container } = {}) {
  const params = new URLSearchParams();
  params.set("tailLines", String(Math.min(Math.max(Number(tailLines) || 200, 1), 2000)));
  if (container) params.set("container", container);
  const path = `/api/v1/namespaces/${encodeURIComponent(namespace)}/pods/${encodeURIComponent(pod)}/log?${params}`;
  const text = await request("get", path, null, {}, { timeout: 30_000, raw: true });
  return typeof text === "string" ? text : String(text ?? "");
}

/**
 * Stream pod logs via the Kubernetes API (follow=true). No kubectl required.
 * Returns an abort handle { destroy() }.
 */
export function streamPodLogs(namespace, pod, {
  tailLines = 200,
  container,
  follow = true,
  timestamps = true,
  onData,
  onEnd,
  onError,
} = {}) {
  const cfg = k3sConfig();
  if (!cfg.url) {
    onError?.(new Error("K3s API URL is not configured"));
    return { destroy() {} };
  }
  if (!cfg.token) {
    onError?.(new Error("K3s API token is not configured"));
    return { destroy() {} };
  }

  let base;
  try {
    base = new URL(cfg.url);
  } catch {
    onError?.(new Error("Invalid K3s API URL"));
    return { destroy() {} };
  }

  const params = new URLSearchParams();
  params.set("follow", follow ? "true" : "false");
  params.set("tailLines", String(Math.min(Math.max(Number(tailLines) || 200, 1), 2000)));
  if (timestamps) params.set("timestamps", "true");
  if (container) params.set("container", container);

  const reqPath = `/api/v1/namespaces/${encodeURIComponent(namespace)}/pods/${encodeURIComponent(pod)}/log?${params}`;
  const lib = base.protocol === "http:" ? http : https;
  let destroyed = false;
  let resRef = null;

  const req = lib.request(
    {
      protocol: base.protocol,
      hostname: base.hostname,
      port: base.port || (base.protocol === "https:" ? 443 : 80),
      path: reqPath,
      method: "GET",
      headers: { Authorization: `Bearer ${cfg.token}`, Accept: "*/*" },
      rejectUnauthorized: cfg.verifyTls,
      timeout: 0,
    },
    (res) => {
      resRef = res;
      if (res.statusCode && res.statusCode >= 400) {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => { body += chunk; });
        res.on("end", () => {
          if (destroyed) return;
          let msg = body.trim() || `HTTP ${res.statusCode}`;
          try {
            const j = JSON.parse(body);
            if (j?.message) msg = j.message;
          } catch { /* plain text */ }
          onError?.(new Error(msg));
        });
        return;
      }
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        if (!destroyed) onData?.(chunk);
      });
      res.on("end", () => {
        if (!destroyed) onEnd?.();
      });
      res.on("error", (err) => {
        if (!destroyed) onError?.(err);
      });
    },
  );

  req.on("error", (err) => {
    if (!destroyed) onError?.(err);
  });
  req.end();

  return {
    destroy() {
      destroyed = true;
      try { req.destroy(); } catch { /* ignore */ }
      try { resRef?.destroy?.(); } catch { /* ignore */ }
    },
  };
}

/** One-shot command in a pod via kubectl (Forge writes a temp kubeconfig). */
export async function execInPod(namespace, pod, { command = "id", container } = {}) {
  const cmdParts = Array.isArray(command)
    ? command
    : ["sh", "-c", String(command || "id")];
  const cfg = k3sConfig();
  if (!cfg.url) throw new Error("K3s API URL is not configured");
  if (!cfg.token) throw new Error("K3s API token is not configured");

  const kubeconfig = await writeTempKubeconfig(cfg);
  try {
    return await new Promise((resolve, reject) => {
      const args = [
        "--kubeconfig", kubeconfig,
        "exec", "-n", namespace, pod,
        ...(container ? ["-c", container] : []),
        "--",
        ...cmdParts,
      ];
      const child = spawn("kubectl", args, { windowsHide: true, env: process.env });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        reject(new Error("exec timed out"));
      }, 30000);
      child.stdout.on("data", (d) => { stdout += d.toString(); });
      child.stderr.on("data", (d) => { stderr += d.toString(); });
      child.on("error", (err) => {
        clearTimeout(timer);
        reject(new Error(`kubectl not available for pod exec: ${err.message}`));
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve({ ok: true, stdout, stderr });
        else reject(new Error(stderr || stdout || `exec exited ${code}`));
      });
    });
  } finally {
    fs.unlink(kubeconfig, () => {});
  }
}

export async function writeTempKubeconfig(cfg) {
  const file = path.join(os.tmpdir(), `forge-kube-${Date.now()}.yaml`);
  const skipTls = cfg.verifyTls ? "false" : "true";
  const token = String(cfg.token).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const content = `apiVersion: v1
kind: Config
clusters:
- name: forge
  cluster:
    server: ${cfg.url}
    insecure-skip-tls-verify: ${skipTls}
users:
- name: forge
  user:
    token: "${token}"
contexts:
- name: forge
  context:
    cluster: forge
    user: forge
current-context: forge
`;
  await fsPromises.writeFile(file, content, { mode: 0o600 });
  return file;
}

// --- Services / Ingress / PVC ---------------------------------------------

export async function listServices(namespace) {
  const data = await request("get", `/api/v1/namespaces/${encodeURIComponent(namespace)}/services`);
  return data.items || [];
}

export async function createService({
  namespace,
  name,
  selector = {},
  port,
  targetPort,
  type = "ClusterIP",
  labels = {},
}) {
  const p = Number(port);
  const tp = Number(targetPort || port);
  if (!Number.isInteger(p) || p < 1 || p > 65535) throw new Error("Service port must be 1–65535");
  return request("post", `/api/v1/namespaces/${encodeURIComponent(namespace)}/services`, {
    apiVersion: "v1",
    kind: "Service",
    metadata: { name, namespace, labels: { ...labels, app: name } },
    spec: {
      type: type || "ClusterIP",
      selector: Object.keys(selector).length ? selector : { app: name },
      ports: [{ name: "http", port: p, targetPort: tp, protocol: "TCP" }],
    },
  });
}

export async function deleteService(namespace, name) {
  return request(
    "delete",
    `/api/v1/namespaces/${encodeURIComponent(namespace)}/services/${encodeURIComponent(name)}`,
  );
}

export async function listIngresses(namespace) {
  const data = await request(
    "get",
    `/apis/networking.k8s.io/v1/namespaces/${encodeURIComponent(namespace)}/ingresses`,
  );
  return data.items || [];
}

export async function createIngress({
  namespace,
  name,
  host,
  path = "/",
  serviceName,
  servicePort,
  ingressClassName = "traefik",
  labels = {},
}) {
  const h = String(host || "").trim();
  if (!h) throw new Error("Ingress host is required");
  const p = Number(servicePort);
  if (!Number.isInteger(p) || p < 1 || p > 65535) throw new Error("Ingress service port must be 1–65535");
  const pathType = path === "/" ? "Prefix" : "Prefix";
  return request(
    "post",
    `/apis/networking.k8s.io/v1/namespaces/${encodeURIComponent(namespace)}/ingresses`,
    {
      apiVersion: "networking.k8s.io/v1",
      kind: "Ingress",
      metadata: {
        name,
        namespace,
        labels: { ...labels, app: serviceName || name },
        annotations: {
          "forge.io/managed": "forge",
          // Prefer Service ClusterIP over pod Endpoints. Needed when CNI blocks
          // pod↔pod (Traefik then returns 502 even though ClusterIP works).
          "traefik.ingress.kubernetes.io/service.nativelb": "true",
          "traefik.ingress.kubernetes.io/router.entrypoints": "web",
        },
      },
      spec: {
        ...(ingressClassName ? { ingressClassName } : {}),
        rules: [{
          host: h,
          http: {
            paths: [{
              path: path || "/",
              pathType,
              backend: {
                service: {
                  name: serviceName || name,
                  port: { number: p },
                },
              },
            }],
          },
        }],
      },
    },
  );
}

export async function deleteIngress(namespace, name) {
  return request(
    "delete",
    `/apis/networking.k8s.io/v1/namespaces/${encodeURIComponent(namespace)}/ingresses/${encodeURIComponent(name)}`,
  );
}

export async function listPersistentVolumeClaims(namespace) {
  const data = await request(
    "get",
    `/api/v1/namespaces/${encodeURIComponent(namespace)}/persistentvolumeclaims`,
  );
  return data.items || [];
}

export async function createPersistentVolumeClaim({
  namespace,
  name,
  sizeGi = 1,
  accessModes = ["ReadWriteOnce"],
  storageClassName,
  labels = {},
}) {
  const gi = Number(sizeGi);
  if (!Number.isFinite(gi) || gi <= 0 || gi > 1024) throw new Error("PVC size must be between 0 and 1024 Gi");
  const body = {
    apiVersion: "v1",
    kind: "PersistentVolumeClaim",
    metadata: { name, namespace, labels: { ...labels, app: name } },
    spec: {
      accessModes,
      resources: { requests: { storage: `${gi}Gi` } },
    },
  };
  if (storageClassName) body.spec.storageClassName = storageClassName;
  return request(
    "post",
    `/api/v1/namespaces/${encodeURIComponent(namespace)}/persistentvolumeclaims`,
    body,
  );
}

export async function deletePersistentVolumeClaim(namespace, name) {
  return request(
    "delete",
    `/api/v1/namespaces/${encodeURIComponent(namespace)}/persistentvolumeclaims/${encodeURIComponent(name)}`,
  );
}

/**
 * Deploy a fuller stack: Deployment (+ optional PVC mount) + Service + optional Ingress.
 * Returns which objects were created.
 */
export async function createWorkloadStack({
  namespace,
  name,
  image,
  replicas = 1,
  port,
  serviceType = "ClusterIP",
  createService: wantService = true,
  ingressHost = "",
  ingressPath = "/",
  pvcSizeGi,
  pvcMountPath = "/data",
  labels = {},
  env = [],
  resources = null,
  imagePullPolicy = "IfNotPresent",
  probePath = "",
  command = "",
  args = "",
}) {
  const created = { deployment: null, service: null, ingress: null, pvc: null };
  const selector = { app: name };
  const portNum = port ? Number(port) : undefined;
  const volumes = [];
  const volumeMounts = [];
  const extraLabels = labels && typeof labels === "object" ? labels : {};

  const envList = (Array.isArray(env) ? env : [])
    .map((e) => {
      if (e && typeof e === "object" && e.name) {
        return { name: String(e.name), value: e.value != null ? String(e.value) : "" };
      }
      const line = String(e || "").trim();
      if (!line) return null;
      const eq = line.indexOf("=");
      if (eq <= 0) return null;
      return { name: line.slice(0, eq), value: line.slice(eq + 1) };
    })
    .filter(Boolean);

  const containerResources = {};
  if (resources && typeof resources === "object") {
    const req = {};
    const lim = {};
    if (resources.cpuRequest) req.cpu = String(resources.cpuRequest);
    if (resources.memoryRequest) req.memory = String(resources.memoryRequest);
    if (resources.cpuLimit) lim.cpu = String(resources.cpuLimit);
    if (resources.memoryLimit) lim.memory = String(resources.memoryLimit);
    if (Object.keys(req).length) containerResources.requests = req;
    if (Object.keys(lim).length) containerResources.limits = lim;
  }

  if (pvcSizeGi) {
    const pvcName = `${name}-data`;
    created.pvc = await createPersistentVolumeClaim({
      namespace,
      name: pvcName,
      sizeGi: pvcSizeGi,
      labels: { ...extraLabels, app: name },
    });
    volumes.push({
      name: "data",
      persistentVolumeClaim: { claimName: pvcName },
    });
    volumeMounts.push({
      name: "data",
      mountPath: pvcMountPath || "/data",
    });
  }

  const cmd = String(command || "").trim();
  const argList = String(args || "")
    .split(/\r?\n|,/)
    .map((s) => s.trim())
    .filter(Boolean);
  const probe = String(probePath || "").trim();

  const container = {
    name,
    image,
    imagePullPolicy: imagePullPolicy || "IfNotPresent",
    ...(portNum ? { ports: [{ containerPort: portNum }] } : {}),
    ...(envList.length ? { env: envList } : {}),
    ...(Object.keys(containerResources).length ? { resources: containerResources } : {}),
    ...(volumeMounts.length ? { volumeMounts } : {}),
    ...(cmd ? { command: cmd.split(/\s+/).filter(Boolean) } : {}),
    ...(argList.length ? { args: argList } : {}),
    ...(probe && portNum ? {
      readinessProbe: {
        httpGet: { path: probe, port: portNum },
        initialDelaySeconds: 5,
        periodSeconds: 10,
      },
      livenessProbe: {
        httpGet: { path: probe, port: portNum },
        initialDelaySeconds: 15,
        periodSeconds: 20,
      },
    } : {}),
  };

  created.deployment = await request("post", `/apis/apps/v1/namespaces/${encodeURIComponent(namespace)}/deployments`, {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: { name, namespace, labels: { ...extraLabels, app: name } },
    spec: {
      replicas,
      selector: { matchLabels: selector },
      template: {
        metadata: { labels: { ...extraLabels, ...selector } },
        spec: {
          containers: [container],
          ...(volumes.length ? { volumes } : {}),
        },
      },
    },
  });

  const expose = wantService !== false && portNum;
  if (expose) {
    const st = ["ClusterIP", "NodePort", "LoadBalancer"].includes(serviceType)
      ? serviceType
      : "ClusterIP";
    created.service = await createService({
      namespace,
      name,
      selector,
      port: portNum,
      targetPort: portNum,
      type: st,
      labels: { ...extraLabels, app: name },
    });
  }

  const host = String(ingressHost || "").trim();
  if (host && expose) {
    created.ingress = await createIngress({
      namespace,
      name,
      host,
      path: ingressPath || "/",
      serviceName: name,
      servicePort: portNum,
      labels: { ...extraLabels, app: name },
    });
  }

  return created;
}

/**
 * Apply multi-document YAML into a namespace via the Kubernetes API
 * (server-side apply). Does not require kubectl on the Forge host.
 */
export async function applyYamlManifests({ namespace, yamlText }) {
  const ns = String(namespace || "").trim();
  const yaml = String(yamlText || "").trim();
  if (!ns) throw new Error("Namespace is required");
  if (!yaml) throw new Error("YAML is required");

  const parsed = await parseYamlDocs(yaml);
  if (!parsed.length) throw new Error("No YAML documents found");

  const applied = [];
  for (const doc of parsed) {
    if (!doc || typeof doc !== "object") continue;
    const kind = String(doc.kind || "").trim();
    const apiVersion = String(doc.apiVersion || "v1").trim();
    if (!kind) throw new Error("YAML document missing kind");
    if (!doc.metadata || typeof doc.metadata !== "object") doc.metadata = {};
    const name = String(doc.metadata.name || "").trim();
    if (!name) throw new Error(`${kind} is missing metadata.name`);

    // Force into the caller's namespace for namespaced kinds.
    if (kind !== "Namespace") {
      doc.metadata.namespace = ns;
    }

    const result = await applyOneDocument({ apiVersion, kind, namespace: ns, name, doc });
    applied.push(result);
  }

  return {
    ok: true,
    message: applied.map((a) => `${a.kind}/${a.name} ${a.action}`).join("\n"),
    applied,
  };
}

/** Apply a single K8s object; used by multi-doc apply and per-doc UI progress. */
export async function applyOneDocument({ apiVersion, kind, namespace, name, doc }) {
  const { collection, named } = resourcePaths({ apiVersion, kind, namespace, name });
  const bodyYaml = await jsonToYaml(doc);

  // Prefer SSA; on timeout (common for Ingress on slow clusters) fall back to
  // classic get+put / create so the rest of the stack can still finish.
  try {
    await patchApply(named, bodyYaml, { timeoutMs: 45_000 });
    return { kind, name, action: "configured" };
  } catch (err) {
    const msg = String(err.message || "");
    if (/not found|404/i.test(msg)) {
      await request("post", collection, doc, {}, { timeout: 45_000 });
      return { kind, name, action: "created" };
    }
    if (/timeout/i.test(msg)) {
      const fallback = await applyViaJsonFallback({ collection, named, doc, kind, name });
      return fallback;
    }
    throw err;
  }
}

async function applyViaJsonFallback({ collection, named, doc, kind, name }) {
  try {
    const existing = await request("get", named, null, {}, { timeout: 20_000 });
    const next = structuredClone(doc);
    if (!next.metadata) next.metadata = {};
    next.metadata.resourceVersion = existing?.metadata?.resourceVersion;
    next.metadata.uid = existing?.metadata?.uid;
    await request("put", named, next, {}, { timeout: 45_000 });
    return { kind, name, action: "updated" };
  } catch (getErr) {
    if (!/not found|404/i.test(String(getErr.message || ""))) {
      // Last resort: try create
      try {
        await request("post", collection, doc, {}, { timeout: 45_000 });
        return { kind, name, action: "created" };
      } catch (createErr) {
        throw new Error(
          `${kind}/${name} timed out on server-side apply, and fallback also failed: ${createErr.message}`,
        );
      }
    }
    await request("post", collection, doc, {}, { timeout: 45_000 });
    return { kind, name, action: "created" };
  }
}

export async function parseYamlDocs(yamlText) {
  const py = await new Promise((resolve) => {
    const child = spawn("python3", [
      "-c",
      "import json,sys,yaml; docs=list(yaml.safe_load_all(sys.stdin.read())); print(json.dumps([d for d in docs if d is not None]))",
    ], { windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    child.on("error", (err) => resolve({ code: 127, stdout, stderr: err.message }));
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    child.stdin.write(yamlText);
    child.stdin.end();
  });
  if (py.code !== 0) {
    throw new Error(`YAML parse failed: ${(py.stderr || py.stdout || "").slice(0, 500)}`);
  }
  return JSON.parse(py.stdout || "[]");
}

async function jsonToYaml(obj) {
  const py = await new Promise((resolve) => {
    const child = spawn("python3", [
      "-c",
      "import json,sys,yaml; print(yaml.safe_dump(json.load(sys.stdin), sort_keys=False))",
    ], { windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    child.on("error", (err) => resolve({ code: 127, stdout, stderr: err.message }));
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    child.stdin.write(JSON.stringify(obj));
    child.stdin.end();
  });
  if (py.code !== 0) throw new Error(`YAML encode failed: ${(py.stderr || "").slice(0, 300)}`);
  return py.stdout;
}

function resourcePaths({ apiVersion, kind, namespace, name }) {
  const gvk = `${apiVersion}/${kind}`;
  const map = {
    "v1/Service": {
      collection: `/api/v1/namespaces/${encodeURIComponent(namespace)}/services`,
      named: `/api/v1/namespaces/${encodeURIComponent(namespace)}/services/${encodeURIComponent(name)}`,
    },
    "v1/PersistentVolumeClaim": {
      collection: `/api/v1/namespaces/${encodeURIComponent(namespace)}/persistentvolumeclaims`,
      named: `/api/v1/namespaces/${encodeURIComponent(namespace)}/persistentvolumeclaims/${encodeURIComponent(name)}`,
    },
    "v1/ConfigMap": {
      collection: `/api/v1/namespaces/${encodeURIComponent(namespace)}/configmaps`,
      named: `/api/v1/namespaces/${encodeURIComponent(namespace)}/configmaps/${encodeURIComponent(name)}`,
    },
    "v1/Secret": {
      collection: `/api/v1/namespaces/${encodeURIComponent(namespace)}/secrets`,
      named: `/api/v1/namespaces/${encodeURIComponent(namespace)}/secrets/${encodeURIComponent(name)}`,
    },
    "v1/ServiceAccount": {
      collection: `/api/v1/namespaces/${encodeURIComponent(namespace)}/serviceaccounts`,
      named: `/api/v1/namespaces/${encodeURIComponent(namespace)}/serviceaccounts/${encodeURIComponent(name)}`,
    },
    "apps/v1/Deployment": {
      collection: `/apis/apps/v1/namespaces/${encodeURIComponent(namespace)}/deployments`,
      named: `/apis/apps/v1/namespaces/${encodeURIComponent(namespace)}/deployments/${encodeURIComponent(name)}`,
    },
    "apps/v1/StatefulSet": {
      collection: `/apis/apps/v1/namespaces/${encodeURIComponent(namespace)}/statefulsets`,
      named: `/apis/apps/v1/namespaces/${encodeURIComponent(namespace)}/statefulsets/${encodeURIComponent(name)}`,
    },
    "apps/v1/DaemonSet": {
      collection: `/apis/apps/v1/namespaces/${encodeURIComponent(namespace)}/daemonsets`,
      named: `/apis/apps/v1/namespaces/${encodeURIComponent(namespace)}/daemonsets/${encodeURIComponent(name)}`,
    },
    "batch/v1/Job": {
      collection: `/apis/batch/v1/namespaces/${encodeURIComponent(namespace)}/jobs`,
      named: `/apis/batch/v1/namespaces/${encodeURIComponent(namespace)}/jobs/${encodeURIComponent(name)}`,
    },
    "batch/v1/CronJob": {
      collection: `/apis/batch/v1/namespaces/${encodeURIComponent(namespace)}/cronjobs`,
      named: `/apis/batch/v1/namespaces/${encodeURIComponent(namespace)}/cronjobs/${encodeURIComponent(name)}`,
    },
    "networking.k8s.io/v1/Ingress": {
      collection: `/apis/networking.k8s.io/v1/namespaces/${encodeURIComponent(namespace)}/ingresses`,
      named: `/apis/networking.k8s.io/v1/namespaces/${encodeURIComponent(namespace)}/ingresses/${encodeURIComponent(name)}`,
    },
    "networking.k8s.io/v1/NetworkPolicy": {
      collection: `/apis/networking.k8s.io/v1/namespaces/${encodeURIComponent(namespace)}/networkpolicies`,
      named: `/apis/networking.k8s.io/v1/namespaces/${encodeURIComponent(namespace)}/networkpolicies/${encodeURIComponent(name)}`,
    },
  };
  const hit = map[gvk];
  if (!hit) {
    throw new Error(`Unsupported kind for YAML apply: ${gvk}. Supported: ${Object.keys(map).join(", ")}`);
  }
  return hit;
}

async function patchApply(path, yamlBody, { timeoutMs = 45_000 } = {}) {
  try {
    return await request(
      "patch",
      `${path}?fieldManager=forge&force=true`,
      yamlBody,
      { "Content-Type": "application/apply-patch+yaml" },
      { timeout: timeoutMs },
    );
  } catch (err) {
    throw new Error(formatK3sErr("PATCH", path, err));
  }
}
