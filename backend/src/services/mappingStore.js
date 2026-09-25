import { prisma, fireAndForget } from "../db/client.js";

let templates = {};
let networks = {};

export async function hydrateMappings() {
  const [tplRows, netRows] = await Promise.all([
    prisma.templateMapping.findMany(),
    prisma.networkMapping.findMany(),
  ]);
  templates = {};
  networks = {};
  for (const row of tplRows) {
    templates[String(row.vmid)] = {
      osName: row.osName,
      credUser: row.credUser,
      credPassword: row.credPassword,
      connectivity: row.connectivity,
      port: row.port,
      packageManager: row.packageManager,
      cloudInitFile: row.cloudInitFile,
      cloudInitSource: row.cloudInitSource,
      updatedAt: row.updatedAt?.toISOString() || null,
    };
  }
  for (const row of netRows) {
    networks[row.iface] = {
      label: row.label,
      type: row.type,
      updatedAt: row.updatedAt?.toISOString() || null,
    };
  }
}

function persistTemplate(vmid, data) {
  const id = Number(vmid);
  fireAndForget(
    prisma.templateMapping.upsert({
      where: { vmid: id },
      create: {
        vmid: id,
        osName: data.osName,
        credUser: data.credUser,
        credPassword: data.credPassword,
        connectivity: data.connectivity,
        port: data.port,
        packageManager: data.packageManager,
        cloudInitFile: data.cloudInitFile,
        cloudInitSource: data.cloudInitSource,
        updatedAt: data.updatedAt ? new Date(data.updatedAt) : new Date(),
      },
      update: {
        osName: data.osName,
        credUser: data.credUser,
        credPassword: data.credPassword,
        connectivity: data.connectivity,
        port: data.port,
        packageManager: data.packageManager,
        cloudInitFile: data.cloudInitFile,
        cloudInitSource: data.cloudInitSource,
        updatedAt: data.updatedAt ? new Date(data.updatedAt) : new Date(),
      },
    }),
    "template-mapping"
  );
}

function persistNetwork(iface, data) {
  fireAndForget(
    prisma.networkMapping.upsert({
      where: { iface },
      create: {
        iface,
        label: data.label,
        type: data.type,
        updatedAt: data.updatedAt ? new Date(data.updatedAt) : new Date(),
      },
      update: {
        label: data.label,
        type: data.type,
        updatedAt: data.updatedAt ? new Date(data.updatedAt) : new Date(),
      },
    }),
    "network-mapping"
  );
}

export function getTemplateMappings() {
  return templates;
}

export function upsertTemplateMapping(vmid, patch) {
  const key = String(vmid);
  const existing = templates[key] || {};
  const next = { ...existing, ...patch, updatedAt: new Date().toISOString() };
  if (patch.credPassword === "" || patch.credPassword == null) {
    next.credPassword = existing.credPassword || "";
  }
  templates[key] = next;
  persistTemplate(vmid, next);
  return next;
}

export function deleteTemplateMapping(vmid) {
  const key = String(vmid);
  if (templates[key]) {
    delete templates[key];
    fireAndForget(prisma.templateMapping.delete({ where: { vmid: Number(vmid) } }), "template-mapping-delete");
  }
}

export function getNetworkMappings() {
  return networks;
}

export function upsertNetworkMapping(iface, patch) {
  const existing = networks[iface] || {};
  const next = { ...existing, ...patch, updatedAt: new Date().toISOString() };
  networks[iface] = next;
  persistNetwork(iface, next);
  return next;
}

export function deleteNetworkMapping(iface) {
  if (networks[iface]) {
    delete networks[iface];
    fireAndForget(prisma.networkMapping.delete({ where: { iface } }), "network-mapping-delete");
  }
}
