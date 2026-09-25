import { useEffect, useMemo, useRef, useState } from "react";
import yaml from "js-yaml";
import { applyK8sYaml, getK8sDeploymentStack } from "../api/client.js";
import { useToast } from "./ToastProvider.jsx";

const NAV = [
  { id: "workload", label: "Workload", hint: "Image & pods", tone: "work" },
  { id: "networking", label: "Networking", hint: "Service & route", tone: "net" },
  { id: "storage", label: "Storage", hint: "Volumes", tone: "store" },
  { id: "labels", label: "Labels & env", hint: "Metadata", tone: "meta" },
  { id: "resources", label: "Resources", hint: "CPU / memory", tone: "res" },
  { id: "yaml", label: "YAML", hint: "Edit manifest", tone: "yaml" },
];

function parseKvLines(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const eq = line.indexOf("=");
      if (eq <= 0) return null;
      return { key: line.slice(0, eq).trim(), value: line.slice(eq + 1) };
    })
    .filter(Boolean);
}

function labelsObject(text) {
  const out = {};
  for (const { key, value } of parseKvLines(text)) out[key] = value;
  return out;
}

function yamlQuote(s) {
  const v = String(s ?? "");
  if (v === "") return '""';
  if (/[:#{}[\],&*?|>!%@`'"]/.test(v) || /\s/.test(v)) {
    return JSON.stringify(v);
  }
  return v;
}

/** Build multi-doc YAML from the guided form (client-side preview / edit). */
export function buildStackYaml(namespace, form) {
  const name = String(form.name || "").trim().toLowerCase();
  const image = String(form.image || "").trim();
  const replicas = Number(form.replicas) || 1;
  const port = form.port ? Number(form.port) : null;
  const labels = { app: name, ...labelsObject(form.labelsText) };
  const env = parseKvLines(form.envText);
  const docs = [];

  if (form.pvcSizeGi) {
    docs.push(`apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: ${name}-data
  namespace: ${namespace}
  labels:
${Object.entries(labels).map(([k, v]) => `    ${k}: ${yamlQuote(v)}`).join("\n")}
spec:
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: ${Number(form.pvcSizeGi)}Gi`);
  }

  const labelBlock = Object.entries(labels).map(([k, v]) => `      ${k}: ${yamlQuote(v)}`).join("\n");
  const envBlock = env.length
    ? `        env:\n${env.map(({ key, value }) => `          - name: ${key}\n            value: ${yamlQuote(value)}`).join("\n")}`
    : "";
  const portBlock = port ? `        ports:\n          - containerPort: ${port}` : "";
  const volMount = form.pvcSizeGi
    ? `        volumeMounts:\n          - name: data\n            mountPath: ${yamlQuote(form.pvcMountPath || "/data")}`
    : "";
  const volumes = form.pvcSizeGi
    ? `      volumes:\n        - name: data\n          persistentVolumeClaim:\n            claimName: ${name}-data`
    : "";
  const resLines = [];
  if (form.cpuRequest || form.memoryRequest || form.cpuLimit || form.memoryLimit) {
    resLines.push("        resources:");
    if (form.cpuRequest || form.memoryRequest) {
      resLines.push("          requests:");
      if (form.cpuRequest) resLines.push(`            cpu: ${yamlQuote(form.cpuRequest)}`);
      if (form.memoryRequest) resLines.push(`            memory: ${yamlQuote(form.memoryRequest)}`);
    }
    if (form.cpuLimit || form.memoryLimit) {
      resLines.push("          limits:");
      if (form.cpuLimit) resLines.push(`            cpu: ${yamlQuote(form.cpuLimit)}`);
      if (form.memoryLimit) resLines.push(`            memory: ${yamlQuote(form.memoryLimit)}`);
    }
  }

  const cmd = String(form.command || "").trim();
  const argList = String(form.args || "").split(/\r?\n|,/).map((s) => s.trim()).filter(Boolean);
  const cmdBlock = cmd
    ? `        command: [${cmd.split(/\s+/).filter(Boolean).map((c) => yamlQuote(c)).join(", ")}]`
    : "";
  const argsBlock = argList.length
    ? `        args:\n${argList.map((a) => `          - ${yamlQuote(a)}`).join("\n")}`
    : "";
  const probe = String(form.probePath || "").trim();
  const probeBlock = probe && port
    ? `        readinessProbe:
          httpGet:
            path: ${yamlQuote(probe)}
            port: ${port}
          initialDelaySeconds: 5
          periodSeconds: 10
        livenessProbe:
          httpGet:
            path: ${yamlQuote(probe)}
            port: ${port}
          initialDelaySeconds: 15
          periodSeconds: 20`
    : "";

  docs.push(`apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${name}
  namespace: ${namespace}
  labels:
${Object.entries(labels).map(([k, v]) => `    ${k}: ${yamlQuote(v)}`).join("\n")}
spec:
  replicas: ${replicas}
  selector:
    matchLabels:
      app: ${name}
  template:
    metadata:
      labels:
${labelBlock}
    spec:
      containers:
        - name: ${name}
          image: ${yamlQuote(image)}
          imagePullPolicy: ${form.imagePullPolicy || "IfNotPresent"}
${portBlock}
${cmdBlock}
${argsBlock}
${envBlock}
${resLines.join("\n")}
${probeBlock}
${volMount}
${volumes}`);

  if (form.createService && port) {
    docs.push(`apiVersion: v1
kind: Service
metadata:
  name: ${name}
  namespace: ${namespace}
  labels:
${Object.entries(labels).map(([k, v]) => `    ${k}: ${yamlQuote(v)}`).join("\n")}
spec:
  type: ${form.serviceType || "ClusterIP"}
  selector:
    app: ${name}
  ports:
    - name: http
      port: ${port}
      targetPort: ${port}
      protocol: TCP`);
  }

  if (form.createService && port && String(form.ingressHost || "").trim()) {
    const host = String(form.ingressHost).trim();
    const path = String(form.ingressPath || "/").trim() || "/";
    docs.push(`apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: ${name}
  namespace: ${namespace}
  labels:
${Object.entries(labels).map(([k, v]) => `    ${k}: ${yamlQuote(v)}`).join("\n")}
  annotations:
    traefik.ingress.kubernetes.io/router.entrypoints: web
    traefik.ingress.kubernetes.io/service.nativelb: "true"
spec:
  ingressClassName: traefik
  rules:
    - host: ${yamlQuote(host)}
      http:
        paths:
          - path: ${yamlQuote(path)}
            pathType: Prefix
            backend:
              service:
                name: ${name}
                port:
                  number: ${port}`);
  }

  return docs.filter(Boolean).join("\n---\n");
}

function asList(v) {
  if (Array.isArray(v)) return v.map(String);
  if (v == null || v === "") return [];
  return [String(v)];
}

function storageToGi(storage) {
  const s = String(storage || "").trim();
  const gi = s.match(/^(\d+(?:\.\d+)?)\s*Gi$/i);
  if (gi) return String(Math.max(1, Math.round(Number(gi[1]))));
  const mi = s.match(/^(\d+(?:\.\d+)?)\s*Mi$/i);
  if (mi) return String(Math.max(1, Math.round(Number(mi[1]) / 1024)));
  const n = s.match(/^(\d+)/);
  return n ? n[1] : "";
}

/**
 * Parse pasted multi-doc Kubernetes YAML into guided-form fields.
 * Best-effort: unknown docs are ignored; Deployment is required for a result.
 */
export function formFromStackYaml(text) {
  const docs = [];
  try {
    yaml.loadAll(String(text || ""), (doc) => {
      if (doc && typeof doc === "object") docs.push(doc);
    });
  } catch {
    return null;
  }
  const dep = docs.find((d) => d.kind === "Deployment");
  if (!dep) return null;

  const primary = dep.spec?.template?.spec?.containers?.[0] || {};
  const resources = primary.resources || {};
  const labels = { ...(dep.metadata?.labels || {}) };
  delete labels.app;
  const svc = docs.find((d) => d.kind === "Service");
  const ing = docs.find((d) => d.kind === "Ingress");
  const pvc = docs.find((d) => d.kind === "PersistentVolumeClaim");

  const form = {
    name: String(dep.metadata?.name || "").toLowerCase(),
    image: primary.image || "",
    replicas: dep.spec?.replicas ?? 1,
    port: primary.ports?.[0]?.containerPort != null ? String(primary.ports[0].containerPort) : "",
    imagePullPolicy: primary.imagePullPolicy || "IfNotPresent",
    command: asList(primary.command).join(" "),
    args: asList(primary.args).join("\n"),
    probePath:
      primary.readinessProbe?.httpGet?.path
      || primary.livenessProbe?.httpGet?.path
      || "",
    createService: !!svc,
    serviceType: svc?.spec?.type || "ClusterIP",
    ingressHost: "",
    ingressPath: "/",
    pvcSizeGi: "",
    pvcMountPath: "/data",
    labelsText: Object.entries(labels).map(([k, v]) => `${k}=${v}`).join("\n"),
    envText: (primary.env || [])
      .filter((e) => e && e.name && e.value != null && !e.valueFrom)
      .map((e) => `${e.name}=${e.value}`)
      .join("\n"),
    cpuRequest: resources.requests?.cpu || "",
    memoryRequest: resources.requests?.memory || "",
    cpuLimit: resources.limits?.cpu || "",
    memoryLimit: resources.limits?.memory || "",
  };

  if (!form.port && svc?.spec?.ports?.[0]) {
    form.port = String(svc.spec.ports[0].targetPort || svc.spec.ports[0].port || "");
  }

  if (ing) {
    const rule = (ing.spec?.rules || [])[0] || {};
    const path = (rule.http?.paths || [])[0] || {};
    form.ingressHost = rule.host || "";
    form.ingressPath = path.path || "/";
    form.createService = true;
  }

  if (pvc) {
    const storage = pvc.spec?.resources?.requests?.storage || pvc.status?.capacity?.storage || "";
    form.pvcSizeGi = storageToGi(storage);
    const mount = (primary.volumeMounts || []).find((m) => m.name === "data")
      || (primary.volumeMounts || [])[0];
    if (mount?.mountPath) form.pvcMountPath = mount.mountPath;
  }

  return form;
}

const DEFAULT_FORM = {
  name: "",
  image: "nginx:latest",
  replicas: 1,
  port: "80",
  imagePullPolicy: "IfNotPresent",
  command: "",
  args: "",
  probePath: "",
  createService: true,
  serviceType: "ClusterIP",
  ingressHost: "",
  ingressPath: "/",
  pvcSizeGi: "",
  pvcMountPath: "/data",
  labelsText: "app.kubernetes.io/managed-by=forge",
  envText: "",
  cpuRequest: "100m",
  memoryRequest: "128Mi",
  cpuLimit: "500m",
  memoryLimit: "512Mi",
};

function StackChips({ form }) {
  const port = form.port ? Number(form.port) : null;
  const chips = [
    { id: "dep", label: "Deployment", on: !!form.name.trim() && !!form.image.trim(), detail: form.name || "—" },
    { id: "svc", label: "Service", on: !!form.createService && !!port, detail: form.createService ? (form.serviceType || "ClusterIP") : "off" },
    { id: "ing", label: "Ingress", on: !!form.createService && !!port && !!String(form.ingressHost || "").trim(), detail: form.ingressHost || "off" },
    { id: "pvc", label: "PVC", on: !!form.pvcSizeGi, detail: form.pvcSizeGi ? `${form.pvcSizeGi} Gi` : "off" },
  ];
  return (
    <div className="ki-stack-chips" aria-label="Objects that will be created">
      {chips.map((c) => (
        <span key={c.id} className={`ki-stack-chip ${c.on ? "on" : "off"}`}>
          <span className="ki-stack-chip-dot" />
          <span className="ki-stack-chip-label">{c.label}</span>
          <span className="ki-stack-chip-detail mono">{c.detail}</span>
        </span>
      ))}
    </div>
  );
}

function loadYamlDocs(text) {
  const docs = [];
  try {
    yaml.loadAll(String(text || ""), (doc) => {
      if (doc && typeof doc === "object") docs.push(doc);
    });
  } catch (e) {
    throw new Error(`YAML parse failed: ${e.message}`);
  }
  return docs;
}

export default function K8sDeployPanel({ namespace, editName = null, onClose, onDeployed }) {
  const isEdit = !!editName;
  const { error: toastError, success: toastSuccess } = useToast();
  const errorRef = useRef(null);
  const mainRef = useRef(null);
  const [tab, setTab] = useState("workload");
  const [form, setForm] = useState({ ...DEFAULT_FORM });
  const [yaml, setYaml] = useState("");
  const [yamlDirty, setYamlDirty] = useState(false);
  const [mode, setMode] = useState("guided");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(isEdit);
  const [error, setError] = useState("");
  const [yamlParseNote, setYamlParseNote] = useState("");

  const showError = (msg, { goYaml = false } = {}) => {
    const text = String(msg || "Something went wrong");
    setError(text);
    setYamlParseNote("");
    if (goYaml) setTab("yaml");
    toastError(goYaml ? "YAML apply failed" : "Deploy failed", text);
  };

  useEffect(() => {
    if (!error) return;
    const t = window.setTimeout(() => {
      if (mainRef.current) mainRef.current.scrollTop = 0;
      errorRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }, 50);
    return () => window.clearTimeout(t);
  }, [error, tab]);

  useEffect(() => {
    if (!editName) return undefined;
    let cancelled = false;
    setLoading(true);
    setError("");
    getK8sDeploymentStack(namespace, editName)
      .then((data) => {
        if (cancelled) return;
        const next = { ...DEFAULT_FORM, ...(data?.form || {}), name: editName };
        setForm(next);
        setYamlDirty(false);
        setMode("guided");
      })
      .catch((e) => {
        if (!cancelled) showError(e.response?.data?.error || e.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [namespace, editName]);

  const generated = useMemo(() => {
    if (!form.name.trim() || !form.image.trim()) {
      return "# Fill workload name and image to preview YAML\n";
    }
    try {
      return buildStackYaml(namespace, form);
    } catch (e) {
      return `# YAML preview error: ${e.message}\n`;
    }
  }, [namespace, form]);

  useEffect(() => {
    if (!yamlDirty) setYaml(generated);
  }, [generated, yamlDirty]);

  const upd = (k) => (e) => {
    const v = e?.target?.type === "checkbox" ? e.target.checked : e.target.value;
    setForm((f) => ({ ...f, [k]: v }));
    setYamlDirty(false);
    setMode("guided");
    setYamlParseNote("");
    setError("");
  };

  const resetYamlFromForm = () => {
    setYaml(generated);
    setYamlDirty(false);
    setMode("guided");
    setYamlParseNote("");
  };

  const onYamlChange = (text) => {
    setYaml(text);
    setYamlDirty(true);
    setMode("yaml");
    setError("");
    const parsed = formFromStackYaml(text);
    if (!parsed) {
      setYamlParseNote("Could not parse YAML into the form yet — fix syntax or keep editing.");
      return;
    }
    setForm((prev) => ({
      ...DEFAULT_FORM,
      ...parsed,
      // Keep immutable name while editing an existing workload.
      name: isEdit ? prev.name : (parsed.name || prev.name),
    }));
    setYamlParseNote("Form fields updated from YAML.");
  };

  const submit = async (e) => {
    e?.preventDefault?.();
    setBusy(true);
    setError("");
    setYamlParseNote("");
    const usedYaml = isEdit || mode === "yaml" || yamlDirty;
    const manifest = usedYaml ? (yamlDirty ? yaml : generated) : generated;

    window.dispatchEvent(new CustomEvent("forge:pause-resource-watch", { detail: { ms: 120_000 } }));

    try {
      if (!manifest.trim()) throw new Error(usedYaml ? "YAML is empty" : "Fill workload name and image first");

      const docs = loadYamlDocs(manifest);
      if (!docs.length) throw new Error("No YAML documents found");

      // One job for the full multi-doc stack — progress shows in the shared deployment monitor.
      const result = await applyK8sYaml(namespace, manifest);
      if (result?.job?.id) {
        toastSuccess(
          usedYaml ? "YAML apply started" : "Stack deploy started",
          `Applying ${docs.length} object${docs.length === 1 ? "" : "s"} in ${namespace} — watch the deployment monitor.`,
        );
        window.dispatchEvent(new CustomEvent("forge:open-deployment-monitor", { detail: { jobId: result.job.id } }));
        onDeployed?.();
        onClose?.();
      } else {
        toastSuccess(usedYaml ? "YAML applied" : "Stack deployed", `Applied in ${namespace}.`);
        onDeployed?.();
        onClose?.();
      }
    } catch (err) {
      showError(err.response?.data?.error || err.message, { goYaml: usedYaml });
    } finally {
      setBusy(false);
    }
  };

  const activeNav = NAV.find((n) => n.id === tab) || NAV[0];
  const primaryLabel = isEdit
    ? (yamlDirty || mode === "yaml" ? "Apply YAML" : "Save changes")
    : (yamlDirty || mode === "yaml" ? "Apply YAML" : "Deploy stack");

  return (
    <div className="modal-overlay ki-panel-overlay" onClick={onClose}>
      <div className="ki-deploy-panel" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <header className="ki-panel-header">
          <div className="ki-panel-titleblock">
            <div className="ki-panel-kicker">
              Kubernetes · {isEdit ? "Edit stack" : "Deploy stack"}
            </div>
            <h3>
              {isEdit ? "Edit workload in" : "Build a workload in"}{" "}
              <span className="ki-ns-pill mono">{namespace}</span>
            </h3>
            <StackChips form={form} />
          </div>
          <div className="ki-panel-header-meta">
            <span className={`ki-mode-pill ${yamlDirty ? "yaml" : "guided"}`}>
              {yamlDirty ? "YAML mode" : "Guided form"}
            </span>
            <button type="button" className="ds-close" onClick={onClose} aria-label="Close">×</button>
          </div>
        </header>

        <div className="ki-panel-body">
          <aside className="ki-panel-nav" aria-label="Deploy sections">
            <div className="ki-nav-heading">Configure</div>
            <div className="ki-nav-list">
              {NAV.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={`ki-nav-item tone-${item.tone} ${tab === item.id ? "is-active" : ""}`}
                  onClick={() => {
                    setTab(item.id);
                    if (item.id === "yaml") setMode(yamlDirty ? "yaml" : "guided");
                  }}
                >
                  <span className="ki-nav-bar" aria-hidden />
                  <span className="ki-nav-copy">
                    <span className="ki-nav-label">{item.label}</span>
                    <span className="ki-nav-hint">{item.hint}</span>
                  </span>
                </button>
              ))}
            </div>
          </aside>

          <div
            className={`ki-panel-main ${tab === "yaml" ? "is-yaml" : ""}`}
            ref={mainRef}
          >
            {error && (
              <div ref={errorRef} className="login-error ki-apply-error ki-apply-error-sticky" role="alert">
                <strong>{tab === "yaml" || yamlDirty ? "YAML apply failed" : "Deploy failed"}</strong>
                <pre className="ki-apply-error-detail">{error}</pre>
              </div>
            )}
            {loading && <p className="muted">Loading deployment…</p>}

            {!loading && (
              <>
            {tab !== "yaml" && (
              <div className="ki-section-banner">
                <strong>{activeNav.label}</strong>
                <span className="muted">{activeNav.hint}</span>
              </div>
            )}

            {tab === "workload" && (
              <section className="ki-panel-section">
                <div className="ki-field-grid-2">
                  <div className="field">
                    <label>Workload name</label>
                    <input
                      className="ch-input"
                      required
                      placeholder="web"
                      value={form.name}
                      onChange={upd("name")}
                      readOnly={isEdit}
                      title={isEdit ? "Name is fixed when editing" : undefined}
                    />
                  </div>
                  <div className="field">
                    <label>Replicas</label>
                    <input className="ch-input" type="number" min="0" max="50" value={form.replicas} onChange={upd("replicas")} />
                  </div>
                </div>
                <div className="field">
                  <label>Container image</label>
                  <input className="ch-input" required placeholder="nginx:latest" value={form.image} onChange={upd("image")} />
                </div>
                <div className="ki-field-grid-2">
                  <div className="field">
                    <label>Container port</label>
                    <input className="ch-input" type="number" min="1" max="65535" value={form.port} onChange={upd("port")} />
                  </div>
                  <div className="field">
                    <label>Image pull policy</label>
                    <select className="ch-input" value={form.imagePullPolicy} onChange={upd("imagePullPolicy")}>
                      <option value="IfNotPresent">IfNotPresent</option>
                      <option value="Always">Always</option>
                      <option value="Never">Never</option>
                    </select>
                  </div>
                </div>
                <div className="ki-field-grid-2">
                  <div className="field">
                    <label>HTTP probe path <span className="muted">(optional)</span></label>
                    <input className="ch-input" placeholder="/healthz" value={form.probePath} onChange={upd("probePath")} />
                  </div>
                  <div className="field">
                    <label>Command <span className="muted">(optional)</span></label>
                    <input className="ch-input mono" placeholder="nginx -g 'daemon off;'" value={form.command} onChange={upd("command")} />
                  </div>
                </div>
                <div className="field">
                  <label>Args <span className="muted">(optional, one per line)</span></label>
                  <textarea className="ch-input mono ki-code-area" rows={3} value={form.args} onChange={upd("args")} placeholder={"--flag\nvalue"} spellCheck={false} />
                </div>
              </section>
            )}

            {tab === "networking" && (
              <section className="ki-panel-section">
                <label className={`ki-toggle-card ${form.createService ? "on" : ""}`}>
                  <input type="checkbox" checked={!!form.createService} onChange={upd("createService")} />
                  <span>
                    <strong>Expose with a Service</strong>
                    <small>Required for Ingress / NodePort / LoadBalancer access</small>
                  </span>
                </label>
                <div className="ki-field-grid-2">
                  <div className="field">
                    <label>Service type</label>
                    <select className="ch-input" value={form.serviceType} onChange={upd("serviceType")} disabled={!form.createService}>
                      <option value="ClusterIP">ClusterIP — internal only</option>
                      <option value="NodePort">NodePort — node IP + port</option>
                      <option value="LoadBalancer">LoadBalancer — cloud / MetalLB</option>
                    </select>
                  </div>
                  <div className="field">
                    <label>Ingress host</label>
                    <input className="ch-input" placeholder="app.example.com" value={form.ingressHost} onChange={upd("ingressHost")} disabled={!form.createService} />
                  </div>
                </div>
                <div className="field">
                  <label>Ingress path</label>
                  <input className="ch-input" value={form.ingressPath} onChange={upd("ingressPath")} disabled={!form.createService || !form.ingressHost.trim()} />
                </div>
                <p className="ki-hint">
                  Traefik routes <span className="mono">{form.ingressHost || "host"}{form.ingressPath || "/"}</span> → Service:{form.port || "port"}.
                  DNS or <span className="mono">/etc/hosts</span> must resolve the hostname to your Traefik entrypoint (K3s node IP or LoadBalancer VIP). Use <span className="mono">http://</span> unless you configured TLS.
                </p>
              </section>
            )}

            {tab === "storage" && (
              <section className="ki-panel-section">
                <div className="ki-field-grid-2">
                  <div className="field">
                    <label>PVC size (Gi)</label>
                    <input className="ch-input" type="number" min="1" max="1024" placeholder="e.g. 5" value={form.pvcSizeGi} onChange={upd("pvcSizeGi")} />
                  </div>
                  <div className="field">
                    <label>Mount path</label>
                    <input className="ch-input mono" value={form.pvcMountPath} onChange={upd("pvcMountPath")} disabled={!form.pvcSizeGi} />
                  </div>
                </div>
                <div className="ki-info-card">
                  Creates claim <span className="mono">{(form.name || "name").toLowerCase()}-data</span> using the cluster default StorageClass (local-path on K3s) and mounts it into the container.
                </div>
              </section>
            )}

            {tab === "labels" && (
              <section className="ki-panel-section">
                <div className="ki-field-grid-2">
                  <div className="field">
                    <label>Labels <span className="muted">KEY=value per line</span></label>
                    <textarea className="ch-input mono ki-code-area" rows={10} value={form.labelsText} onChange={upd("labelsText")} spellCheck={false} />
                  </div>
                  <div className="field">
                    <label>Environment <span className="muted">KEY=value per line</span></label>
                    <textarea className="ch-input mono ki-code-area" rows={10} value={form.envText} onChange={upd("envText")} placeholder={"LOG_LEVEL=info\nFEATURE_X=true"} spellCheck={false} />
                  </div>
                </div>
              </section>
            )}

            {tab === "resources" && (
              <section className="ki-panel-section">
                <div className="ki-res-grid">
                  <div className="ki-res-card">
                    <div className="ki-res-card-title">Requests</div>
                    <div className="field">
                      <label>CPU</label>
                      <input className="ch-input" placeholder="100m" value={form.cpuRequest} onChange={upd("cpuRequest")} />
                    </div>
                    <div className="field">
                      <label>Memory</label>
                      <input className="ch-input" placeholder="128Mi" value={form.memoryRequest} onChange={upd("memoryRequest")} />
                    </div>
                  </div>
                  <div className="ki-res-card lim">
                    <div className="ki-res-card-title">Limits</div>
                    <div className="field">
                      <label>CPU</label>
                      <input className="ch-input" placeholder="500m" value={form.cpuLimit} onChange={upd("cpuLimit")} />
                    </div>
                    <div className="field">
                      <label>Memory</label>
                      <input className="ch-input" placeholder="512Mi" value={form.memoryLimit} onChange={upd("memoryLimit")} />
                    </div>
                  </div>
                </div>
              </section>
            )}

            {tab === "yaml" && (
              <section className="ki-panel-section ki-panel-yaml">
                <div className="ki-yaml-chrome">
                  <div className="ki-section-banner">
                    <strong>YAML</strong>
                    <span className="muted">Edit manifest</span>
                  </div>
                  <div className="ki-yaml-toolbar">
                    <div>
                      <strong>Manifest YAML</strong>
                      <p className="muted" style={{ margin: "2px 0 0", fontSize: 12.5 }}>
                        Paste or edit YAML — form tabs update automatically. Use Sync from form to regenerate from fields.
                      </p>
                    </div>
                    <button type="button" className="btn btn-ghost btn-sm" onClick={resetYamlFromForm}>
                      Sync from form
                    </button>
                  </div>
                  {yamlParseNote && !error && (
                    <p className={`ki-yaml-note ${yamlParseNote.startsWith("Could") ? "warn" : "ok"}`}>
                      {yamlParseNote}
                    </p>
                  )}
                </div>
                <textarea
                  className="ch-input mono ki-yaml-editor"
                  value={yaml}
                  spellCheck={false}
                  onChange={(e) => onYamlChange(e.target.value)}
                />
              </section>
            )}
              </>
            )}
          </div>
        </div>

        <footer className="ki-panel-footer">
          <div className="ki-footer-row">
            <div className="ki-footer-hint muted">
              {yamlDirty
                ? "YAML edits will be applied with server-side apply — progress opens in the deployment monitor."
                : isEdit
                  ? "Guided fields stay in sync with the YAML preview. Save opens the deployment monitor."
                  : "Guided fields generate the YAML preview automatically. Deploy opens the deployment monitor."}
            </div>
            <div className="ki-footer-actions">
              <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={
                  busy
                  || loading
                  || (!yamlDirty && (!form.name.trim() || !form.image.trim()))
                  || (yamlDirty && !yaml.trim())
                }
                onClick={submit}
              >
                {busy ? "Starting…" : primaryLabel}
              </button>
            </div>
          </div>
        </footer>
      </div>
    </div>
  );
}
