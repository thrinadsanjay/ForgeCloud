import axios from "axios";
import https from "https";

// K3s / Kubernetes API config is read from process.env at call time so changes
// saved in the admin Settings tab take effect without a restart.
function k3sConfig() {
  return {
    url: (process.env.K3S_API_URL || "").replace(/\/+$/, ""),
    token: process.env.K3S_API_TOKEN,
    verifyTls: process.env.K3S_VERIFY_TLS === "true",
  };
}

let client = null;
let clientSig = null;

function ensureClient() {
  const cfg = k3sConfig();
  const sig = `${cfg.url}:${cfg.verifyTls}`;
  if (!client || sig !== clientSig) {
    client = axios.create({
      baseURL: cfg.url,
      httpsAgent: new https.Agent({ rejectUnauthorized: cfg.verifyTls }),
    });
    clientSig = sig;
  }
  return client;
}

// Authenticated request against the cluster API using the bearer token.
async function request(method, path, body = null) {
  const cfg = k3sConfig();
  if (!cfg.url) throw new Error("K3s API URL is not configured");
  if (!cfg.token) throw new Error("K3s API token is not configured");
  try {
    const res = await ensureClient().request({
      method,
      url: path,
      data: body,
      headers: {
        Authorization: `Bearer ${cfg.token}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
    });
    return res.data;
  } catch (err) {
    const detail = err.response?.data?.message || err.response?.data || err.message;
    throw new Error(`K3s API error [${method.toUpperCase()} ${path}]: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
  }
}

// GET helper (kept for the Settings connectivity test).
export const k3sRequest = (path) => request("get", path);

// Lightweight connectivity check for the admin Settings tab. Reads /version.
export async function testConnection() {
  const v = await k3sRequest("/version");
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
