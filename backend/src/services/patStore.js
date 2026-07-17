import crypto from "crypto";
import { prisma, fireAndForget } from "../db/client.js";

const TOKEN_PREFIX = "forge_pat_";
const LEGACY_TOKEN_PREFIX = "ssp_pat_";

let pats = [];

function rowToPat(row) {
  return {
    id: row.id,
    name: row.name,
    username: row.username,
    role: row.role,
    prefix: row.prefix,
    tokenHash: row.tokenHash,
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString() || null,
    expiresAt: row.expiresAt?.toISOString() || null,
  };
}

export async function hydratePats() {
  const rows = await prisma.personalAccessToken.findMany();
  pats = rows.map(rowToPat);
}

function persistPat(pat) {
  fireAndForget(
    prisma.personalAccessToken.upsert({
      where: { id: pat.id },
      create: {
        id: pat.id,
        name: pat.name,
        username: pat.username,
        role: pat.role,
        prefix: pat.prefix,
        tokenHash: pat.tokenHash,
        createdAt: new Date(pat.createdAt),
        lastUsedAt: pat.lastUsedAt ? new Date(pat.lastUsedAt) : null,
        expiresAt: pat.expiresAt ? new Date(pat.expiresAt) : null,
      },
      update: {
        name: pat.name,
        lastUsedAt: pat.lastUsedAt ? new Date(pat.lastUsedAt) : null,
        expiresAt: pat.expiresAt ? new Date(pat.expiresAt) : null,
      },
    }),
    "pat"
  );
}

function deletePatRow(id) {
  fireAndForget(prisma.personalAccessToken.delete({ where: { id } }), "pat-delete");
}

const hashToken = (t) => crypto.createHash("sha256").update(t).digest("hex");
const publicView = ({ tokenHash, ...meta }) => meta;

export function createPat({ username, role, name, expiresInDays }) {
  const raw = `${TOKEN_PREFIX}${crypto.randomBytes(24).toString("hex")}`;
  const now = new Date();
  let expiresAt = null;
  const days = Number(expiresInDays);
  if (Number.isFinite(days) && days > 0) {
    expiresAt = new Date(now.getTime() + days * 86400000).toISOString();
  }
  const record = {
    id: crypto.randomBytes(8).toString("hex"),
    name: (name && String(name).trim()) || "token",
    username,
    role,
    prefix: `${raw.slice(0, 16)}…`,
    tokenHash: hashToken(raw),
    createdAt: now.toISOString(),
    lastUsedAt: null,
    expiresAt,
  };
  pats.push(record);
  persistPat(record);
  return { token: raw, pat: publicView(record) };
}

export function listPats(username) {
  return pats
    .filter((p) => p.username === username)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    .map(publicView);
}

export function revokePat(username, id) {
  const before = pats.length;
  pats = pats.filter((p) => !(p.id === id && p.username === username));
  if (pats.length === before) return false;
  deletePatRow(id);
  return true;
}

export function verifyPat(token) {
  if (!token || (!token.startsWith(TOKEN_PREFIX) && !token.startsWith(LEGACY_TOKEN_PREFIX))) return null;
  const h = hashToken(token);
  const rec = pats.find((p) => p.tokenHash === h);
  if (!rec) return null;
  if (rec.expiresAt && new Date(rec.expiresAt).getTime() < Date.now()) return null;
  rec.lastUsedAt = new Date().toISOString();
  persistPat(rec);
  return { username: rec.username, role: rec.role, patId: rec.id };
}

export const isPatToken = (token) => typeof token === "string"
  && (token.startsWith(TOKEN_PREFIX) || token.startsWith(LEGACY_TOKEN_PREFIX));
