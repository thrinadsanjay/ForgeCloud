import { prisma, fireAndForget } from "../db/client.js";
import { nanoid } from "nanoid";

const MAX_MESSAGES = 120;
const MAX_SESSIONS_PER_USER = 40;

/** @type {Record<string, Record<string, object>>} */
let sessionsByUser = {};

function cloneMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages.slice(-MAX_MESSAGES).map((m) => {
    const out = { role: m.role, text: String(m.text || "") };
    if (m.proposal) out.proposal = m.proposal;
    if (m.resourceList) out.resourceList = m.resourceList;
    if (m.resources) out.resources = m.resources;
    if (m.job) out.job = m.job;
    if (Array.isArray(m.suggestedReplies) && m.suggestedReplies.length) {
      out.suggestedReplies = m.suggestedReplies.slice(0, 8);
    }
    return out;
  });
}

function previewFromMessages(messages) {
  const firstUser = (messages || []).find((m) => m.role === "user" && m.text);
  if (!firstUser) return "";
  const t = String(firstUser.text).replace(/\s+/g, " ").trim();
  return t.length > 80 ? `${t.slice(0, 79)}…` : t;
}

function titleFromMessages(messages, fallback = "New chat") {
  const preview = previewFromMessages(messages);
  if (!preview) return fallback;
  return preview.length > 48 ? `${preview.slice(0, 47)}…` : preview;
}

function toPublicSession(session, { includeMessages = false } = {}) {
  const messages = Array.isArray(session.messages) ? session.messages : [];
  const out = {
    id: session.id,
    title: session.title || "New chat",
    updatedAt: session.updatedAt instanceof Date ? session.updatedAt.toISOString() : session.updatedAt,
    createdAt: session.createdAt instanceof Date ? session.createdAt.toISOString() : session.createdAt,
    preview: previewFromMessages(messages),
    messageCount: messages.length,
  };
  if (includeMessages) out.messages = messages;
  return out;
}

function ensureUserBucket(username) {
  if (!sessionsByUser[username]) sessionsByUser[username] = {};
  return sessionsByUser[username];
}

export async function hydrateChats() {
  const rows = await prisma.chatSession.findMany({
    orderBy: [{ username: "asc" }, { updatedAt: "desc" }],
  });
  sessionsByUser = {};
  for (const row of rows) {
    const bucket = ensureUserBucket(row.username);
    bucket[row.id] = {
      id: row.id,
      username: row.username,
      title: row.title || "New chat",
      messages: Array.isArray(row.messages) ? row.messages : [],
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}

async function persistSession(session) {
  await prisma.chatSession.upsert({
    where: { id: session.id },
    create: {
      id: session.id,
      username: session.username,
      title: session.title || "New chat",
      messages: session.messages || [],
      createdAt: session.createdAt || new Date(),
      updatedAt: session.updatedAt || new Date(),
    },
    update: {
      title: session.title || "New chat",
      messages: session.messages || [],
      updatedAt: session.updatedAt || new Date(),
    },
  });
}

function trimSessions(username) {
  const bucket = ensureUserBucket(username);
  const ids = Object.values(bucket)
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
    .map((s) => s.id);
  if (ids.length <= MAX_SESSIONS_PER_USER) return;
  const drop = ids.slice(MAX_SESSIONS_PER_USER);
  for (const id of drop) {
    delete bucket[id];
    fireAndForget(prisma.chatSession.delete({ where: { id } }).catch(() => {}), "chat-session-trim");
  }
}

export function listSessions(username) {
  const bucket = ensureUserBucket(username);
  return Object.values(bucket)
    .filter((s) => (s.messages || []).some((m) => m.role === "user"))
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
    .map((s) => toPublicSession(s));
}

export function getSession(username, sessionId) {
  const session = ensureUserBucket(username)[sessionId];
  if (!session || session.username !== username) return null;
  return toPublicSession(session, { includeMessages: true });
}

export function createSession(username, { title } = {}) {
  const now = new Date();
  const session = {
    id: nanoid(12),
    username,
    title: title || "New chat",
    messages: [],
    createdAt: now,
    updatedAt: now,
  };
  ensureUserBucket(username)[session.id] = session;
  trimSessions(username);
  fireAndForget(persistSession(session), "chat-session-create");
  return toPublicSession(session, { includeMessages: true });
}

export function saveSession(username, sessionId, { messages, title } = {}) {
  const bucket = ensureUserBucket(username);
  const existing = bucket[sessionId];
  if (!existing || existing.username !== username) return null;

  const nextMessages = messages != null ? cloneMessages(messages) : existing.messages;
  let nextTitle = existing.title || "New chat";
  if (typeof title === "string" && title.trim()) {
    nextTitle = title.trim().slice(0, 80);
  } else if ((!existing.title || existing.title === "New chat") && nextMessages.some((m) => m.role === "user")) {
    nextTitle = titleFromMessages(nextMessages);
  }

  const session = {
    ...existing,
    title: nextTitle,
    messages: nextMessages,
    updatedAt: new Date(),
  };
  bucket[sessionId] = session;
  fireAndForget(persistSession(session), "chat-session-save");
  return toPublicSession(session, { includeMessages: true });
}

export function deleteSession(username, sessionId) {
  const bucket = ensureUserBucket(username);
  const existing = bucket[sessionId];
  if (!existing) return false;
  delete bucket[sessionId];
  fireAndForget(prisma.chatSession.delete({ where: { id: sessionId } }).catch(() => {}), "chat-session-delete");
  return true;
}

export function clearAllSessions(username) {
  const bucket = ensureUserBucket(username);
  const ids = Object.keys(bucket);
  sessionsByUser[username] = {};
  if (ids.length) {
    fireAndForget(prisma.chatSession.deleteMany({ where: { username } }), "chat-sessions-clear");
  }
  return true;
}

// --- Legacy shims (single-thread APIs) kept briefly for older clients ---
export function getChat(username) {
  const list = listSessions(username);
  if (!list.length) return [];
  const full = getSession(username, list[0].id);
  return full?.messages || [];
}

export function saveChat(username, messages) {
  const list = listSessions(username);
  if (list.length) {
    const saved = saveSession(username, list[0].id, { messages });
    return saved?.messages || [];
  }
  const created = createSession(username);
  const saved = saveSession(username, created.id, { messages });
  return saved?.messages || [];
}

export function clearChat(username) {
  return clearAllSessions(username);
}

function classifyIntent(text) {
  const t = String(text || "").toLowerCase();
  if (!t.trim()) return "Other";
  if (/\b(llm|gpt|ai model|inference|fine-?tun|cuda|gpu)\b/.test(t)) return "AI / LLM";
  if (/\b(k8s|k3s|kubernetes|docker|container|lxc)\b/.test(t)) return "Containers / K8s";
  if (/\b(nfs|file share|storage|backup|media)\b/.test(t)) return "Storage";
  if (/\b(postgres|mysql|mongo|redis|database|db)\b/.test(t)) return "Database";
  if (/\b(wordpress|website|web app|nginx|php|node\.?js|static site)\b/.test(t)) return "Web app";
  if (/\b(stack|mern|mean|lamp)\b/.test(t)) return "Stack";
  if (/\b(list|reboot|shutdown|status|delete|extend)\b/.test(t)) return "Lifecycle";
  if (/\b(vm|virtual machine|server|redhat|rhel|ubuntu)\b/.test(t)) return "VM";
  return "Other";
}

function proposalFingerprint(p) {
  if (!p) return "";
  return [
    p.kind, p.templateId, p.stackId, p.cpu, p.memoryGB, p.additionalDiskGB,
    p.environment, p.size, p.ttlDays, p.permanent,
    (p.packages || []).join(","),
  ].join("|");
}

function diffProposalFields(prev, next) {
  if (!prev || !next) return [];
  const fields = [];
  const check = (key, label) => {
    const a = prev[key];
    const b = next[key];
    if (Array.isArray(a) || Array.isArray(b)) {
      if (JSON.stringify(a || []) !== JSON.stringify(b || [])) fields.push(label);
      return;
    }
    if (String(a ?? "") !== String(b ?? "")) fields.push(label);
  };
  check("kind", "kind");
  check("templateId", "template");
  check("stackId", "stack");
  check("cpu", "cpu");
  check("memoryGB", "memory");
  check("additionalDiskGB", "disk");
  check("environment", "network");
  check("size", "size");
  check("ttlDays", "lifetime");
  check("permanent", "lifetime");
  check("packages", "packages");
  check("hostname", "hostname");
  check("hostnamePrefix", "hostname");
  return fields;
}

function sessionWasApproved(messages) {
  return (messages || []).some((m) =>
    m.role === "assistant" &&
    /Provisioning started|Tracking as job|exceeds the size policy|awaiting admin approval/i.test(m.text || "")
  );
}

/** Aggregate Forge Assist usage across all users (admin). */
export function getChatAnalytics() {
  const intentCounts = {};
  const kindCounts = {};
  const modifiedFieldCounts = {};
  let sessionsWithUser = 0;
  let proposalsShown = 0;
  let approved = 0;
  let dropOffs = 0;
  let totalMessages = 0;

  for (const bucket of Object.values(sessionsByUser)) {
    for (const session of Object.values(bucket)) {
      const messages = Array.isArray(session.messages) ? session.messages : [];
      if (!messages.some((m) => m.role === "user")) continue;
      sessionsWithUser += 1;
      totalMessages += messages.length;

      const firstUser = messages.find((m) => m.role === "user" && m.text);
      if (firstUser) {
        const intent = classifyIntent(firstUser.text);
        intentCounts[intent] = (intentCounts[intent] || 0) + 1;
      }

      const proposals = messages.filter((m) => m.proposal).map((m) => m.proposal);
      if (proposals.length) {
        proposalsShown += 1;
        const lastKind = proposals[proposals.length - 1]?.kind || "vm";
        kindCounts[lastKind] = (kindCounts[lastKind] || 0) + 1;
        if (sessionWasApproved(messages)) approved += 1;
        else dropOffs += 1;
      }

      let prev = null;
      for (const p of proposals) {
        if (prev && proposalFingerprint(prev) !== proposalFingerprint(p)) {
          for (const field of diffProposalFields(prev, p)) {
            modifiedFieldCounts[field] = (modifiedFieldCounts[field] || 0) + 1;
          }
        }
        prev = p;
      }
    }
  }

  const toSorted = (obj) =>
    Object.entries(obj)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count);

  return {
    summary: {
      sessions: sessionsWithUser,
      messages: totalMessages,
      proposalsShown,
      approved,
      dropOffs,
      approveRate: proposalsShown ? Math.round((approved / proposalsShown) * 100) : 0,
    },
    topIntents: toSorted(intentCounts),
    proposalsByKind: toSorted(kindCounts),
    mostModifiedFields: toSorted(modifiedFieldCounts),
  };
}
