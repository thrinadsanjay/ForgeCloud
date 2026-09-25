import { prisma, fireAndForget } from "../db/client.js";
import fs from "fs";
import path from "path";

const apps = new Map();

/** Recommended Forge blueprints — metadata + install paths under ansible/content. */
const SEED_APPS = [
  {
    id: "docker",
    name: "Docker Engine",
    description: "Container runtime with Compose and Portainer for day-2 management.",
    enabled: true,
    strategy: "ansible+compose",
    dependsOn: [],
    ansiblePlaybook: "playbooks/docker.yml",
    composePath: "apps/portainer/compose.yml",
    ports: [9000],
    healthcheck: { type: "tcp", port: 9000, timeoutSec: 90 },
    urlTemplate: "http://{ip}:9000",
    defaultVars: {
      category: "Containers",
      components: ["Docker Engine", "Docker Compose v2", "Portainer"],
      eta: "5–8 min",
    },
    sortOrder: 10,
  },
  {
    id: "k3s",
    name: "K3s Cluster",
    description: "Lightweight Kubernetes with Helm, kubectl, and Traefik ingress.",
    enabled: true,
    strategy: "ansible",
    dependsOn: [],
    ansiblePlaybook: "playbooks/k3s.yml",
    composePath: "",
    ports: [6443],
    healthcheck: { type: "tcp", port: 6443, timeoutSec: 180 },
    urlTemplate: "",
    defaultVars: {
      category: "Kubernetes",
      components: ["K3s", "Helm", "kubectl"],
      eta: "8–12 min",
    },
    sortOrder: 20,
  },
  {
    id: "grafana-influx",
    name: "Grafana + InfluxDB",
    description: "Metrics and dashboards — Grafana, InfluxDB, and starter config.",
    enabled: true,
    strategy: "compose",
    dependsOn: ["docker"],
    ansiblePlaybook: "",
    composePath: "apps/grafana-influx/compose.yml",
    ports: [3000, 8086],
    healthcheck: { type: "http", port: 3000, path: "/api/health", timeoutSec: 120 },
    urlTemplate: "http://{ip}:3000",
    defaultVars: {
      category: "Monitoring",
      components: ["Grafana", "InfluxDB", "Dashboards"],
      eta: "10–15 min",
    },
    sortOrder: 30,
  },
  {
    id: "prometheus-stack",
    name: "Prometheus Stack",
    description: "Prometheus, Grafana, and Alertmanager for full observability.",
    enabled: true,
    strategy: "compose",
    dependsOn: ["docker"],
    ansiblePlaybook: "",
    composePath: "apps/prometheus-stack/compose.yml",
    ports: [9090, 3000, 9093],
    healthcheck: { type: "http", port: 9090, path: "/-/ready", timeoutSec: 120 },
    urlTemplate: "http://{ip}:9090",
    defaultVars: {
      category: "Monitoring",
      components: ["Prometheus", "Grafana", "Alertmanager"],
      eta: "10–15 min",
    },
    sortOrder: 40,
  },
  {
    id: "lamp",
    name: "LAMP Stack",
    description: "Apache, PHP, and MySQL for classic Linux web apps.",
    enabled: true,
    strategy: "ansible",
    dependsOn: [],
    ansiblePlaybook: "playbooks/lamp.yml",
    composePath: "",
    ports: [80],
    healthcheck: { type: "http", port: 80, path: "/", timeoutSec: 90 },
    urlTemplate: "http://{ip}",
    defaultVars: {
      category: "Web",
      components: ["Apache", "PHP", "MySQL"],
      eta: "6–10 min",
    },
    sortOrder: 50,
  },
  {
    id: "lemp",
    name: "LEMP Stack",
    description: "Nginx, PHP-FPM, and MariaDB for modern Linux web apps.",
    enabled: true,
    strategy: "ansible",
    dependsOn: [],
    ansiblePlaybook: "playbooks/lemp.yml",
    composePath: "",
    ports: [80],
    healthcheck: { type: "http", port: 80, path: "/", timeoutSec: 90 },
    urlTemplate: "http://{ip}",
    defaultVars: { category: "Web" },
    sortOrder: 60,
  },
  {
    id: "jenkins",
    name: "Jenkins",
    description: "CI/CD with Jenkins, Java runtime, and Git tooling.",
    enabled: true,
    strategy: "compose",
    dependsOn: ["docker"],
    ansiblePlaybook: "",
    composePath: "apps/jenkins/compose.yml",
    ports: [8080],
    healthcheck: { type: "tcp", port: 8080, timeoutSec: 180 },
    urlTemplate: "http://{ip}:8080",
    defaultVars: { category: "CI/CD" },
    sortOrder: 70,
  },
  {
    id: "gitlab",
    name: "GitLab CE",
    description: "GitLab Community Edition with PostgreSQL and Redis.",
    enabled: true,
    strategy: "compose",
    dependsOn: ["docker"],
    ansiblePlaybook: "",
    composePath: "apps/gitlab/compose.yml",
    ports: [80, 443],
    healthcheck: { type: "tcp", port: 80, timeoutSec: 300 },
    urlTemplate: "http://{ip}",
    defaultVars: { category: "Git" },
    sortOrder: 80,
  },
  {
    id: "nginx-proxy",
    name: "NGINX Reverse Proxy",
    description: "Nginx front-end with Certbot-ready SSL layout.",
    enabled: true,
    strategy: "ansible",
    dependsOn: [],
    ansiblePlaybook: "playbooks/nginx-proxy.yml",
    composePath: "",
    ports: [80, 443],
    healthcheck: { type: "http", port: 80, path: "/", timeoutSec: 60 },
    urlTemplate: "http://{ip}",
    defaultVars: { category: "Reverse Proxy" },
    sortOrder: 90,
  },
  {
    id: "elk",
    name: "ELK Stack",
    description: "Elasticsearch, Logstash, and Kibana for centralized logging.",
    enabled: true,
    strategy: "compose",
    dependsOn: ["docker"],
    ansiblePlaybook: "",
    composePath: "apps/elk/compose.yml",
    ports: [5601, 9200],
    healthcheck: { type: "http", port: 5601, path: "/api/status", timeoutSec: 240 },
    urlTemplate: "http://{ip}:5601",
    defaultVars: { category: "Logging" },
    sortOrder: 100,
  },
  {
    id: "developer-essentials",
    name: "Developer Essentials",
    description: "Git, curl, vim, jq, htop, and tmux — ready for day-one work.",
    enabled: true,
    strategy: "ansible",
    dependsOn: [],
    ansiblePlaybook: "playbooks/developer-essentials.yml",
    composePath: "",
    ports: [],
    healthcheck: {},
    urlTemplate: "",
    defaultVars: { category: "Development" },
    sortOrder: 110,
  },
  {
    id: "docker-dev",
    name: "Docker Development",
    description: "Docker, Compose, and VS Code Server for remote development.",
    enabled: true,
    strategy: "ansible+compose",
    dependsOn: [],
    ansiblePlaybook: "playbooks/docker.yml",
    composePath: "apps/code-server/compose.yml",
    ports: [8080],
    healthcheck: { type: "tcp", port: 8080, timeoutSec: 120 },
    urlTemplate: "http://{ip}:8080",
    defaultVars: { category: "Containers" },
    sortOrder: 120,
  },
  // Keep individual grafana/influx for finer selection (legacy seeds)
  {
    id: "grafana",
    name: "Grafana",
    description: "Observability UI only (pair with InfluxDB or Prometheus as needed).",
    enabled: true,
    strategy: "compose",
    dependsOn: ["docker"],
    ansiblePlaybook: "",
    composePath: "apps/grafana/compose.yml",
    ports: [3000],
    healthcheck: { type: "http", port: 3000, path: "/api/health", timeoutSec: 120 },
    urlTemplate: "http://{ip}:3000",
    defaultVars: { category: "Monitoring" },
    sortOrder: 130,
  },
  {
    id: "influxdb",
    name: "InfluxDB",
    description: "Time-series database via Docker Compose.",
    enabled: true,
    strategy: "compose",
    dependsOn: ["docker"],
    ansiblePlaybook: "",
    composePath: "apps/influxdb/compose.yml",
    ports: [8086],
    healthcheck: { type: "tcp", port: 8086, timeoutSec: 120 },
    urlTemplate: "http://{ip}:8086",
    defaultVars: { category: "Monitoring" },
    sortOrder: 140,
  },
];

function rowToApp(row) {
  const defaultVars = row.defaultVars && typeof row.defaultVars === "object" ? row.defaultVars : {};
  const components = Array.isArray(defaultVars.components) ? defaultVars.components.map(String) : [];
  const source = row.source === "custom" ? "custom" : "bundled";
  return {
    id: row.id,
    name: row.name,
    description: row.description || "",
    enabled: row.enabled !== false,
    strategy: row.strategy,
    dependsOn: Array.isArray(row.dependsOn) ? row.dependsOn : [],
    ansiblePlaybook: row.ansiblePlaybook || "",
    composePath: row.composePath || "",
    ports: Array.isArray(row.ports) ? row.ports : [],
    healthcheck: row.healthcheck && typeof row.healthcheck === "object" ? row.healthcheck : {},
    urlTemplate: row.urlTemplate || "",
    defaultVars,
    sortOrder: row.sortOrder ?? 0,
    source,
    category: defaultVars.category || "General",
    components,
    eta: defaultVars.eta || "",
  };
}

function persist(app) {
  fireAndForget(
    prisma.appBlueprint.upsert({
      where: { id: app.id },
      create: {
        id: app.id,
        name: app.name,
        description: app.description || "",
        enabled: app.enabled !== false,
        strategy: app.strategy,
        dependsOn: app.dependsOn || [],
        ansiblePlaybook: app.ansiblePlaybook || "",
        composePath: app.composePath || "",
        ports: app.ports || [],
        healthcheck: app.healthcheck || {},
        urlTemplate: app.urlTemplate || "",
        defaultVars: app.defaultVars || {},
        sortOrder: app.sortOrder ?? 0,
        source: app.source === "custom" ? "custom" : "bundled",
      },
      update: {
        name: app.name,
        description: app.description || "",
        enabled: app.enabled !== false,
        strategy: app.strategy,
        dependsOn: app.dependsOn || [],
        ansiblePlaybook: app.ansiblePlaybook || "",
        composePath: app.composePath || "",
        ports: app.ports || [],
        healthcheck: app.healthcheck || {},
        urlTemplate: app.urlTemplate || "",
        defaultVars: app.defaultVars || {},
        sortOrder: app.sortOrder ?? 0,
        source: app.source === "custom" ? "custom" : "bundled",
      },
    }),
    "app-blueprint"
  );
}

export async function hydrateAppBlueprints() {
  const rows = await prisma.appBlueprint.findMany();
  apps.clear();
  for (const row of rows) {
    const a = rowToApp(row);
    apps.set(a.id, a);
  }
}

/** Upsert recommended seeds — creates missing only; never overwrites admin edits. */
export async function seedAppBlueprintsIfEmpty() {
  for (const seed of SEED_APPS) {
    const existing = await prisma.appBlueprint.findUnique({ where: { id: seed.id } });
    if (existing) {
      if (!existing.source) {
        await prisma.appBlueprint.update({ where: { id: seed.id }, data: { source: "bundled" } }).catch(() => {});
      }
      continue;
    }
    await prisma.appBlueprint.create({ data: { ...seed, source: "bundled" } });
  }
  await hydrateAppBlueprints();
}

export function listAppBlueprints({ enabledOnly = false } = {}) {
  let list = Array.from(apps.values());
  if (enabledOnly) list = list.filter((a) => a.enabled);
  return list.sort((a, b) => (a.sortOrder - b.sortOrder) || a.name.localeCompare(b.name));
}

export function getAppBlueprint(id) {
  return apps.get(id) || null;
}

function parsePorts(raw) {
  if (Array.isArray(raw)) return raw.map(Number).filter((n) => Number.isFinite(n) && n > 0);
  if (typeof raw === "string") {
    return raw.split(/[\s,]+/).map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0);
  }
  return [];
}

function parseDependsOn(raw) {
  if (Array.isArray(raw)) return raw.map(String).map((s) => s.trim()).filter(Boolean);
  if (typeof raw === "string") {
    return raw.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
  }
  return [];
}

function parseHealthcheck(body = {}) {
  if (body.healthcheck && typeof body.healthcheck === "object") return body.healthcheck;
  const type = String(body.healthType || "").trim();
  const port = Number(body.healthPort);
  if (!type && !port) return {};
  const hc = {};
  if (type === "http" || type === "tcp") hc.type = type;
  if (Number.isFinite(port) && port > 0) hc.port = port;
  if (body.healthPath) hc.path = String(body.healthPath);
  if (body.healthTimeoutSec) hc.timeoutSec = Number(body.healthTimeoutSec) || 90;
  return hc;
}

export async function adminListAppBlueprints() {
  await hydrateAppBlueprints();
  return listAppBlueprints({ enabledOnly: false });
}

export async function adminUpsertAppBlueprint(body = {}) {
  const id = String(body.id || "").trim().toLowerCase().replace(/[^a-z0-9-_]/g, "-");
  if (!id) {
    const err = new Error("id is required");
    err.status = 400;
    throw err;
  }
  const strategy = String(body.strategy || "ansible").trim();
  if (!["ansible", "compose", "ansible+compose"].includes(strategy)) {
    const err = new Error('strategy must be ansible, compose, or ansible+compose');
    err.status = 400;
    throw err;
  }
  const ansiblePlaybook = String(body.ansiblePlaybook || "").trim();
  const composePath = String(body.composePath || "").trim();
  if ((strategy === "ansible" || strategy === "ansible+compose") && !ansiblePlaybook) {
    const err = new Error("ansiblePlaybook is required for this strategy");
    err.status = 400;
    throw err;
  }
  if ((strategy === "compose" || strategy === "ansible+compose") && !composePath) {
    const err = new Error("composePath is required for this strategy");
    err.status = 400;
    throw err;
  }

  const category = String(body.category || body.defaultVars?.category || "General").trim() || "General";
  const incomingVars = body.defaultVars && typeof body.defaultVars === "object" ? body.defaultVars : {};
  const components = Array.isArray(incomingVars.components)
    ? incomingVars.components.map((c) => String(c).trim()).filter(Boolean)
    : (typeof incomingVars.components === "string"
      ? String(incomingVars.components).split(/[,;\n]+/).map((s) => s.trim()).filter(Boolean)
      : []);
  const eta = String(incomingVars.eta || body.eta || "").trim();
  const defaultVars = {
    ...incomingVars,
    category,
    ...(components.length ? { components } : { components: [] }),
    ...(eta ? { eta } : {}),
  };

  const app = {
    id,
    name: String(body.name || id).trim(),
    description: String(body.description || "").trim(),
    enabled: body.enabled !== false && body.enabled !== "false",
    strategy,
    dependsOn: parseDependsOn(body.dependsOn),
    ansiblePlaybook,
    composePath,
    ports: parsePorts(body.ports),
    healthcheck: parseHealthcheck(body),
    urlTemplate: String(body.urlTemplate || "").trim(),
    defaultVars,
    sortOrder: Number.isFinite(Number(body.sortOrder)) ? Number(body.sortOrder) : 0,
    source: body.source === "custom" ? "custom" : (apps.get(id)?.source === "custom" ? "custom" : "bundled"),
  };

  await prisma.appBlueprint.upsert({
    where: { id: app.id },
    create: app,
    update: {
      name: app.name,
      description: app.description,
      enabled: app.enabled,
      strategy: app.strategy,
      dependsOn: app.dependsOn,
      ansiblePlaybook: app.ansiblePlaybook,
      composePath: app.composePath,
      ports: app.ports,
      healthcheck: app.healthcheck,
      urlTemplate: app.urlTemplate,
      defaultVars: app.defaultVars,
      sortOrder: app.sortOrder,
      source: app.source,
    },
  });
  apps.set(app.id, { ...app, category, components, eta });
  return apps.get(app.id);
}

export async function adminDeleteAppBlueprint(id) {
  const key = String(id || "").trim();
  if (!key) {
    const err = new Error("id required");
    err.status = 400;
    throw err;
  }
  // Block delete if another blueprint depends on this one
  const dependents = listAppBlueprints().filter((a) => (a.dependsOn || []).includes(key));
  if (dependents.length) {
    const err = new Error(`Cannot delete: used as dependency by ${dependents.map((d) => d.id).join(", ")}`);
    err.status = 409;
    throw err;
  }
  await prisma.appBlueprint.delete({ where: { id: key } }).catch((e) => {
    if (e.code === "P2025") {
      const err = new Error("Blueprint not found");
      err.status = 404;
      throw err;
    }
    throw e;
  });
  apps.delete(key);
  return { ok: true };
}

export function resolveAppDependencies(selectedIds = []) {
  const wanted = new Set((selectedIds || []).map(String));
  const order = [];
  const visiting = new Set();

  function visit(id) {
    if (order.includes(id)) return;
    if (visiting.has(id)) throw new Error(`Circular app dependency involving "${id}"`);
    const app = apps.get(id);
    if (!app) throw new Error(`Unknown app "${id}"`);
    if (!app.enabled) throw new Error(`App "${app.name}" is disabled`);
    visiting.add(id);
    for (const dep of app.dependsOn || []) visit(dep);
    visiting.delete(id);
    order.push(id);
  }

  for (const id of wanted) visit(id);
  const needed = new Set();
  function mark(id) {
    if (needed.has(id)) return;
    needed.add(id);
    const app = apps.get(id);
    for (const dep of app?.dependsOn || []) mark(dep);
  }
  for (const id of wanted) mark(id);
  return order.filter((id) => needed.has(id));
}

export function previewAppPlan(selectedIds = []) {
  const resolved = resolveAppDependencies(selectedIds);
  const selected = new Set(selectedIds.map(String));
  return resolved.map((id) => {
    const app = apps.get(id);
    return {
      id,
      name: app.name,
      strategy: app.strategy,
      category: app.category || app.defaultVars?.category || "General",
      autoIncluded: !selected.has(id),
      urlTemplate: app.urlTemplate || null,
      source: app.source || "bundled",
    };
  });
}

/**
 * Upsert blueprints from custom catalog.yaml / catalog.json.
 * Never overwrites bundled ids — collisions are skipped with a warning.
 * Removes previous custom blueprints not present in this catalog.
 */
export async function syncCustomBlueprintsFromCatalog(doc, { contentRoot } = {}) {
  const list = Array.isArray(doc?.blueprints) ? doc.blueprints : (Array.isArray(doc) ? doc : []);
  const onboarded = [];
  const updated = [];
  const removed = [];
  const warnings = [];
  const keepIds = new Set();

  await hydrateAppBlueprints();

  for (const raw of list) {
    if (!raw || typeof raw !== "object") continue;
    const id = String(raw.id || "").trim().toLowerCase().replace(/[^a-z0-9-_]/g, "-");
    if (!id) {
      warnings.push("Skipped blueprint with empty id");
      continue;
    }
    const existing = apps.get(id);
    if (existing && existing.source !== "custom") {
      warnings.push(`Skipped "${id}" — id already used by a bundled blueprint`);
      continue;
    }

    const strategy = String(raw.strategy || "ansible").trim();
    if (!["ansible", "compose", "ansible+compose"].includes(strategy)) {
      warnings.push(`Skipped "${id}" — invalid strategy`);
      continue;
    }
    const ansiblePlaybook = String(raw.ansiblePlaybook || "").trim();
    const composePath = String(raw.composePath || "").trim();
    if ((strategy === "ansible" || strategy === "ansible+compose") && !ansiblePlaybook) {
      warnings.push(`Skipped "${id}" — ansiblePlaybook required`);
      continue;
    }
    if ((strategy === "compose" || strategy === "ansible+compose") && !composePath) {
      warnings.push(`Skipped "${id}" — composePath required`);
      continue;
    }
    if (contentRoot && ansiblePlaybook) {
      const full = path.join(contentRoot, ansiblePlaybook);
      if (!fs.existsSync(full)) {
        warnings.push(`Skipped "${id}" — playbook missing: ${ansiblePlaybook}`);
        continue;
      }
    }
    if (contentRoot && composePath) {
      const full = path.join(contentRoot, composePath);
      if (!fs.existsSync(full)) {
        warnings.push(`Skipped "${id}" — compose missing: ${composePath}`);
        continue;
      }
    }

    const category = String(raw.category || raw.defaultVars?.category || "Custom").trim() || "Custom";
    const incomingVars = raw.defaultVars && typeof raw.defaultVars === "object" ? raw.defaultVars : {};
    const defaultVars = { ...incomingVars, category };
    const app = {
      id,
      name: String(raw.name || id).trim(),
      description: String(raw.description || "").trim(),
      enabled: raw.enabled !== false && raw.enabled !== "false",
      strategy,
      dependsOn: parseDependsOn(raw.dependsOn),
      ansiblePlaybook,
      composePath,
      ports: parsePorts(raw.ports),
      healthcheck: parseHealthcheck(raw),
      urlTemplate: String(raw.urlTemplate || "").trim(),
      defaultVars,
      sortOrder: Number.isFinite(Number(raw.sortOrder)) ? Number(raw.sortOrder) : 500,
      source: "custom",
    };

    const wasNew = !existing;
    await prisma.appBlueprint.upsert({
      where: { id },
      create: app,
      update: {
        name: app.name,
        description: app.description,
        enabled: app.enabled,
        strategy: app.strategy,
        dependsOn: app.dependsOn,
        ansiblePlaybook: app.ansiblePlaybook,
        composePath: app.composePath,
        ports: app.ports,
        healthcheck: app.healthcheck,
        urlTemplate: app.urlTemplate,
        defaultVars: app.defaultVars,
        sortOrder: app.sortOrder,
        source: "custom",
      },
    });
    apps.set(id, {
      ...app,
      category,
      components: Array.isArray(defaultVars.components) ? defaultVars.components.map(String) : [],
      eta: defaultVars.eta || "",
    });
    keepIds.add(id);
    if (wasNew) onboarded.push(id);
    else updated.push(id);
  }

  const customRows = listAppBlueprints({ enabledOnly: false }).filter((a) => a.source === "custom");
  for (const row of customRows) {
    if (keepIds.has(row.id)) continue;
    await prisma.appBlueprint.delete({ where: { id: row.id } }).catch(() => {});
    apps.delete(row.id);
    removed.push(row.id);
  }

  return { onboarded, updated, removed, warnings };
}

/** Delete all custom-sourced blueprints (bundled untouched). */
export async function offboardCustomBlueprints() {
  await hydrateAppBlueprints();
  const custom = listAppBlueprints({ enabledOnly: false }).filter((a) => a.source === "custom");
  for (const row of custom) {
    await prisma.appBlueprint.delete({ where: { id: row.id } }).catch(() => {});
    apps.delete(row.id);
  }
  return custom.map((c) => ({ id: c.id, name: c.name }));
}
