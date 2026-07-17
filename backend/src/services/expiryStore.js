import { prisma, fireAndForget } from "../db/client.js";

export const DEFAULT_TTL_DAYS = Number(process.env.RESOURCE_TTL_DAYS || 30);

let expiry = {};

export async function hydrateExpiry() {
  const rows = await prisma.resourceExpiry.findMany();
  expiry = {};
  for (const row of rows) {
    expiry[String(row.vmid)] = {
      expiresAt: row.expiresAt.toISOString(),
      setBy: row.setBy,
      type: row.type,
      ttlDays: row.ttlDays,
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}

function persistExpiry(vmid, record) {
  const id = Number(vmid);
  fireAndForget(
    prisma.resourceExpiry.upsert({
      where: { vmid: id },
      create: {
        vmid: id,
        expiresAt: new Date(record.expiresAt),
        setBy: record.setBy,
        ttlDays: record.ttlDays,
        type: record.type,
        updatedAt: new Date(record.updatedAt),
      },
      update: {
        expiresAt: new Date(record.expiresAt),
        setBy: record.setBy,
        ttlDays: record.ttlDays,
        type: record.type,
        updatedAt: new Date(record.updatedAt),
      },
    }),
    "expiry"
  );
}

function daysFromNow(days) {
  return new Date(Date.now() + days * 86400_000).toISOString();
}

function normalizeTtlDays(days) {
  const n = Number(days);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TTL_DAYS;
  return Math.min(Math.round(n), 3650);
}

export function getExpiry(vmid) {
  return expiry[String(vmid)] || null;
}

export function setDefaultExpiry(vmid, { setBy = "system", ttlDays, type } = {}) {
  const key = String(vmid);
  if (expiry[key]) return expiry[key];
  const days = normalizeTtlDays(ttlDays);
  const record = {
    expiresAt: daysFromNow(days),
    setBy,
    type: type || null,
    ttlDays: days,
    updatedAt: new Date().toISOString(),
  };
  expiry[key] = record;
  persistExpiry(vmid, record);
  return record;
}

export function extendExpiry(vmid, { days, expiresAt, setBy = "admin" } = {}) {
  const key = String(vmid);
  const prev = expiry[key];
  const record = {
    expiresAt: expiresAt || daysFromNow(days ?? DEFAULT_TTL_DAYS),
    setBy,
    type: prev?.type || null,
    ttlDays: days != null ? normalizeTtlDays(days) : (prev?.ttlDays ?? DEFAULT_TTL_DAYS),
    updatedAt: new Date().toISOString(),
  };
  expiry[key] = record;
  persistExpiry(vmid, record);
  return record;
}

export function removeExpiry(vmid) {
  const key = String(vmid);
  if (expiry[key]) {
    delete expiry[key];
    fireAndForget(prisma.resourceExpiry.delete({ where: { vmid: Number(vmid) } }), "expiry-delete");
  }
}

export function allExpiries() {
  return expiry;
}

export function isExpired(vmid) {
  const rec = getExpiry(vmid);
  return rec ? new Date(rec.expiresAt).getTime() <= Date.now() : false;
}
