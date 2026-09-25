import fs from "fs";
import os from "os";
import path from "path";
import https from "https";
import { X509Certificate, createPrivateKey } from "crypto";
import { spawn } from "child_process";
import { getDockerHostSecrets } from "./dockerHostStore.js";

const PROJECT_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/;

export function validateProjectName(name) {
  const n = String(name || "").trim().toLowerCase();
  if (!PROJECT_RE.test(n)) {
    throw new Error("Project name must be lowercase alphanumeric, starting with a letter or digit (hyphen/underscore allowed)");
  }
  return n;
}

/** tcp://host:2376 → { hostname, port, protocol } */
export function parseDockerEndpoint(endpoint) {
  let raw = String(endpoint || "").trim();
  if (/^tcp:\/\//i.test(raw)) raw = raw.replace(/^tcp:\/\//i, "https://");
  if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`;
  const u = new URL(raw);
  return {
    hostname: u.hostname,
    port: u.port ? Number(u.port) : (u.protocol === "http:" ? 2375 : 2376),
    protocol: u.protocol === "http:" ? "http:" : "https:",
  };
}

function writeTlsDir(host) {
  if (!host.tlsCa && !host.tlsCert && !host.tlsKey) return null;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-docker-"));
  if (host.tlsCa) fs.writeFileSync(path.join(dir, "ca.pem"), host.tlsCa, { mode: 0o600 });
  if (host.tlsCert) fs.writeFileSync(path.join(dir, "cert.pem"), host.tlsCert, { mode: 0o600 });
  if (host.tlsKey) fs.writeFileSync(path.join(dir, "key.pem"), host.tlsKey, { mode: 0o600 });
  return dir;
}

function cleanupDir(dir) {
  if (!dir) return;
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch { /* ignore */ }
}

function hasClientCerts(host) {
  return !!(host.tlsCa && host.tlsCert && host.tlsKey);
}

function pemKind(pem) {
  const text = String(pem || "");
  if (/BEGIN\s+CERTIFICATE\s+REQUEST/i.test(text) || /BEGIN\s+NEW\s+CERTIFICATE\s+REQUEST/i.test(text)) {
    return "csr";
  }
  if (/BEGIN\s+CERTIFICATE\b/i.test(text)) return "certificate";
  if (/BEGIN\s+(RSA\s+)?PRIVATE\s+KEY/i.test(text) || /BEGIN\s+OPENSSH\s+PRIVATE\s+KEY/i.test(text) || /BEGIN\s+EC\s+PRIVATE\s+KEY/i.test(text)) {
    return "private-key";
  }
  return "unknown";
}

function validateClientTlsMaterials(host) {
  const supplied = [host.tlsCa, host.tlsCert, host.tlsKey].filter(Boolean).length;
  if (supplied === 0) return;
  if (supplied !== 3) {
    throw new Error("Docker TLS materials are incomplete. Supply the CA, client certificate, and private key together.");
  }

  const caKind = pemKind(host.tlsCa);
  const certKind = pemKind(host.tlsCert);
  const keyKind = pemKind(host.tlsKey);

  if (certKind === "csr") {
    throw new Error(
      "Client certificate field contains a Certificate Signing Request (CSR), not a signed certificate. "
      + "Sign the CSR with your CA to produce a .pem that starts with -----BEGIN CERTIFICATE----- (not CERTIFICATE REQUEST), then upload that.",
    );
  }
  if (caKind === "csr") {
    throw new Error("TLS CA field contains a CSR. Upload the CA certificate (-----BEGIN CERTIFICATE-----).");
  }
  if (certKind !== "certificate") {
    throw new Error("Client certificate must be a PEM certificate starting with -----BEGIN CERTIFICATE-----.");
  }
  if (caKind !== "certificate") {
    throw new Error("TLS CA must be a PEM certificate starting with -----BEGIN CERTIFICATE-----.");
  }
  if (keyKind !== "private-key") {
    throw new Error("Client key must be a PEM private key (-----BEGIN PRIVATE KEY----- or -----BEGIN RSA PRIVATE KEY-----).");
  }

  try {
    // Parsing the CA catches truncated/incorrect uploads. A CA bundle is valid;
    // X509Certificate inspects its first certificate.
    new X509Certificate(host.tlsCa);
    const cert = new X509Certificate(host.tlsCert);
    const key = createPrivateKey(host.tlsKey);
    if (!cert.checkPrivateKey(key)) {
      throw new Error("The uploaded client certificate does not match the private key.");
    }
    const now = Date.now();
    if (now < Date.parse(cert.validFrom) || now > Date.parse(cert.validTo)) {
      throw new Error(`The client certificate is not currently valid (${cert.validFrom} – ${cert.validTo}).`);
    }
    const usages = cert.keyUsage || [];
    const clientAuthOid = "1.3.6.1.5.5.7.3.2";
    const serverAuthOid = "1.3.6.1.5.5.7.3.1";
    if (usages.length && !usages.includes(clientAuthOid)) {
      const hint = usages.includes(serverAuthOid)
        ? " It appears to be a server certificate (e.g. server-cert.pem)."
        : "";
      throw new Error(`The uploaded certificate is not valid for TLS client authentication.${hint} Generate a client certificate with clientAuth extended key usage.`);
    }
  } catch (error) {
    if (/uploaded|client certificate|TLS CA|Client key|CSR|Certificate Signing/i.test(error.message)) throw error;
    throw new Error(`Invalid Docker TLS material: ${error.message}`);
  }
}

function tlsAgent(host) {
  const opts = {
    rejectUnauthorized: !host.skipTlsVerify,
  };
  if (host.tlsCa) opts.ca = host.tlsCa;
  if (host.tlsCert) opts.cert = host.tlsCert;
  if (host.tlsKey) opts.key = host.tlsKey;
  return new https.Agent(opts);
}

function engineRequest(host, method, apiPath, { body, timeoutMs = 15000, raw = false } = {}) {
  const { hostname, port } = parseDockerEndpoint(host.endpoint);
  const payload = body != null ? JSON.stringify(body) : null;
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname,
        port,
        path: apiPath,
        method,
        agent: tlsAgent(host),
        headers: payload
          ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }
          : {},
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const buf = Buffer.concat(chunks);
          if (res.statusCode >= 200 && res.statusCode < 300) {
            if (raw) return resolve(buf);
            const text = buf.toString("utf8");
            if (!text) return resolve(null);
            try {
              resolve(JSON.parse(text));
            } catch {
              resolve(text);
            }
          } else {
            const text = buf.toString("utf8");
            const err = new Error(text || `Docker Engine HTTP ${res.statusCode}`);
            err.statusCode = res.statusCode;
            reject(err);
          }
        });
      }
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Docker Engine request timed out"));
    });
    if (payload) req.write(payload);
    req.end();
  });
}

export function describeDockerConnectionError(error) {
  const message = String(error?.message || error || "Unknown connection error");
  const code = error?.code ? String(error.code) : "";
  if (/alert bad certificate|bad certificate/i.test(message)) {
    return "Docker daemon rejected the client certificate. Verify that the client certificate was signed by the CA trusted by the daemon, has Client Authentication usage, and matches the uploaded private key.";
  }
  if (/certificate.*expired|certificate has expired/i.test(message)) {
    return "A TLS certificate has expired. Replace the CA/client certificate with a valid certificate.";
  }
  if (/self[- ]signed|unable to verify|unable to get local issuer|certificate verify failed/i.test(message)) {
    return "Docker daemon certificate verification failed. Upload the CA that signed the daemon certificate, or use Skip TLS verification only for a trusted lab endpoint.";
  }
  if (/key values mismatch|does not match|bad decrypt|PEM routines/i.test(message)) {
    return "The client certificate and private key are invalid or do not match.";
  }
  if (code === "ECONNREFUSED") {
    return "Connection refused. Confirm Docker is listening on this address/port and the firewall allows access from Forge.";
  }
  if (code === "EHOSTUNREACH" || code === "ENETUNREACH") {
    return "Docker host is not reachable from the Forge container. Check routing and firewall rules.";
  }
  if (code === "ENOTFOUND") {
    return "Docker host name could not be resolved from the Forge container.";
  }
  if (code === "ETIMEDOUT" || /timed out/i.test(message)) {
    return "Connection timed out. Confirm the endpoint, routing, and firewall rules.";
  }
  return message;
}

export async function testConnection(hostOrId) {
  const host = typeof hostOrId === "string" ? getDockerHostSecrets(hostOrId) : hostOrId;
  if (!host) throw new Error("Docker host not found");
  if (!host.skipTlsVerify && !hasClientCerts(host)) {
    throw new Error("TLS materials are incomplete");
  }
  validateClientTlsMaterials(host);
  try {
    const version = await engineRequest(host, "GET", "/version", { timeoutMs: 8000 });
    await engineRequest(host, "GET", "/_ping", { timeoutMs: 5000 }).catch(() => null);
    return {
      ok: true,
      apiVersion: version?.ApiVersion || version?.Version || "ok",
      platform: version?.Platform?.Name || version?.Os || "",
      version: version?.Version || "",
      skipTlsVerify: !!host.skipTlsVerify,
    };
  } catch (error) {
    const diagnostic = new Error(describeDockerConnectionError(error));
    diagnostic.code = error?.code;
    diagnostic.cause = error;
    throw diagnostic;
  }
}

function publishedPorts(container) {
  const ports = container.Ports || [];
  return ports
    .filter((p) => p.PublicPort)
    .map((p) => `${p.IP || "0.0.0.0"}:${p.PublicPort}→${p.PrivatePort}/${p.Type || "tcp"}`);
}

function containerView(c) {
  const labels = c.Labels || {};
  const names = (c.Names || []).map((n) => n.replace(/^\//, ""));
  return {
    id: c.Id,
    shortId: String(c.Id || "").slice(0, 12),
    name: names[0] || labels["com.docker.compose.service"] || String(c.Id || "").slice(0, 12),
    image: c.Image,
    state: c.State,
    status: c.Status,
    project: labels["com.docker.compose.project"] || null,
    service: labels["com.docker.compose.service"] || null,
    ports: publishedPorts(c),
    created: c.Created,
  };
}

export async function listContainers(host) {
  const list = await engineRequest(host, "GET", "/containers/json?all=1");
  return (Array.isArray(list) ? list : []).map(containerView);
}

export async function listProjects(host) {
  const containers = await listContainers(host);
  const byProject = new Map();
  for (const c of containers) {
    if (!c.project) continue;
    if (!byProject.has(c.project)) {
      byProject.set(c.project, { name: c.project, containers: [] });
    }
    byProject.get(c.project).containers.push(c);
  }
  return Array.from(byProject.values()).sort((a, b) => a.name.localeCompare(b.name));
}

export async function startContainer(host, containerId) {
  await engineRequest(host, "POST", `/containers/${encodeURIComponent(containerId)}/start`);
}

export async function stopContainer(host, containerId) {
  await engineRequest(host, "POST", `/containers/${encodeURIComponent(containerId)}/stop`);
}

export async function restartContainer(host, containerId) {
  await engineRequest(host, "POST", `/containers/${encodeURIComponent(containerId)}/restart`);
}

export async function removeContainer(host, containerId, { force = true } = {}) {
  const q = force ? "?force=1&v=0" : "?v=0";
  await engineRequest(host, "DELETE", `/containers/${encodeURIComponent(containerId)}${q}`);
}

/** Hostname/IP from DOCKER_HOST-style endpoint for published-port URLs. */
export function endpointHost(endpoint) {
  try {
    const { hostname } = parseDockerEndpoint(endpoint);
    return hostname || "";
  } catch {
    return "";
  }
}

export function publishedWebUrls(host, ports) {
  const hostname = endpointHost(host?.endpoint);
  if (!hostname) return [];
  const urls = [];
  for (const p of ports || []) {
    // Formats: "0.0.0.0:8080→80/tcp" or ":::8080→80/tcp"
    const m = String(p).match(/(?:0\.0\.0\.0|:::|\[::\]):(\d+)\s*→\s*(\d+)\/(tcp|udp)/i)
      || String(p).match(/:(\d+)\s*→\s*(\d+)\/(tcp|udp)/i);
    if (!m) continue;
    const pub = m[1];
    const proto = (m[3] || "tcp").toLowerCase();
    if (proto !== "tcp") continue;
    const scheme = pub === "443" ? "https" : "http";
    urls.push({
      label: `${scheme}://${hostname}:${pub}`,
      url: `${scheme}://${hostname}:${pub}`,
      publicPort: Number(pub),
      privatePort: Number(m[2]),
    });
  }
  return urls;
}

/** Tear down a Compose project via Engine API (no local compose file required). */
export async function downProject(host, projectName) {
  const project = validateProjectName(projectName);
  const containers = await listContainers(host);
  const mine = containers.filter((c) => c.project === project);
  for (const c of mine) {
    try {
      await stopContainer(host, c.id);
    } catch { /* already stopped */ }
    try {
      await engineRequest(host, "DELETE", `/containers/${encodeURIComponent(c.id)}?force=1&v=0`);
    } catch (e) {
      throw new Error(`Failed to remove container ${c.name}: ${e.message}`);
    }
  }
  // Remove networks labeled for this project
  try {
    const nets = await engineRequest(host, "GET", "/networks");
    for (const n of Array.isArray(nets) ? nets : []) {
      const labels = n.Labels || {};
      if (labels["com.docker.compose.project"] === project) {
        await engineRequest(host, "DELETE", `/networks/${encodeURIComponent(n.Id)}`).catch(() => null);
      }
    }
  } catch { /* best-effort */ }
  return { removed: mine.length, project };
}

/** Restart all containers in a Compose project (redeploy without source YAML). */
export async function restartProject(host, projectName) {
  const project = validateProjectName(projectName);
  const containers = await listContainers(host);
  const mine = containers.filter((c) => c.project === project);
  if (!mine.length) throw new Error(`No containers for project "${project}"`);
  for (const c of mine) {
    try {
      await engineRequest(host, "POST", `/containers/${encodeURIComponent(c.id)}/restart`);
    } catch (e) {
      throw new Error(`Failed to restart ${c.name}: ${e.message}`);
    }
  }
  return { restarted: mine.length, project };
}

export async function getContainerLogs(host, containerId, { tail = 200 } = {}) {
  const n = Math.min(Math.max(Number(tail) || 200, 1), 2000);
  const raw = await engineRequest(
    host,
    "GET",
    `/containers/${encodeURIComponent(containerId)}/logs?stdout=1&stderr=1&timestamps=1&tail=${n}`,
    { raw: true },
  );
  // Docker multiplexes stdout/stderr with 8-byte headers when TTY is false.
  if (Buffer.isBuffer(raw)) return demuxDockerLogs(raw);
  if (typeof raw === "string") return raw;
  return String(raw || "");
}

function demuxDockerLogs(buf) {
  let out = "";
  let i = 0;
  while (i + 8 <= buf.length) {
    const size = buf.readUInt32BE(i + 4);
    i += 8;
    if (size <= 0 || i + size > buf.length) break;
    out += buf.slice(i, i + size).toString("utf8");
    i += size;
  }
  return out || buf.toString("utf8");
}

export async function inspectContainer(host, containerId) {
  const data = await engineRequest(host, "GET", `/containers/${encodeURIComponent(containerId)}/json`);
  const state = data?.State || {};
  const health = state.Health || null;
  const env = Array.isArray(data?.Config?.Env) ? data.Config.Env : [];
  const ports = publishedPorts({
    Ports: Object.entries(data?.NetworkSettings?.Ports || {}).flatMap(([key, binds]) => {
      const [privatePort, type] = key.split("/");
      return (binds || []).map((b) => ({
        IP: b.HostIp,
        PublicPort: Number(b.HostPort),
        PrivatePort: Number(privatePort),
        Type: type || "tcp",
      }));
    }),
  });
  const labels = data?.Config?.Labels || {};
  return {
    id: data?.Id,
    shortId: String(data?.Id || "").slice(0, 12),
    name: (data?.Name || "").replace(/^\//, ""),
    image: data?.Config?.Image || data?.Image || "",
    state: state.Status,
    running: !!state.Running,
    env,
    ports,
    webUrls: publishedWebUrls(host, ports),
    labels,
    project: labels["com.docker.compose.project"] || null,
    service: labels["com.docker.compose.service"] || null,
    health: health
      ? {
        status: health.Status,
        failingStreak: health.FailingStreak,
        log: (health.Log || []).slice(-3).map((l) => ({
          exitCode: l.ExitCode,
          output: String(l.Output || "").slice(0, 200),
        })),
      }
      : null,
    startedAt: state.StartedAt || null,
    finishedAt: state.FinishedAt || null,
    // Raw pieces needed for recreate (env update)
    _create: {
      image: data?.Config?.Image,
      cmd: data?.Config?.Cmd,
      entrypoint: data?.Config?.Entrypoint,
      workingDir: data?.Config?.WorkingDir,
      user: data?.Config?.User,
      hostname: data?.Config?.Hostname,
      labels: data?.Config?.Labels,
      exposedPorts: data?.Config?.ExposedPorts,
      volumes: data?.Config?.Volumes,
      hostConfig: data?.HostConfig,
      networkingConfig: data?.NetworkSettings?.Networks
        ? { EndpointsConfig: data.NetworkSettings.Networks }
        : undefined,
    },
  };
}

/**
 * Replace container Env by recreate (Docker has no in-place env update).
 * Returns the new container id. Warns callers that the container restarts.
 */
export async function updateContainerEnv(host, containerId, envList) {
  const env = (Array.isArray(envList) ? envList : [])
    .map((line) => String(line || "").trim())
    .filter(Boolean);
  for (const line of env) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*=/.test(line)) {
      throw new Error(`Invalid environment entry "${line}" (expected KEY=value)`);
    }
  }

  const inspected = await inspectContainer(host, containerId);
  const name = inspected.name;
  const create = inspected._create || {};
  if (!create.image) throw new Error("Cannot update env: container image is unknown");

  const wasRunning = !!inspected.running;
  if (wasRunning) {
    try { await stopContainer(host, containerId); } catch { /* already stopped */ }
  }

  // Rename old container so we can reuse the name, then remove it after create succeeds.
  const stashName = `${name}__forge_old_${Date.now().toString(36)}`;
  await engineRequest(
    host,
    "POST",
    `/containers/${encodeURIComponent(containerId)}/rename?name=${encodeURIComponent(stashName)}`,
  ).catch(() => null);

  const body = {
    Image: create.image,
    Env: env,
    Cmd: create.cmd,
    Entrypoint: create.entrypoint,
    WorkingDir: create.workingDir,
    User: create.user,
    Hostname: create.hostname,
    Labels: create.labels,
    ExposedPorts: create.exposedPorts,
    Volumes: create.volumes,
    HostConfig: sanitizeHostConfig(create.hostConfig),
    NetworkingConfig: create.networkingConfig,
  };

  let created;
  try {
    created = await engineRequest(
      host,
      "POST",
      `/containers/create?name=${encodeURIComponent(name)}`,
      { body },
    );
  } catch (e) {
    // Best-effort rename back
    await engineRequest(
      host,
      "POST",
      `/containers/${encodeURIComponent(containerId)}/rename?name=${encodeURIComponent(name)}`,
    ).catch(() => null);
    if (wasRunning) await startContainer(host, containerId).catch(() => null);
    throw e;
  }

  await removeContainer(host, containerId, { force: true }).catch(() => null);
  // If rename succeeded, remove the stash name id (same id).
  await removeContainer(host, stashName, { force: true }).catch(() => null);

  const newId = created?.Id || created?.id;
  if (!newId) throw new Error("Container recreate did not return an id");
  if (wasRunning) await startContainer(host, newId);
  return { id: newId, name, restarted: wasRunning };
}

function sanitizeHostConfig(hc) {
  if (!hc || typeof hc !== "object") return undefined;
  const keep = [
    "Binds", "PortBindings", "RestartPolicy", "NetworkMode", "Privileged",
    "PublishAllPorts", "ShmSize", "Memory", "NanoCpus", "CpuShares",
    "CapAdd", "CapDrop", "Devices", "Dns", "DnsSearch", "ExtraHosts",
    "Mounts", "LogConfig", "SecurityOpt", "Sysctls", "Ulimits",
  ];
  const out = {};
  for (const k of keep) {
    if (hc[k] != null) out[k] = hc[k];
  }
  return out;
}

/** Write TLS files and return { env, cleanup } for spawning docker CLI. */
export function withDockerCliEnv(host) {
  if (!host?.skipTlsVerify && !hasClientCerts(host)) {
    throw new Error("Host TLS materials are incomplete");
  }
  const certDir = writeTlsDir(host);
  return {
    env: dockerHostEnv(host, certDir),
    cleanup: () => cleanupDir(certDir),
  };
}

function dockerHostEnv(host, certDir) {
  const ep = String(host.endpoint).replace(/^https:\/\//i, "tcp://").replace(/^http:\/\//i, "tcp://");
  const env = {
    ...process.env,
    DOCKER_HOST: ep.startsWith("tcp://") ? ep : `tcp://${ep}`,
    // Docker treats DOCKER_TLS_VERIFY as a boolean-by-presence variable:
    // even the string "0" enables verification. Use DOCKER_TLS for encrypted
    // transport without server verification, and remove inherited verify state.
    DOCKER_TLS: "1",
  };
  if (host.skipTlsVerify) delete env.DOCKER_TLS_VERIFY;
  else env.DOCKER_TLS_VERIFY = "1";
  if (certDir) env.DOCKER_CERT_PATH = certDir;
  else {
    delete env.DOCKER_CERT_PATH;
  }
  return env;
}

function runCmd(cmd, args, { cwd, env, onLine } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env, shell: false });
    let stdout = "";
    let stderr = "";
    const handle = (buf, which) => {
      const text = buf.toString();
      if (which === "out") stdout += text;
      else stderr += text;
      if (onLine) {
        for (const line of text.split(/\r?\n/).filter(Boolean)) onLine(line);
      }
    };
    child.stdout.on("data", (d) => handle(d, "out"));
    child.stderr.on("data", (d) => handle(d, "err"));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr, code });
      else reject(new Error(stderr.trim() || stdout.trim() || `${cmd} exited ${code}`));
    });
  });
}

async function prepareWorkdir({ source, onLine }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-compose-"));
  if (source?.type === "git") {
    const url = String(source.gitUrl || "").trim();
    if (!url) throw new Error("Git URL is required");
    const branch = String(source.branch || "").trim();
    const token = String(source.gitToken || "").trim();
    let cloneUrl = url;
    if (token && /^https:\/\//i.test(url)) {
      cloneUrl = url.replace(/^https:\/\//i, `https://x-access-token:${encodeURIComponent(token)}@`);
    }
    const args = ["clone", "--depth", "1"];
    if (branch) args.push("--branch", branch);
    args.push(cloneUrl, "repo");
    onLine?.(`Cloning ${url}${branch ? ` @ ${branch}` : ""}…`);
    await runCmd("git", args, { cwd: dir, onLine });
    const repoDir = path.join(dir, "repo");
    const rel = String(source.composePath || "").trim().replace(/^\/+/, "");
    const candidates = rel
      ? [path.join(repoDir, rel)]
      : [
        path.join(repoDir, "docker-compose.yml"),
        path.join(repoDir, "docker-compose.yaml"),
        path.join(repoDir, "compose.yml"),
        path.join(repoDir, "compose.yaml"),
      ];
    const found = candidates.find((p) => fs.existsSync(p));
    if (!found) throw new Error("Compose file not found in repository");
    const composeDir = path.dirname(found);
    const composeFile = path.basename(found);
    return { root: dir, workdir: composeDir, composeFile, cleanup: () => cleanupDir(dir) };
  }

  const yaml = String(source?.composeYaml || "").trim();
  if (!yaml) throw new Error("Compose YAML is required");
  const composeFile = "docker-compose.yml";
  fs.writeFileSync(path.join(dir, composeFile), yaml);
  if (source?.envFile) {
    fs.writeFileSync(path.join(dir, ".env"), String(source.envFile));
  }
  return { root: dir, workdir: dir, composeFile, cleanup: () => cleanupDir(dir) };
}

/**
 * Run `docker compose … up -d` against a remote Engine.
 * @param {object} opts
 * @param {object} opts.host - full host with TLS
 * @param {string} opts.project
 * @param {object} opts.source - { type: 'paste'|'git', … }
 * @param {(line: string) => void} [opts.onLine]
 */
export async function composeUp({ host, project, source, onLine }) {
  const projectName = validateProjectName(project);
  if (!host?.skipTlsVerify && !hasClientCerts(host)) {
    throw new Error("Host TLS materials are incomplete");
  }
  const certDir = writeTlsDir(host);
  const prepared = await prepareWorkdir({ source, onLine });
  try {
    const args = ["compose", "-p", projectName, "-f", prepared.composeFile];
    if (source?.type !== "git" && source?.envFile) {
      args.push("--env-file", ".env");
    } else if (fs.existsSync(path.join(prepared.workdir, ".env"))) {
      args.push("--env-file", ".env");
    }
    args.push("up", "-d");
    if (host.skipTlsVerify) onLine?.("TLS verification disabled for this host");
    onLine?.(`Running: docker ${args.join(" ")}`);
    await runCmd("docker", args, {
      cwd: prepared.workdir,
      env: dockerHostEnv(host, certDir),
      onLine,
    });
    return { project: projectName };
  } finally {
    prepared.cleanup();
    cleanupDir(certDir);
  }
}
