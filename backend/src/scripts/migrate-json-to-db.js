import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { prisma } from "../db/client.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "..", "data");

function readJson(file, fallback) {
  const p = path.join(DATA_DIR, file);
  if (!fs.existsSync(p)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch {
    return fallback;
  }
}

export async function importJsonIfPresent() {
  if (!fs.existsSync(DATA_DIR)) return;

  const userCount = await prisma.user.count();
  if (userCount === 0) {
    const { users = [] } = readJson("users.json", {});
    for (const u of users) {
      await prisma.user.create({
        data: {
          id: u.id,
          username: u.username,
          displayName: u.displayName,
          email: u.email,
          role: u.role,
          source: u.source,
          passwordHash: u.passwordHash,
          preferences: u.preferences || {},
          createdAt: new Date(u.createdAt),
        },
      });
    }
    if (users.length) console.log(`[import] ${users.length} users`);
  }

  const settingCount = await prisma.setting.count();
  if (settingCount === 0) {
    const settings = readJson("settings.json", {});
    const entries = Object.entries(settings);
    for (const [key, value] of entries) {
      await prisma.setting.create({ data: { key, value: String(value) } });
    }
    if (entries.length) console.log(`[import] ${entries.length} settings`);
  }

  const patCount = await prisma.personalAccessToken.count();
  if (patCount === 0) {
    const { pats = [] } = readJson("pats.json", {});
    for (const p of pats) {
      await prisma.personalAccessToken.create({
        data: {
          id: p.id,
          name: p.name,
          username: p.username,
          role: p.role,
          prefix: p.prefix,
          tokenHash: p.tokenHash,
          createdAt: new Date(p.createdAt),
          lastUsedAt: p.lastUsedAt ? new Date(p.lastUsedAt) : null,
          expiresAt: p.expiresAt ? new Date(p.expiresAt) : null,
        },
      });
    }
    if (pats.length) console.log(`[import] ${pats.length} PATs`);
  }

  const groupCount = await prisma.group.count();
  if (groupCount === 0) {
    const { groups = {} } = readJson("groups.json", {});
    for (const [name, g] of Object.entries(groups)) {
      await prisma.group.create({
        data: { name, members: g.members || [], createdAt: new Date(g.createdAt || Date.now()) },
      });
    }
    if (Object.keys(groups).length) console.log(`[import] ${Object.keys(groups).length} groups`);
  }

  const mapCount = await prisma.templateMapping.count();
  if (mapCount === 0) {
    const { templates = {}, networks = {} } = readJson("mappings.json", {});
    for (const [vmid, m] of Object.entries(templates)) {
      await prisma.templateMapping.create({
        data: {
          vmid: Number(vmid),
          osName: m.osName,
          credUser: m.credUser,
          credPassword: m.credPassword,
          connectivity: m.connectivity,
          port: m.port,
          packageManager: m.packageManager,
          cloudInitFile: m.cloudInitFile,
          cloudInitSource: m.cloudInitSource,
          updatedAt: m.updatedAt ? new Date(m.updatedAt) : null,
        },
      });
    }
    for (const [iface, m] of Object.entries(networks)) {
      await prisma.networkMapping.create({
        data: {
          iface,
          label: m.label,
          type: m.type,
          updatedAt: m.updatedAt ? new Date(m.updatedAt) : null,
        },
      });
    }
    const t = Object.keys(templates).length;
    const n = Object.keys(networks).length;
    if (t || n) console.log(`[import] ${t} template mappings, ${n} network mappings`);
  }

  const jobCount = await prisma.deploymentJob.count();
  if (jobCount === 0) {
    const { jobs = [] } = readJson("jobs.json", {});
    for (const j of jobs) {
      await prisma.deploymentJob.create({
        data: {
          id: j.id,
          type: j.type,
          status: j.status,
          data: j,
          createdAt: new Date(j.createdAt),
          updatedAt: new Date(j.updatedAt),
        },
      });
    }
    if (jobs.length) console.log(`[import] ${jobs.length} jobs`);
  }

  const reqCount = await prisma.provisionRequest.count();
  if (reqCount === 0) {
    const { requests = [] } = readJson("requests.json", {});
    for (const r of requests) {
      await prisma.provisionRequest.create({
        data: {
          id: r.id,
          kind: r.kind,
          status: r.status,
          requestedBy: r.requestedBy,
          data: r,
          createdAt: new Date(r.createdAt),
          updatedAt: new Date(r.updatedAt),
        },
      });
    }
    if (requests.length) console.log(`[import] ${requests.length} requests`);
  }

  const ownerCount = await prisma.resourceOwnership.count();
  if (ownerCount === 0) {
    const { owners = {} } = readJson("ownership.json", {});
    for (const [vmid, o] of Object.entries(owners)) {
      await prisma.resourceOwnership.create({
        data: {
          vmid: Number(vmid),
          username: o.username,
          hostname: o.hostname,
          ip: o.ip,
          createdAt: new Date(o.createdAt || Date.now()),
        },
      });
    }
    if (Object.keys(owners).length) console.log(`[import] ${Object.keys(owners).length} ownership records`);
  }

  const expiryCount = await prisma.resourceExpiry.count();
  if (expiryCount === 0) {
    const { expiry = {} } = readJson("expiry.json", {});
    for (const [vmid, e] of Object.entries(expiry)) {
      await prisma.resourceExpiry.create({
        data: {
          vmid: Number(vmid),
          expiresAt: new Date(e.expiresAt),
          setBy: e.setBy,
          ttlDays: e.ttlDays,
          type: e.type,
          updatedAt: new Date(e.updatedAt || Date.now()),
        },
      });
    }
    if (Object.keys(expiry).length) console.log(`[import] ${Object.keys(expiry).length} expiry records`);
  }

  const auditCount = await prisma.auditEntry.count();
  if (auditCount === 0) {
    const { entries = [] } = readJson("audit.json", {});
    for (const e of entries) {
      await prisma.auditEntry.create({
        data: {
          id: e.id,
          timestamp: new Date(e.timestamp),
          actor: e.actor,
          action: e.action,
          target: e.target || "",
          status: e.status,
          detail: e.detail || {},
        },
      });
    }
    if (entries.length) console.log(`[import] ${entries.length} audit entries`);
  }

  const notifCount = await prisma.notification.count();
  if (notifCount === 0) {
    const { notifications = [] } = readJson("notifications.json", {});
    for (const n of notifications) {
      await prisma.notification.create({
        data: {
          id: n.id,
          recipient: n.recipient,
          role: n.role,
          type: n.type,
          title: n.title,
          message: n.message,
          link: n.link,
          meta: n.meta || {},
          read: n.read,
          createdAt: new Date(n.createdAt),
        },
      });
    }
    if (notifications.length) console.log(`[import] ${notifications.length} notifications`);
  }

  const chatCount = await prisma.chatMessage.count();
  if (chatCount === 0) {
    const { chats = {} } = readJson("chats.json", {});
    for (const [username, messages] of Object.entries(chats)) {
      if (!Array.isArray(messages)) continue;
      await prisma.chatMessage.createMany({
        data: messages.map((m, i) => ({
          username,
          role: m.role,
          text: m.text,
          sortOrder: i,
        })),
      });
    }
    if (Object.keys(chats).length) console.log(`[import] chat history for ${Object.keys(chats).length} users`);
  }

  const timingCount = await prisma.stepTiming.count();
  if (timingCount === 0) {
    const { templates = {} } = readJson("step-timings.json", {});
    for (const [templateKey, steps] of Object.entries(templates)) {
      for (const [stepKey, rec] of Object.entries(steps)) {
        await prisma.stepTiming.create({
          data: {
            templateKey,
            stepKey,
            avgSec: rec.avgSec,
            lastSec: rec.lastSec,
            samples: rec.samples,
            updatedAt: new Date(rec.updatedAt || Date.now()),
          },
        });
      }
    }
    if (Object.keys(templates).length) console.log(`[import] step timings for ${Object.keys(templates).length} templates`);
  }

  const aiCount = await prisma.aiPlaybookCache.count();
  if (aiCount === 0) {
    const cache = readJson("ai-playbook.json", null);
    if (cache) {
      await prisma.aiPlaybookCache.create({
        data: { id: "default", plans: cache.plans || {}, troubleshoot: cache.troubleshoot || {} },
      });
      console.log("[import] AI playbook cache");
    }
  }
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}`) {
  const { connectDb } = await import("../db/client.js");
  const { syncSchema } = await import("../db/schemaSync.js");
  await connectDb();
  syncSchema();
  await importJsonIfPresent();
  console.log("[import] done");
  process.exit(0);
}
