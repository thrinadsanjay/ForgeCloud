import { prisma, fireAndForget } from "../db/client.js";
import { completeText } from "./aiChatService.js";

let cache = { plans: {}, troubleshoot: {} };

export async function hydrateAiCache() {
  const row = await prisma.aiPlaybookCache.findUnique({ where: { id: "default" } });
  if (row) {
    cache = {
      plans: row.plans || {},
      troubleshoot: row.troubleshoot || {},
    };
  }
}

function writeCache(c) {
  cache = c;
  fireAndForget(
    prisma.aiPlaybookCache.upsert({
      where: { id: "default" },
      create: { id: "default", plans: c.plans, troubleshoot: c.troubleshoot },
      update: { plans: c.plans, troubleshoot: c.troubleshoot },
    }),
    "ai-cache"
  );
}

function readCache() {
  return cache;
}

const PM = {
  apt: { refresh: "apt-get update -y", install: (p) => `DEBIAN_FRONTEND=noninteractive apt-get install -y ${p}` },
  yum: { refresh: "yum makecache -y || true", install: (p) => `yum install -y ${p}` },
  dnf: { refresh: "dnf makecache -y || true", install: (p) => `dnf install -y ${p}` },
  apk: { refresh: "apk update", install: (p) => `apk add --no-cache ${p}` },
  zypper: { refresh: "zypper -n refresh || true", install: (p) => `zypper -n install ${p}` },
};

const shq = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;

export function buildInstallPlan({ packageManager, packages = [], username, password, sudo }) {
  const pm = PM[packageManager] || PM.apt;
  const pkgs = packages.filter(Boolean).join(" ");
  const steps = [];

  if (username) {
    steps.push({
      name: `create user ${username}`,
      cmd: `id ${shq(username)} >/dev/null 2>&1 || useradd -m -s /bin/bash ${shq(username)} 2>/dev/null || adduser -D ${shq(username)}`,
    });
    steps.push({
      name: "set user password",
      cmd: `echo ${shq(`${username}:${password}`)} | chpasswd 2>/dev/null || (echo ${shq(password)}; echo ${shq(password)}) | passwd ${shq(username)}`,
    });
    if (sudo) {
      steps.push({
        name: "grant sudo",
        cmd: `(usermod -aG sudo ${shq(username)} 2>/dev/null || usermod -aG wheel ${shq(username)} 2>/dev/null || true); ` +
          `printf '%s ALL=(ALL) NOPASSWD:ALL\\n' ${shq(username)} > /etc/sudoers.d/${username} && chmod 440 /etc/sudoers.d/${username}`,
      });
    }
  }

  if (pkgs) {
    steps.push({ name: "refresh package index", cmd: pm.refresh });
    steps.push({ name: `install packages (${pkgs})`, cmd: pm.install(pkgs) });
    steps.push({
      name: "enable services",
      cmd: `for s in ${pkgs}; do systemctl enable --now "$s" 2>/dev/null || rc-update add "$s" default 2>/dev/null || true; done`,
    });
  }

  return steps;
}

export function hostnameSetupCommand({ hostname }) {
  if (!hostname) return null;
  const h = shq(hostname);
  return [
    `hostnamectl set-hostname ${h} 2>/dev/null || (echo ${h} > /etc/hostname && hostname ${h})`,
    `if grep -q '^127.0.1.1' /etc/hosts 2>/dev/null; then sed -i "s/^127.0.1.1.*/127.0.1.1 ${hostname}/" /etc/hosts; else echo "127.0.1.1 ${hostname}" >> /etc/hosts; fi`,
  ].join("; ");
}

export function userSetupCommands({ username, password, sudo }) {
  if (!username) return [];
  const steps = [
    {
      name: `create user ${username}`,
      cmd: `id ${shq(username)} >/dev/null 2>&1 || useradd -m -s /bin/bash ${shq(username)} 2>/dev/null || adduser -D ${shq(username)}`,
    },
    {
      name: "set user password",
      cmd: `echo ${shq(`${username}:${password}`)} | chpasswd 2>/dev/null || (echo ${shq(password)}; echo ${shq(password)}) | passwd ${shq(username)}`,
    },
  ];
  if (sudo) {
    steps.push({
      name: "grant sudo",
      cmd: `(usermod -aG sudo ${shq(username)} 2>/dev/null || usermod -aG wheel ${shq(username)} 2>/dev/null || true); ` +
        `printf '%s ALL=(ALL) NOPASSWD:ALL\\n' ${shq(username)} > /etc/sudoers.d/${username} && chmod 440 /etc/sudoers.d/${username}`,
    });
  }
  return steps;
}

export function packageInstallCommand({ packageManager, packages = [] }) {
  const list = packages.filter(Boolean);
  if (!list.length) return null;
  const pm = PM[packageManager] || PM.apt;
  const pkgs = list.join(" ");
  return `${pm.refresh}; ${pm.install(pkgs)}; for s in ${pkgs}; do systemctl enable --now "$s" 2>/dev/null || rc-update add "$s" default 2>/dev/null || true; done`;
}

function errKey({ command, stderr }) {
  const sig = `${command}::${(stderr || "").slice(0, 200)}`;
  return sig.replace(/\s+/g, " ").trim().slice(0, 300);
}

export async function aiTroubleshoot({ command, stderr, osName, packageManager }) {
  const c = readCache();
  const key = errKey({ command, stderr });
  if (c.troubleshoot[key]) return c.troubleshoot[key];

  const prompt = `You are fixing a failed Linux provisioning step over SSH (root).
OS: ${osName || "unknown"}  Package manager: ${packageManager || "unknown"}
Command that failed:
${command}
stderr:
${(stderr || "").slice(0, 1200)}

Reply with STRICT JSON only: {"fix": "<a single non-interactive shell command that resolves the error, or null>", "note": "<short reason>"}.
Do not include markdown fences.`;

  try {
    const text = await completeText(prompt, { timeoutMs: 20000 });
    if (!text) return null;
    const json = JSON.parse(text.replace(/```json|```/g, "").trim());
    const result = json.fix ? { fix: String(json.fix), note: json.note || "" } : null;
    if (result) {
      c.troubleshoot[key] = result;
      writeCache(c);
    }
    return result;
  } catch {
    return null;
  }
}
