import { prisma, fireAndForget } from "../db/client.js";

let owners = {};

export async function hydrateOwnership() {
  const rows = await prisma.resourceOwnership.findMany();
  owners = {};
  for (const row of rows) {
    owners[String(row.vmid)] = {
      username: row.username,
      hostname: row.hostname,
      ip: row.ip,
      createdAt: row.createdAt.toISOString(),
    };
  }
}

function persistOwner(vmid, data) {
  const id = Number(vmid);
  fireAndForget(
    prisma.resourceOwnership.upsert({
      where: { vmid: id },
      create: {
        vmid: id,
        username: data.username,
        hostname: data.hostname,
        ip: data.ip,
        createdAt: new Date(data.createdAt || Date.now()),
      },
      update: {
        username: data.username,
        hostname: data.hostname,
        ip: data.ip,
      },
    }),
    "ownership"
  );
}

export function setOwner(vmid, { username, hostname }) {
  const key = String(vmid);
  owners[key] = {
    username,
    hostname,
    createdAt: new Date().toISOString(),
    ...(owners[key] || {}),
  };
  persistOwner(vmid, owners[key]);
}

export function getOwner(vmid) {
  return owners[String(vmid)] || null;
}

export function setOwnerIp(vmid, ip) {
  const key = String(vmid);
  if (!owners[key]) {
    owners[key] = { username: null, hostname: null, createdAt: new Date().toISOString() };
  }
  owners[key].ip = ip;
  persistOwner(vmid, owners[key]);
}

export function removeOwner(vmid) {
  const key = String(vmid);
  if (owners[key]) {
    delete owners[key];
    fireAndForget(prisma.resourceOwnership.delete({ where: { vmid: Number(vmid) } }), "ownership-delete");
  }
}

export function listOwned(username) {
  return Object.entries(owners)
    .filter(([, o]) => o.username === username)
    .map(([vmid, o]) => ({ vmid: Number(vmid), ...o }));
}

export function allOwners() {
  return owners;
}
