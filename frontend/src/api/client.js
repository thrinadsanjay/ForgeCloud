import axios from "axios";

const api = axios.create({ baseURL: "/api" });

// Attach JWT from localStorage on every request.
api.interceptors.request.use((config) => {
  const token = localStorage.getItem("forge_token") || localStorage.getItem("ssp_token");
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

// On 401, clear token and bounce to login.
api.interceptors.response.use(
  (r) => r,
  (err) => {
    if (err.response?.status === 401) {
      localStorage.removeItem("forge_token");
      localStorage.removeItem("ssp_token");
      if (!window.location.pathname.startsWith("/login")) {
        window.location.href = "/login";
      }
    }
    return Promise.reject(err);
  }
);

// --- Auth ---
export const login = (username, password) =>
  api.post("/auth/login", { username, password }).then((r) => r.data);
export const getOidcStatus = () => api.get("/auth/oidc/status").then((r) => r.data);
export const getOidcLoginUrl = () => api.get("/auth/oidc/login-url").then((r) => r.data);
export const oidcCallback = (code) => api.post("/auth/oidc/callback", { code }).then((r) => r.data);
/** @deprecated use getOidcStatus */
export const getEntraStatus = getOidcStatus;
/** @deprecated use getOidcLoginUrl */
export const getEntraLoginUrl = getOidcLoginUrl;
/** @deprecated use oidcCallback */
export const entraCallback = oidcCallback;
export const getMe = () => api.get("/auth/me").then((r) => r.data);
export const getMyPreferences = () => api.get("/auth/preferences").then((r) => r.data);
export const updateMyPreferences = (preferences) =>
  api.put("/auth/preferences", { preferences }).then((r) => r.data);

// --- Personal Access Tokens ---
export const listPats = () => api.get("/auth/pats").then((r) => r.data);
export const createPat = (p) => api.post("/auth/pats", p).then((r) => r.data);
export const revokePat = (id) => api.delete(`/auth/pats/${id}`).then((r) => r.data);

// --- Infrastructure-as-Code export ---
export const getIacTools = () => api.get("/catalog/iac/tools").then((r) => r.data);
export const getIacTemplate = ({ kind, id, tool }) =>
  api.get("/catalog/iac", { params: { kind, id, tool } }).then((r) => r.data);

// --- Catalog & provisioning ---
export const getVmTemplates = () => api.get("/catalog/vm-templates").then((r) => r.data);
export const getContainerTemplates = () => api.get("/catalog/container-templates").then((r) => r.data);
export const getStacks = () => api.get("/catalog/stacks").then((r) => r.data);
export const getPackages = () => api.get("/catalog/packages").then((r) => r.data);
export const getApps = () => api.get("/catalog/apps").then((r) => r.data);
export const previewApps = (apps) => api.post("/catalog/apps/preview", { apps }).then((r) => r.data);
export const syncAnsibleContent = () => api.post("/settings/ansible-content/sync").then((r) => r.data);
export const getAnsibleContentStatus = () => api.get("/settings/ansible-content").then((r) => r.data);
export const downloadAnsibleContentTemplate = async () => {
  const r = await api.get("/settings/ansible-content/template", { responseType: "blob" });
  const blob = r.data;
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "forge-ansible-content-template.tar.gz";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  return true;
};
export const getApplicationRoles = () => api.get("/catalog/application-roles").then((r) => r.data);
export const getInstanceSizes = () => api.get("/catalog/instance-sizes").then((r) => r.data);
export const getBaselines = () => api.get("/catalog/baselines").then((r) => r.data);
export const getTemplateDefaults = () => api.get("/catalog/template-defaults").then((r) => r.data);
export const getEnvironments = () => api.get("/catalog/environments").then((r) => r.data);
export const getCostRates = () => api.get("/catalog/cost-rates").then((r) => r.data);
export const provisionVm = (p) => api.post("/provision/vm", p).then((r) => r.data);
export const provisionInternal = (p) => api.post("/provision/internal", p).then((r) => r.data);
export const provisionContainer = (p) => api.post("/provision/container", p).then((r) => r.data);
export const provisionStack = (p) => api.post("/provision/stack", p).then((r) => r.data);
export const previewCapacity = (p) => api.post("/capacity/preview", p).then((r) => r.data);
export const getProvisionRequests = () => api.get("/requests").then((r) => r.data);
export const getRequestImpact = (id) => api.get(`/requests/${id}/impact`).then((r) => r.data);
export const approveProvisionRequest = (id) => api.post(`/requests/${id}/approve`).then((r) => r.data);
export const rejectProvisionRequest = (id, reason) =>
  api.post(`/requests/${id}/reject`, { reason }).then((r) => r.data);

// --- Jobs ---
export const getJob = (id) => api.get(`/jobs/${id}`).then((r) => r.data);
export const getJobs = () => api.get("/jobs").then((r) => r.data);
export const cancelJob = (id, reason) =>
  api.post(`/jobs/${id}/cancel`, reason ? { reason } : {}).then((r) => r.data);
export const rollbackJob = (id, reason) =>
  api.post(`/jobs/${id}/rollback`, reason ? { reason } : {}).then((r) => r.data);
export const retryJob = (id, reason) =>
  api.post(`/jobs/${id}/retry`, reason ? { reason } : {}).then((r) => r.data);
export const retryJobApps = (jobId, apps) =>
  api.post(`/jobs/${jobId}/retry-apps`, apps?.length ? { apps } : {}).then((r) => r.data);

// --- Quotas ---
export const getMyQuotas = () => api.get("/quotas/me").then((r) => r.data);
export const getMyUsage = () => api.get("/usage/me").then((r) => r.data);
export const getAdminUsage = () => api.get("/usage/admin").then((r) => r.data);
export const getTeamUsage = (name) =>
  api.get(`/usage/teams/${encodeURIComponent(name)}`).then((r) => r.data);

// --- Container hosting (K3s / Kubernetes) ---
export const getK8sContext = () => api.get("/k3s/context").then((r) => r.data);
export const getK8sNamespaces = () => api.get("/k3s/namespaces").then((r) => r.data);
export const createK8sNamespace = (p) => api.post("/k3s/namespaces", p).then((r) => r.data);
export const deleteK8sNamespace = (name, force = false) =>
  api.delete(`/k3s/namespaces/${encodeURIComponent(name)}${force ? "?force=true" : ""}`).then((r) => r.data);
export const getK8sPods = (ns) =>
  api.get(`/k3s/namespaces/${encodeURIComponent(ns)}/pods`).then((r) => r.data);
export const getK8sDeployments = (ns) =>
  api.get(`/k3s/namespaces/${encodeURIComponent(ns)}/deployments`).then((r) => r.data);
export const createK8sDeployment = (ns, p) =>
  api.post(`/k3s/namespaces/${encodeURIComponent(ns)}/deployments`, p).then((r) => r.data);
export const getK8sDeployment = (ns, name) =>
  api.get(`/k3s/namespaces/${encodeURIComponent(ns)}/deployments/${encodeURIComponent(name)}`).then((r) => r.data);
export const getK8sDeploymentStack = (ns, name) =>
  api.get(`/k3s/namespaces/${encodeURIComponent(ns)}/deployments/${encodeURIComponent(name)}/stack`).then((r) => r.data);
export const updateK8sDeployment = (ns, name, p) =>
  api.patch(`/k3s/namespaces/${encodeURIComponent(ns)}/deployments/${encodeURIComponent(name)}`, p).then((r) => r.data);
export const deleteK8sDeployment = (ns, name, { force = false } = {}) =>
  api.delete(`/k3s/namespaces/${encodeURIComponent(ns)}/deployments/${encodeURIComponent(name)}`, {
    params: { force: force ? "true" : "false" },
  }).then((r) => r.data);
export const deleteK8sPod = (ns, pod, { force = false } = {}) =>
  api.delete(`/k3s/namespaces/${encodeURIComponent(ns)}/pods/${encodeURIComponent(pod)}`, {
    params: { force: force ? "true" : "false" },
  }).then((r) => r.data);
export const getK8sServices = (ns) =>
  api.get(`/k3s/namespaces/${encodeURIComponent(ns)}/services`).then((r) => r.data);
export const deleteK8sService = (ns, name) =>
  api.delete(`/k3s/namespaces/${encodeURIComponent(ns)}/services/${encodeURIComponent(name)}`).then((r) => r.data);
export const getK8sIngresses = (ns) =>
  api.get(`/k3s/namespaces/${encodeURIComponent(ns)}/ingresses`).then((r) => r.data);
export const deleteK8sIngress = (ns, name) =>
  api.delete(`/k3s/namespaces/${encodeURIComponent(ns)}/ingresses/${encodeURIComponent(name)}`).then((r) => r.data);
export const getK8sPvcs = (ns) =>
  api.get(`/k3s/namespaces/${encodeURIComponent(ns)}/pvcs`).then((r) => r.data);
export const deleteK8sPvc = (ns, name) =>
  api.delete(`/k3s/namespaces/${encodeURIComponent(ns)}/pvcs/${encodeURIComponent(name)}`).then((r) => r.data);
export const applyK8sYaml = (ns, yaml) =>
  api.post(`/k3s/namespaces/${encodeURIComponent(ns)}/apply`, { yaml }).then((r) => r.data);
export const scaleK8sDeployment = (ns, name, replicas) =>
  api.post(`/k3s/namespaces/${encodeURIComponent(ns)}/deployments/${encodeURIComponent(name)}/scale`, { replicas }).then((r) => r.data);
export const restartK8sDeployment = (ns, name) =>
  api.post(`/k3s/namespaces/${encodeURIComponent(ns)}/deployments/${encodeURIComponent(name)}/restart`).then((r) => r.data);
export const getK8sPodLogs = (ns, pod, { tail, container } = {}) =>
  api.get(`/k3s/namespaces/${encodeURIComponent(ns)}/pods/${encodeURIComponent(pod)}/logs`, {
    params: { tail, container },
    responseType: "text",
    transformResponse: [(d) => d],
  }).then((r) => r.data);
export const execK8sPod = (ns, pod, { command, container } = {}) =>
  api.post(`/k3s/namespaces/${encodeURIComponent(ns)}/pods/${encodeURIComponent(pod)}/exec`, { command, container }).then((r) => r.data);

// --- Chat ---
export const sendChatMessage = (p) => api.post("/chat", p).then((r) => r.data);

/** SSE chat turn — progressive `delta` events, then a final `done` payload. */
export async function streamChatMessage(payload, { onStatus, onDelta, signal } = {}) {
  const token = localStorage.getItem("forge_token") || localStorage.getItem("ssp_token");
  const res = await fetch("/api/chat/stream", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(payload),
    signal,
  });

  if (res.status === 401) {
    localStorage.removeItem("forge_token");
    localStorage.removeItem("ssp_token");
    if (!window.location.pathname.startsWith("/login")) {
      window.location.href = "/login";
    }
    throw new Error("Session expired");
  }

  if (!res.ok) {
    let message = `Chat failed (${res.status})`;
    try {
      const j = await res.json();
      if (j?.error) message = j.error;
    } catch {
      /* ignore */
    }
    throw new Error(message);
  }

  const reader = res.body?.getReader();
  if (!reader) throw new Error("Streaming is not supported in this browser");

  const decoder = new TextDecoder();
  let buffer = "";
  let donePayload = null;
  let streamError = null;

  const handleBlock = (block) => {
    const lines = block.split(/\r?\n/);
    let event = "message";
    const dataLines = [];
    for (const line of lines) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
    }
    if (!dataLines.length) return;
    let data;
    try {
      data = JSON.parse(dataLines.join("\n"));
    } catch {
      return;
    }
    if (event === "status") onStatus?.(data);
    else if (event === "delta") onDelta?.(data);
    else if (event === "done") donePayload = data;
    else if (event === "error") streamError = data?.error || "Chat stream failed";
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let sep;
    while ((sep = buffer.search(/\r?\n\r?\n/)) >= 0) {
      const block = buffer.slice(0, sep);
      buffer = buffer.slice(sep).replace(/^\r?\n\r?\n/, "");
      if (block.trim()) handleBlock(block);
    }
  }
  if (buffer.trim()) handleBlock(buffer);

  if (streamError) throw new Error(streamError);
  if (!donePayload) throw new Error("Chat stream ended without a reply");
  return donePayload;
}

export const listChatSessions = () => api.get("/chat/sessions").then((r) => r.data);
export const createChatSession = (p = {}) => api.post("/chat/sessions", p).then((r) => r.data);
export const getChatSession = (id) => api.get(`/chat/sessions/${encodeURIComponent(id)}`).then((r) => r.data);
export const saveChatSession = (id, p) => api.put(`/chat/sessions/${encodeURIComponent(id)}`, p).then((r) => r.data);
export const deleteChatSession = (id) => api.delete(`/chat/sessions/${encodeURIComponent(id)}`).then((r) => r.data);
export const clearAllChatSessions = () => api.delete("/chat/sessions").then((r) => r.data);
// Legacy aliases
export const getChatHistory = () => api.get("/chat/history").then((r) => r.data);
export const saveChatHistory = (messages) => api.put("/chat/history", { messages }).then((r) => r.data);
export const clearChatHistory = () => api.delete("/chat/history").then((r) => r.data);

// --- Dashboard & resources ---
export const getDashboard = () => api.get("/dashboard").then((r) => r.data);
export const getResources = () => api.get("/resources").then((r) => r.data);
export const resourceAction = (type, vmid, action) =>
  api.post(`/resources/${type}/${vmid}/${action}`).then((r) => r.data);
export const editResource = (type, vmid, specs) =>
  api.put(`/resources/${type}/${vmid}/config`, specs).then((r) => r.data);
// Decide a resize: returns { status: "reboot_required" } for small changes, or
// { status: "pending_approval", requestId } when it exceeds the size policy.
export const resizeResource = (type, vmid, body) =>
  api.post(`/resources/${type}/${vmid}/resize`, body).then((r) => r.data);
// Owner/admin confirms the reboot after an approved resize was applied.
export const confirmResizeReboot = (requestId) =>
  api.post(`/requests/${requestId}/confirm-reboot`).then((r) => r.data);
export const extendResource = (type, vmid, days, opts = {}) =>
  api.post(`/resources/${type}/${vmid}/extend`, {
    ...(days != null ? { days } : {}),
    ...opts,
  }).then((r) => r.data);
export const getExpiringResources = (withinDays = 7) =>
  api.get("/notifications/expiring", { params: { withinDays } }).then((r) => r.data);

// --- Notifications (bell) ---
export const getNotifications = (params = {}) =>
  api.get("/notifications/inbox", { params }).then((r) => r.data);
export const markNotificationRead = (id) => api.post(`/notifications/${id}/read`).then((r) => r.data);
export const markNotificationsReadMany = (ids) =>
  api.post("/notifications/read-many", { ids }).then((r) => r.data);
export const markAllNotificationsRead = ({ category = "all" } = {}) =>
  api.post("/notifications/read-all", { category }).then((r) => r.data);
export const dismissNotification = (id) =>
  api.delete(`/notifications/${encodeURIComponent(id)}`).then((r) => r.data);

// --- Snapshots & backups ---
export const getSnapshots = (type, vmid) =>
  api.get(`/resources/${type}/${vmid}/snapshots`).then((r) => r.data);
export const createSnapshot = (type, vmid, body) =>
  api.post(`/resources/${type}/${vmid}/snapshots`, body).then((r) => r.data);
export const rollbackSnapshot = (type, vmid, snap) =>
  api.post(`/resources/${type}/${vmid}/snapshots/${encodeURIComponent(snap)}/rollback`).then((r) => r.data);
export const deleteSnapshot = (type, vmid, snap) =>
  api.delete(`/resources/${type}/${vmid}/snapshots/${encodeURIComponent(snap)}`).then((r) => r.data);
export const getBackupConfig = (type, vmid) =>
  api.get(`/resources/${type}/${vmid}/backup`).then((r) => r.data);
export const saveBackupConfig = (type, vmid, cfg) =>
  api.post(`/resources/${type}/${vmid}/backup`, cfg).then((r) => r.data);
export const deleteBackupConfig = (type, vmid) =>
  api.delete(`/resources/${type}/${vmid}/backup`).then((r) => r.data);
export const runBackupNow = (type, vmid, cfg) =>
  api.post(`/resources/${type}/${vmid}/backup/run`, cfg).then((r) => r.data);

// --- Tags ---
export const setResourceTags = (type, vmid, tags) =>
  api.put(`/resources/${type}/${vmid}/tags`, { tags }).then((r) => r.data);
export const autoTagResource = (type, vmid, name) =>
  api.post(`/resources/${type}/${vmid}/autotag`, name ? { name } : {}).then((r) => r.data);

// --- Admin: mappings (templates + networks) ---
export const getMappings = () => api.get("/mappings").then((r) => r.data);
export const saveTemplateMapping = (vmid, mapping) =>
  api.put(`/mappings/templates/${vmid}`, mapping).then((r) => r.data);
export const deleteTemplateMapping = (vmid) =>
  api.delete(`/mappings/templates/${vmid}`).then((r) => r.data);
export const saveNetworkMapping = (iface, mapping) =>
  api.put(`/mappings/networks/${encodeURIComponent(iface)}`, mapping).then((r) => r.data);
export const deleteNetworkMapping = (iface) =>
  api.delete(`/mappings/networks/${encodeURIComponent(iface)}`).then((r) => r.data);

// --- Admin: system settings (.env config) ---
export const getSettings = () => api.get("/settings").then((r) => r.data);
export const updateSettings = (values) => api.put("/settings", { values }).then((r) => r.data);
export const testProxmoxConnection = (opts = {}) =>
  api.post("/settings/proxmox/test", opts, {
    params: opts.light ? { light: "1" } : {},
    timeout: 8000,
  }).then((r) => r.data);
export const testK3sConnection = () => api.post("/settings/k3s/test", {}, { timeout: 8000 }).then((r) => r.data);

/** User-facing reachability probes (any authenticated user). */
export const getProxmoxStatus = () =>
  api.get("/infra/status/proxmox", { timeout: 10000 }).then((r) => r.data);
export const getK3sStatus = () =>
  api.get("/infra/status/k3s", { timeout: 10000 }).then((r) => r.data);
export const getDockerStatus = () =>
  api.get("/infra/status/docker", { timeout: 20000 }).then((r) => r.data);
export const testServiceNowConnection = () => api.post("/settings/servicenow/test", {}, { timeout: 8000 }).then((r) => r.data);
export const testN8nWebhook = () => api.post("/settings/n8n/test", {}, { timeout: 8000 }).then((r) => r.data);
export const testIpamConnection = () => api.post("/settings/ipam/test", {}, { timeout: 8000 }).then((r) => r.data);
export const testAiConnection = () => api.post("/settings/ai/test", {}, { timeout: 12000 }).then((r) => r.data);

// --- Docker Compose (remote Engines) ---
export const listDockerHostsAdmin = () => api.get("/admin/docker-hosts").then((r) => r.data);
export const createDockerHostAdmin = (p) => api.post("/admin/docker-hosts", p).then((r) => r.data);
export const updateDockerHostAdmin = (id, p) => api.patch(`/admin/docker-hosts/${id}`, p).then((r) => r.data);
export const deleteDockerHostAdmin = (id) => api.delete(`/admin/docker-hosts/${id}`).then((r) => r.data);
export const testDockerHostFormAdmin = (p) =>
  api.post("/admin/docker-hosts/test", p, { timeout: 12000 }).then((r) => r.data);
export const testDockerHostAdmin = (id) =>
  api.post(`/admin/docker-hosts/${id}/test`, {}, { timeout: 12000 }).then((r) => r.data);
export const listDockerHosts = () => api.get("/docker/hosts").then((r) => r.data);
export const deployCompose = (p) => api.post("/docker/compose/deploy", p).then((r) => r.data);
export const listDockerProjects = () => api.get("/docker/projects").then((r) => r.data);
export const downDockerProject = (hostId, project) =>
  api.post(`/docker/projects/${encodeURIComponent(hostId)}/${encodeURIComponent(project)}/down`).then((r) => r.data);
export const restartDockerProject = (hostId, project) =>
  api.post(`/docker/projects/${encodeURIComponent(hostId)}/${encodeURIComponent(project)}/restart`).then((r) => r.data);
export const startDockerContainer = (hostId, id) =>
  api.post(`/docker/containers/${encodeURIComponent(hostId)}/${encodeURIComponent(id)}/start`).then((r) => r.data);
export const stopDockerContainer = (hostId, id) =>
  api.post(`/docker/containers/${encodeURIComponent(hostId)}/${encodeURIComponent(id)}/stop`).then((r) => r.data);
export const restartDockerContainer = (hostId, id) =>
  api.post(`/docker/containers/${encodeURIComponent(hostId)}/${encodeURIComponent(id)}/restart`).then((r) => r.data);
export const deleteDockerContainer = (hostId, id) =>
  api.delete(`/docker/containers/${encodeURIComponent(hostId)}/${encodeURIComponent(id)}`).then((r) => r.data);
export const inspectDockerContainer = (hostId, id) =>
  api.get(`/docker/containers/${encodeURIComponent(hostId)}/${encodeURIComponent(id)}/inspect`).then((r) => r.data);
export const updateDockerContainerEnv = (hostId, id, env) =>
  api.put(`/docker/containers/${encodeURIComponent(hostId)}/${encodeURIComponent(id)}/env`, { env }).then((r) => r.data);
export const getDockerContainerLogs = (hostId, id, { tail } = {}) =>
  api.get(`/docker/containers/${encodeURIComponent(hostId)}/${encodeURIComponent(id)}/logs`, {
    params: { tail },
    responseType: "text",
    transformResponse: [(d) => d],
  }).then((r) => r.data);
export const getDockerContainerHealth = (hostId, id) =>
  api.get(`/docker/containers/${encodeURIComponent(hostId)}/${encodeURIComponent(id)}/health`).then((r) => r.data);

export const getK8sDeploymentEnv = (ns, dep) =>
  api.get(`/k3s/namespaces/${encodeURIComponent(ns)}/deployments/${encodeURIComponent(dep)}/env`).then((r) => r.data);
export const updateK8sDeploymentEnv = (ns, dep, { container, env } = {}) =>
  api.put(`/k3s/namespaces/${encodeURIComponent(ns)}/deployments/${encodeURIComponent(dep)}/env`, { container, env }).then((r) => r.data);

// --- Admin: users & audit ---
export const getUsers = () => api.get("/users").then((r) => r.data);
export const createUser = (p) => api.post("/users", p).then((r) => r.data);
export const updateUserRole = (id, role) => api.put(`/users/${id}/role`, { role }).then((r) => r.data);
export const deleteUser = (id) => api.delete(`/users/${id}`).then((r) => r.data);
export const getAudit = (params) => api.get("/audit", { params }).then((r) => r.data);

// --- Admin: groups ---
export const getGroups = () => api.get("/groups").then((r) => r.data);
export const createGroup = (name) => api.post("/groups", { name }).then((r) => r.data);
export const deleteGroup = (name) => api.delete(`/groups/${encodeURIComponent(name)}`).then((r) => r.data);
export const setGroupQuotas = (name, quotas) =>
  api.put(`/groups/${encodeURIComponent(name)}/quotas`, quotas).then((r) => r.data);
export const addGroupMember = (name, username) =>
  api.post(`/groups/${encodeURIComponent(name)}/members`, { username }).then((r) => r.data);
export const removeGroupMember = (name, username) =>
  api.delete(`/groups/${encodeURIComponent(name)}/members/${encodeURIComponent(username)}`).then((r) => r.data);

// --- Admin: catalog (packages, baselines, workflows) ---
export const adminListPackages = () => api.get("/admin/packages").then((r) => r.data);
export const adminUpsertPackage = (data) => api.post("/admin/packages", data).then((r) => r.data);
export const adminDeletePackage = (id) => api.delete(`/admin/packages/${encodeURIComponent(id)}`).then((r) => r.data);
export const adminGetCatalogValidation = () => api.get("/admin/catalog/validation").then((r) => r.data);
export const adminListApplicationRoles = () => api.get("/admin/application-roles").then((r) => r.data);
export const adminUpsertApplicationRole = (data) => api.post("/admin/application-roles", data).then((r) => r.data);
export const adminDeleteApplicationRole = (id) =>
  api.delete(`/admin/application-roles/${encodeURIComponent(id)}`).then((r) => r.data);
export const adminListAppBlueprints = () => api.get("/admin/app-blueprints").then((r) => r.data);
export const adminUpsertAppBlueprint = (data) => api.post("/admin/app-blueprints", data).then((r) => r.data);
export const adminDeleteAppBlueprint = (id) =>
  api.delete(`/admin/app-blueprints/${encodeURIComponent(id)}`).then((r) => r.data);
export const adminListBaselines = () => api.get("/admin/baselines").then((r) => r.data);
export const adminUpsertBaseline = (data) => api.post("/admin/baselines", data).then((r) => r.data);
export const adminDeleteBaseline = (id) => api.delete(`/admin/baselines/${encodeURIComponent(id)}`).then((r) => r.data);
export const adminListWorkflows = () => api.get("/admin/workflows").then((r) => r.data);
export const adminUpsertWorkflow = (data) => api.post("/admin/workflows", data).then((r) => r.data);
export const adminDeleteWorkflow = (id) => api.delete(`/admin/workflows/${encodeURIComponent(id)}`).then((r) => r.data);
export const adminListInstanceSizes = () => api.get("/admin/instance-sizes").then((r) => r.data);
export const adminUpsertInstanceSize = (data) => api.post("/admin/instance-sizes", data).then((r) => r.data);
export const adminDeleteInstanceSize = (key) => api.delete(`/admin/instance-sizes/${encodeURIComponent(key)}`).then((r) => r.data);
export const adminGetHostnameFormat = () => api.get("/admin/hostname-format").then((r) => r.data);
export const adminSetHostnameFormat = (formatOrBody, applications) => {
  const body = typeof formatOrBody === "string"
    ? { format: formatOrBody, ...(applications != null ? { applications } : {}) }
    : (formatOrBody || {});
  return api.put("/admin/hostname-format", body).then((r) => r.data);
};
export const adminPreviewHostnameFormat = (body) => api.post("/admin/hostname-format/preview", body).then((r) => r.data);
export const adminSyncHostnameFromRoles = () => api.post("/admin/hostname-format/sync-roles").then((r) => r.data);
export const getHostnameFormat = () => api.get("/catalog/hostname-format").then((r) => r.data);
export const suggestHostname = (body) => api.post("/catalog/hostname-suggest", body).then((r) => r.data);
export const getChatAnalytics = () => api.get("/admin/chat-analytics").then((r) => r.data);

export default api;
