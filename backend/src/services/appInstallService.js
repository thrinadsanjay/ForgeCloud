import fs from "fs";
import fsPromises from "fs/promises";
import os from "os";
import path from "path";
import { spawn } from "child_process";
import { getAppBlueprint } from "./appCatalogService.js";
import { resolveContentPath, assertContentReadyForApps, rolesPathEnv } from "./ansibleContentService.js";
import { ansibleRoot, ansibleServiceConfig } from "./ansibleService.js";
import { runSsh } from "./sshRunner.js";
import { generatePassword } from "./passwordGen.js";
import { normalizeSshPrivateKey, describePrivateKeyProblem } from "./sshKeyNormalize.js";

function runProcess(cmd, args, { cwd, env, timeoutMs = 600_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, windowsHide: true });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      resolve({ code: 124, stdout, stderr: `${stderr}\n(timeout)` });
    }, timeoutMs);
    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: 127, stdout, stderr: err.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

async function runContentPlaybook({ playbookRel, host, port, ansibleUser, password, privateKeyPem, vars, onOutput }) {
  const playbook = resolveContentPath(playbookRel);
  if (!fs.existsSync(playbook)) throw new Error(`Playbook not found: ${playbookRel}`);
  const cfgRoot = ansibleRoot();
  const cfg = path.join(cfgRoot, "ansible.cfg");
  const tmp = await fsPromises.mkdtemp(path.join(os.tmpdir(), "forge-app-ansible-"));
  const inventoryPath = path.join(tmp, "hosts.ini");
  const varsPath = path.join(tmp, "vars.json");
  const keyPath = path.join(tmp, "key");
  await fsPromises.writeFile(inventoryPath, `[guests]\n${host} ansible_host=${host} ansible_port=${port} ansible_user=${ansibleUser}\n`);
  await fsPromises.writeFile(varsPath, JSON.stringify(vars || {}, null, 2));
  const args = [playbook, "-i", inventoryPath, "-e", `@${varsPath}`];
  const env = { ANSIBLE_CONFIG: cfg, ANSIBLE_ROLES_PATH: rolesPathEnv() };
  if (privateKeyPem) {
    const problem = describePrivateKeyProblem(privateKeyPem);
    if (problem) {
      return { ok: false, code: 2, stdout: "", stderr: problem };
    }
    const normalized = normalizeSshPrivateKey(privateKeyPem);
    await fsPromises.writeFile(keyPath, normalized.endsWith("\n") ? normalized : `${normalized}\n`, { mode: 0o600 });
    args.push("--private-key", keyPath);
  }
  if (password) {
    args.push("-e", `ansible_password=${password}`);
  }
  const result = await runProcess("ansible-playbook", args, { cwd: path.dirname(playbook), env });
  if (onOutput) {
    for (const line of `${result.stdout}\n${result.stderr}`.split(/\r?\n/).filter((l) => l.trim())) onOutput(line);
  }
  await fsPromises.rm(tmp, { recursive: true, force: true }).catch(() => {});
  return { ok: result.code === 0, ...result };
}

function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\"'\"'`)}'`;
}

async function writeRemoteFile(sshOpts, remotePath, content) {
  const b64 = Buffer.from(content, "utf8").toString("base64");
  const dir = path.posix.dirname(remotePath);
  const cmd = `mkdir -p ${shellQuote(dir)} && echo ${shellQuote(b64)} | base64 -d > ${shellQuote(remotePath)}`;
  const r = await runSsh({ ...sshOpts, command: cmd, timeoutMs: 60_000 });
  if (r.code !== 0) throw new Error(r.stderr || r.stdout || "Failed to write remote file");
}

async function runComposeOnGuest({ sshOpts, composeRel, project, envMap, onOutput }) {
  const local = resolveContentPath(composeRel);
  if (!fs.existsSync(local)) throw new Error(`Compose file not found: ${composeRel}`);
  const localDir = path.dirname(local);
  const remoteDir = `/opt/forge-apps/${project}`;
  const remoteCompose = `${remoteDir}/docker-compose.yml`;

  // Copy compose plus any sibling files (e.g. prometheus.yml) the stack may mount.
  const entries = await fsPromises.readdir(localDir);
  for (const name of entries) {
    if (name === "defaults.yml") continue;
    const full = path.join(localDir, name);
    const st = await fsPromises.stat(full);
    if (!st.isFile()) continue;
    const content = await fsPromises.readFile(full, "utf8");
    const remoteName = name === path.basename(local) ? "docker-compose.yml" : name;
    await writeRemoteFile(sshOpts, `${remoteDir}/${remoteName}`, content);
  }

  // Ensure compose file exists even if basename differed
  if (!entries.includes(path.basename(local))) {
    const yaml = await fsPromises.readFile(local, "utf8");
    await writeRemoteFile(sshOpts, remoteCompose, yaml);
  }

  const envLines = Object.entries(envMap || {}).map(([k, v]) => `${k}=${v}`).join("\n");
  if (envLines) await writeRemoteFile(sshOpts, `${remoteDir}/.env`, envLines);
  onOutput?.(`docker compose -p ${project} up -d (${composeRel})`);
  const r = await runSsh({
    ...sshOpts,
    command: `cd ${shellQuote(remoteDir)} && docker compose -p ${shellQuote(project)} -f docker-compose.yml --env-file .env up -d 2>&1 || docker compose -p ${shellQuote(project)} -f docker-compose.yml up -d 2>&1`,
    timeoutMs: 600_000,
  });
  onOutput?.(r.stdout || r.stderr || "");
  if (r.code !== 0) throw new Error(r.stderr || r.stdout || "docker compose failed");
}

async function waitHealth({ ip, healthcheck, onOutput }) {
  const hc = healthcheck || {};
  const port = Number(hc.port) || 0;
  if (!port) return true;
  const timeoutSec = Number(hc.timeoutSec) || 90;
  const deadline = Date.now() + timeoutSec * 1000;
  const pathUrl = hc.path || "/";
  onOutput?.(`Waiting for ${hc.type || "tcp"} :${port}…`);
  while (Date.now() < deadline) {
    try {
      if (hc.type === "http") {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 4000);
        const res = await fetch(`http://${ip}:${port}${pathUrl}`, { signal: ctrl.signal }).catch(() => null);
        clearTimeout(t);
        if (res && res.ok) return true;
      } else {
        const { connect } = await import("net");
        const ok = await new Promise((resolve) => {
          const s = connect({ host: ip, port }, () => { s.end(); resolve(true); });
          s.on("error", () => resolve(false));
          s.setTimeout(3000, () => { s.destroy(); resolve(false); });
        });
        if (ok) return true;
      }
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 3000));
  }
  return false;
}

function endpointFor(app, ip, notes) {
  if (!app.urlTemplate || !ip) return null;
  const url = app.urlTemplate.replace(/\{ip\}/gi, ip);
  return {
    id: app.id,
    name: app.name,
    url,
    port: (app.ports || [])[0] || null,
    notes: notes || null,
  };
}

async function runComposeYamlOnGuest({ sshOpts, yaml, project, envMap, onOutput }) {
  const remoteDir = `/opt/forge-apps/${project}`;
  const remoteCompose = `${remoteDir}/docker-compose.yml`;
  await writeRemoteFile(sshOpts, remoteCompose, yaml);
  const envLines = Object.entries(envMap || {}).map(([k, v]) => `${k}=${v}`).join("\n");
  if (envLines) await writeRemoteFile(sshOpts, `${remoteDir}/.env`, envLines);
  onOutput?.(`docker compose -p ${project} up -d (custom)`);
  const r = await runSsh({
    ...sshOpts,
    command: `cd ${shellQuote(remoteDir)} && docker compose -p ${shellQuote(project)} -f docker-compose.yml --env-file .env up -d 2>&1 || docker compose -p ${shellQuote(project)} -f docker-compose.yml up -d 2>&1`,
    timeoutMs: 600_000,
  });
  onOutput?.(r.stdout || r.stderr || "");
  if (r.code !== 0) throw new Error(r.stderr || r.stdout || "docker compose failed");
}

/**
 * Install resolved apps on a guest after OS bootstrap.
 * @returns {{ endpoints: object[], secrets: object, steps: object[], failedApps: string[] }}
 */
export async function installAppsOnGuest({
  resolvedAppIds,
  ip,
  sshOpts,
  onOutput,
  customCompose,
  continueOnError = false,
}) {
  assertContentReadyForApps();
  const endpoints = [];
  const secrets = {};
  const steps = [];
  const failedApps = [];
  const cfg = ansibleServiceConfig();

  for (const id of resolvedAppIds || []) {
    const app = getAppBlueprint(id);
    if (!app) {
      if (continueOnError) { failedApps.push(id); continue; }
      throw new Error(`Unknown app ${id}`);
    }
    try {
      onOutput?.(`Installing app: ${app.name} (${app.strategy})`);

      if (app.strategy === "ansible" || app.strategy === "ansible+compose") {
        if (!app.ansiblePlaybook) throw new Error(`${app.id}: ansiblePlaybook missing`);
        const result = await runContentPlaybook({
          playbookRel: app.ansiblePlaybook,
          host: ip,
          port: sshOpts.port || 22,
          ansibleUser: sshOpts.username,
          password: sshOpts.password,
          privateKeyPem: sshOpts.privateKey,
          vars: {
            forge_service_user: cfg.serviceUser || sshOpts.username,
            ...(app.defaultVars || {}),
          },
          onOutput,
        });
        steps.push({ name: `app:${app.id}:ansible`, ok: result.ok, output: (result.stdout || "").slice(0, 4000) });
        if (!result.ok) throw new Error(`${app.name} Ansible failed: ${result.stderr || result.stdout}`);
      }

      let notes = null;
      if (app.strategy === "compose" || app.strategy === "ansible+compose") {
        if (!app.composePath) throw new Error(`${app.id}: composePath missing`);
        const envMap = { ...(app.defaultVars || {}) };
        if (app.id === "grafana" || app.id === "grafana-influx" || app.id === "prometheus-stack") {
          secrets.grafanaAdminPassword = generatePassword(16);
          envMap.GRAFANA_ADMIN_PASSWORD = secrets.grafanaAdminPassword;
          notes = `admin / ${secrets.grafanaAdminPassword}`;
        }
        if (app.id === "influxdb" || app.id === "grafana-influx") {
          secrets.influxAdminPassword = generatePassword(16);
          envMap.INFLUX_ADMIN_PASSWORD = secrets.influxAdminPassword;
          notes = notes
            ? `${notes}; Influx admin / ${secrets.influxAdminPassword}`
            : `admin / ${secrets.influxAdminPassword}`;
        }
        if (app.id === "docker-dev" || app.id === "code-server") {
          secrets.codeServerPassword = generatePassword(16);
          envMap.CODE_SERVER_PASSWORD = secrets.codeServerPassword;
          notes = `password / ${secrets.codeServerPassword}`;
        }
        await runComposeOnGuest({
          sshOpts,
          composeRel: app.composePath,
          project: app.id,
          envMap,
          onOutput,
        });
        steps.push({ name: `app:${app.id}:compose`, ok: true });
      }

      const healthy = await waitHealth({ ip, healthcheck: app.healthcheck, onOutput });
      if (!healthy && (app.healthcheck?.port > 0)) {
        onOutput?.(`Warning: ${app.name} health check timed out — URL may still come up shortly`);
      }
      const ep = endpointFor(app, ip, notes);
      if (ep) {
        if (secrets.grafanaAdminPassword && (app.id === "grafana" || app.id === "grafana-influx" || app.id === "prometheus-stack")) {
          ep.notes = `Grafana admin / ${secrets.grafanaAdminPassword}`;
        }
        if (secrets.influxAdminPassword && (app.id === "influxdb" || app.id === "grafana-influx")) {
          ep.notes = ep.notes
            ? `${ep.notes}; Influx admin / ${secrets.influxAdminPassword}`
            : `Influx admin / ${secrets.influxAdminPassword}`;
        }
        if (secrets.codeServerPassword && (app.id === "docker-dev" || app.id === "code-server")) {
          ep.notes = `password / ${secrets.codeServerPassword}`;
        }
        endpoints.push(ep);
      }
    } catch (err) {
      steps.push({ name: `app:${id}`, ok: false, error: err.message });
      failedApps.push(id);
      if (!continueOnError) throw err;
      onOutput?.(`App ${id} failed: ${err.message}`);
    }
  }

  // Optional one-off compose pasted in the provision form.
  if (customCompose?.yaml && String(customCompose.yaml).trim()) {
    const project = String(customCompose.project || "custom")
      .toLowerCase()
      .replace(/[^a-z0-9-_]/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "custom";
    try {
      onOutput?.(`Installing custom compose (${project})…`);
      await runComposeYamlOnGuest({
        sshOpts,
        yaml: String(customCompose.yaml),
        project,
        envMap: customCompose.env && typeof customCompose.env === "object" ? customCompose.env : {},
        onOutput,
      });
      steps.push({ name: `app:custom:${project}:compose`, ok: true });
      endpoints.push({
        id: `custom-${project}`,
        name: customCompose.name || `Custom (${project})`,
        url: null,
        port: null,
        notes: "Deployed via custom compose on the guest",
      });
    } catch (err) {
      steps.push({ name: `app:custom:${project}`, ok: false, error: err.message });
      failedApps.push(`custom:${project}`);
      if (!continueOnError) throw err;
    }
  }

  return { endpoints, secrets, steps, failedApps };
}
