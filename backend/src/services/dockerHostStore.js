import { nanoid } from "nanoid";
import { prisma, fireAndForget } from "../db/client.js";
import { groupsForUser } from "./groupStore.js";
import { isAdminRole } from "../constants/roles.js";

const hosts = new Map();

function rowToHost(row) {
  return {
    id: row.id,
    name: row.name,
    endpoint: row.endpoint,
    tlsCa: row.tlsCa || "",
    tlsCert: row.tlsCert || "",
    tlsKey: row.tlsKey || "",
    skipTlsVerify: !!row.skipTlsVerify,
    teamTags: Array.isArray(row.teamTags) ? row.teamTags : [],
    appTags: Array.isArray(row.appTags) ? row.appTags : [],
    enabled: row.enabled !== false,
    createdAt: row.createdAt?.toISOString?.() || row.createdAt,
    updatedAt: row.updatedAt?.toISOString?.() || row.updatedAt,
  };
}

export async function hydrateDockerHosts() {
  const rows = await prisma.dockerHost.findMany();
  hosts.clear();
  for (const row of rows) {
    const h = rowToHost(row);
    hosts.set(h.id, h);
  }
}

function persist(host) {
  fireAndForget(
    prisma.dockerHost.upsert({
      where: { id: host.id },
      create: {
        id: host.id,
        name: host.name,
        endpoint: host.endpoint,
        tlsCa: host.tlsCa || "",
        tlsCert: host.tlsCert || "",
        tlsKey: host.tlsKey || "",
        skipTlsVerify: !!host.skipTlsVerify,
        teamTags: host.teamTags || [],
        appTags: host.appTags || [],
        enabled: host.enabled !== false,
        createdAt: new Date(host.createdAt),
      },
      update: {
        name: host.name,
        endpoint: host.endpoint,
        tlsCa: host.tlsCa || "",
        tlsCert: host.tlsCert || "",
        tlsKey: host.tlsKey || "",
        skipTlsVerify: !!host.skipTlsVerify,
        teamTags: host.teamTags || [],
        appTags: host.appTags || [],
        enabled: host.enabled !== false,
        updatedAt: new Date(),
      },
    }),
    "docker-host"
  );
}

/** Public view — never expose private key material. */
export function sanitizeHost(host, { includeCertMeta = true } = {}) {
  if (!host) return null;
  const out = {
    id: host.id,
    name: host.name,
    endpoint: host.endpoint,
    skipTlsVerify: !!host.skipTlsVerify,
    teamTags: host.teamTags || [],
    appTags: host.appTags || [],
    enabled: host.enabled !== false,
    createdAt: host.createdAt,
    updatedAt: host.updatedAt,
  };
  if (includeCertMeta) {
    out.tlsConfigured = !!(host.tlsCa && host.tlsCert && host.tlsKey);
  }
  return out;
}

export function listDockerHosts() {
  return Array.from(hosts.values()).sort((a, b) => a.name.localeCompare(b.name));
}

export function getDockerHost(id) {
  return hosts.get(id) || null;
}

/** Full record including TLS (server-side only). */
export function getDockerHostSecrets(id) {
  return hosts.get(id) || null;
}

function normalizeTags(input) {
  if (!input) return [];
  const arr = Array.isArray(input)
    ? input
    : String(input).split(/[,;\s]+/);
  return [...new Set(arr.map((t) => String(t).trim()).filter(Boolean))];
}

function normalizeEndpoint(endpoint) {
  let ep = String(endpoint || "").trim();
  if (!ep) throw new Error("Endpoint is required");
  if (!/^tcp:\/\//i.test(ep) && !/^https?:\/\//i.test(ep)) {
    ep = `tcp://${ep}`;
  }
  return ep;
}

export function createDockerHost(input) {
  const name = String(input.name || "").trim();
  if (!name) throw new Error("Name is required");
  const endpoint = normalizeEndpoint(input.endpoint);
  const skipTlsVerify = !!input.skipTlsVerify;
  const tlsCa = String(input.tlsCa || "").trim();
  const tlsCert = String(input.tlsCert || "").trim();
  const tlsKey = String(input.tlsKey || "").trim();
  if (!skipTlsVerify && (!tlsCa || !tlsCert || !tlsKey)) {
    throw new Error("TLS CA, certificate, and key are required (or enable Skip TLS verification)");
  }
  const now = new Date().toISOString();
  const host = {
    id: nanoid(10),
    name,
    endpoint,
    tlsCa,
    tlsCert,
    tlsKey,
    skipTlsVerify,
    teamTags: normalizeTags(input.teamTags),
    appTags: normalizeTags(input.appTags),
    enabled: input.enabled !== false,
    createdAt: now,
    updatedAt: now,
  };
  hosts.set(host.id, host);
  persist(host);
  return host;
}

export function updateDockerHost(id, input) {
  const host = hosts.get(id);
  if (!host) throw new Error("Docker host not found");
  if (input.name != null) {
    const name = String(input.name).trim();
    if (!name) throw new Error("Name is required");
    host.name = name;
  }
  if (input.endpoint != null) host.endpoint = normalizeEndpoint(input.endpoint);
  if (input.tlsCa != null && String(input.tlsCa).trim()) host.tlsCa = String(input.tlsCa).trim();
  if (input.tlsCert != null && String(input.tlsCert).trim()) host.tlsCert = String(input.tlsCert).trim();
  if (input.tlsKey != null && String(input.tlsKey).trim()) host.tlsKey = String(input.tlsKey).trim();
  if (input.skipTlsVerify != null) host.skipTlsVerify = !!input.skipTlsVerify;
  if (input.teamTags != null) host.teamTags = normalizeTags(input.teamTags);
  if (input.appTags != null) host.appTags = normalizeTags(input.appTags);
  if (input.enabled != null) host.enabled = !!input.enabled;

  if (!host.skipTlsVerify && !(host.tlsCa && host.tlsCert && host.tlsKey)) {
    throw new Error("TLS CA, certificate, and key are required when Skip TLS verification is off");
  }

  host.updatedAt = new Date().toISOString();
  persist(host);
  return host;
}

export function deleteDockerHost(id) {
  if (!hosts.has(id)) throw new Error("Docker host not found");
  hosts.delete(id);
  fireAndForget(prisma.dockerHost.delete({ where: { id } }), "docker-host-delete");
}

/**
 * Visibility: admins see all; users see enabled hosts whose teamTags intersect
 * their groups, or hosts with empty teamTags (open to all authenticated users).
 */
export function hostsVisibleTo(user) {
  const all = listDockerHosts().filter((h) => h.enabled);
  if (isAdminRole(user?.role)) return all;
  const groups = new Set(groupsForUser(user?.username).map((g) => g.toLowerCase()));
  return all.filter((h) => {
    const tags = (h.teamTags || []).map((t) => String(t).toLowerCase());
    if (tags.length === 0) return true;
    return tags.some((t) => groups.has(t));
  });
}

export function canUseHost(user, host) {
  if (!host || !host.enabled) return false;
  if (isAdminRole(user?.role)) return true;
  const tags = (host.teamTags || []).map((t) => String(t).toLowerCase());
  if (tags.length === 0) return true;
  const groups = new Set(groupsForUser(user?.username).map((g) => g.toLowerCase()));
  return tags.some((t) => groups.has(t));
}
