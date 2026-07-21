import { spawn } from "child_process";
import fs from "fs";
import fsPromises from "fs/promises";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Repo ansible/ next to backend/, or /app/ansible in the container image. */
export function ansibleRoot() {
  const candidates = [
    process.env.ANSIBLE_ROOT,
    path.resolve(__dirname, "../../../ansible"),
    "/app/ansible",
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, "playbooks", "initial_setup.yml"))) {
      return candidate;
    }
  }
  return candidates[0];
}

export function isAnsibleEnabled() {
  return String(process.env.ANSIBLE_ENABLED || "false") === "true";
}

export function ansibleServiceConfig() {
  return {
    enabled: isAnsibleEnabled(),
    serviceUser: process.env.ANSIBLE_SERVICE_USER || "forge",
    servicePassword: process.env.ANSIBLE_SERVICE_PASSWORD || "",
    adminPubkey: process.env.ANSIBLE_ADMIN_PUBKEY || "",
    forgePrivateKey: process.env.ANSIBLE_FORGE_PRIVATE_KEY || "",
    forgePublicKey: process.env.ANSIBLE_FORGE_PUBLIC_KEY || "",
    removeForgeKey: String(process.env.ANSIBLE_REMOVE_FORGE_KEY || "true") !== "false",
    bootstrapCloudInit: String(process.env.ANSIBLE_BOOTSTRAP_CLOUDINIT || "true") !== "false",
  };
}

function runProcess(cmd, args, { cwd, env, timeoutMs = 600_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd,
      env: { ...process.env, ...env },
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      resolve({ code: 124, stdout, stderr: `${stderr}\n(timeout after ${timeoutMs}ms)` });
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

/**
 * Run the Forge initial_setup playbook against one guest.
 *
 * @param {object} opts
 * @param {string} opts.host - guest IP
 * @param {number} [opts.port]
 * @param {string} opts.ansibleUser
 * @param {string} [opts.password] - SSH password (optional if key set)
 * @param {string} [opts.privateKeyPem] - Forge deploy private key
 * @param {object} opts.vars - role variables
 * @param {(line: string) => void} [opts.onOutput]
 */
export async function runInitialSetup({
  host,
  port = 22,
  ansibleUser,
  password,
  privateKeyPem,
  vars = {},
  onOutput,
  timeoutMs = 600_000,
}) {
  const root = ansibleRoot();
  const playbook = path.join(root, "playbooks", "initial_setup.yml");
  const cfg = path.join(root, "ansible.cfg");

  await fsPromises.access(playbook).catch(() => {
    throw new Error(`Ansible playbook not found at ${playbook}`);
  });

  const tmp = await fsPromises.mkdtemp(path.join(os.tmpdir(), "forge-ansible-"));
  const inventoryPath = path.join(tmp, "hosts.ini");
  const varsPath = path.join(tmp, "vars.json");
  const keyPath = path.join(tmp, "forge_deploy_key");

  const inventory = [
    "[guests]",
    `${host} ansible_host=${host} ansible_port=${port} ansible_user=${ansibleUser}`,
  ].join("\n");

  await fsPromises.writeFile(inventoryPath, `${inventory}\n`, "utf8");
  await fsPromises.writeFile(varsPath, JSON.stringify(vars, null, 2), "utf8");

  const env = {
    ANSIBLE_CONFIG: cfg,
    ANSIBLE_ROLES_PATH: path.join(root, "roles"),
  };

  const args = [
    playbook,
    "-i", inventoryPath,
    "-e", `@${varsPath}`,
  ];

  if (privateKeyPem && String(privateKeyPem).trim()) {
    await fsPromises.writeFile(keyPath, `${String(privateKeyPem).trim()}\n`, { mode: 0o600 });
    args.push("--private-key", keyPath);
  }
  if (password) {
    args.push("-e", `ansible_password=${password}`);
    args.push("-e", "ansible_ssh_common_args='-o PreferredAuthentications=password,publickey'");
  }

  const result = await runProcess("ansible-playbook", args, {
    cwd: root,
    env,
    timeoutMs,
  });

  if (typeof onOutput === "function") {
    for (const line of `${result.stdout}\n${result.stderr}`.split(/\r?\n/)) {
      if (line.trim()) onOutput(line);
    }
  }

  // Best-effort cleanup of secrets on disk.
  await fsPromises.rm(tmp, { recursive: true, force: true }).catch(() => {});

  return {
    ok: result.code === 0,
    code: result.code,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

/**
 * Try mapping password auth, then mapping user + Forge key, then service-account + Forge key.
 */
export async function runInitialSetupWithFallback({
  host,
  port = 22,
  mappingUser,
  mappingPassword,
  vars,
  onOutput,
}) {
  const cfg = ansibleServiceConfig();
  const attempts = [];

  if (mappingUser && mappingPassword) {
    attempts.push({
      label: "mapping-credentials",
      ansibleUser: mappingUser,
      password: mappingPassword,
      privateKeyPem: null,
    });
  }

  // Many golden images disable password SSH; try the deploy key as the mapping user too.
  if (mappingUser && cfg.forgePrivateKey) {
    attempts.push({
      label: "mapping-user-forge-key",
      ansibleUser: mappingUser,
      password: null,
      privateKeyPem: cfg.forgePrivateKey,
    });
  }

  if (cfg.forgePrivateKey) {
    attempts.push({
      label: "forge-service-key",
      ansibleUser: cfg.serviceUser,
      password: cfg.servicePassword || null,
      privateKeyPem: cfg.forgePrivateKey,
    });
  }

  if (!attempts.length) {
    return {
      ok: false,
      code: 2,
      stdout: "",
      stderr: "No Ansible SSH credentials configured (mapping password or Forge deploy key).",
      attempt: null,
    };
  }

  let last = null;
  for (const attempt of attempts) {
    onOutput?.(`[ansible] trying ${attempt.label} as ${attempt.ansibleUser}@${host}`);
    last = await runInitialSetup({
      host,
      port,
      ansibleUser: attempt.ansibleUser,
      password: attempt.password,
      privateKeyPem: attempt.privateKeyPem,
      vars: {
        ...vars,
        service_account: cfg.serviceUser,
        remove_forge_key: cfg.removeForgeKey,
        forge_pubkey: cfg.forgePublicKey || "",
      },
      onOutput,
    });
    if (last.ok) {
      return { ...last, attempt: attempt.label };
    }
    onOutput?.(`[ansible] ${attempt.label} failed (exit ${last.code})`);
  }

  const combined = `${last?.stdout || ""}\n${last?.stderr || ""}`;
  const looksLikeSshFailure = /UNREACHABLE|Permission denied|Failed to connect to the host via ssh|No Ansible SSH credentials/i.test(combined);
  if (looksLikeSshFailure) {
    const hint = [
      "Ansible could not SSH into the guest.",
      "Ensure Admin → Automation → Ansible has a matching Forge public/private key pair,",
      "and that bootstrap cloud-init can create the service account (template needs cloud-init).",
      "RHEL images often disable password login, so mapping root passwords alone are not enough.",
    ].join(" ");
    return {
      ...last,
      attempt: null,
      stderr: `${last?.stderr || ""}\n${hint}`.trim(),
    };
  }

  return { ...last, attempt: null };
}
