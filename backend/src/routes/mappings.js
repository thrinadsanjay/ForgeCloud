import { Router } from "express";
import * as pve from "../services/proxmoxService.js";
import { requireAuth, requireAdmin } from "../middleware/auth.js";
import { logAudit } from "../services/auditService.js";
import { listContainerTemplates } from "../services/catalogService.js";
import {
  getTemplateMappings, upsertTemplateMapping, deleteTemplateMapping,
  getNetworkMappings, upsertNetworkMapping, deleteNetworkMapping,
} from "../services/mappingStore.js";

const router = Router();
// Per-route guards only — blanket requireAdmin on a /api-mounted router
// would block every later /api route (infra status, k3s, docker, …) for users.
const admin = [requireAuth, requireAdmin];

const CONNECTIVITY = ["ssh", "winrm"];

// Decide whether a Proxmox interface is a virtual bridge or a VLAN.
function detectNetworkType(iface) {
  const t = (iface.type || "").toLowerCase();
  if (t === "vlan") return "vlan";
  if (t.includes("bridge")) return "bridge";        // bridge, OVSBridge
  // A dotted iface name (e.g. vmbr0.100) or an explicit tag implies a VLAN.
  if (/\.\d+$/.test(iface.iface || "") || iface["vlan-id"] != null) return "vlan";
  return t || "other";
}

function isNetworkCandidate(iface) {
  const t = (iface.type || "").toLowerCase();
  return t.includes("bridge") || t === "vlan" || /\.\d+$/.test(iface.iface || "");
}

// GET /mappings — auto-detect templates + networks from Proxmox on every call,
// then merge the admin's saved mappings on top.
router.get("/mappings", ...admin, async (req, res) => {
  try {
    // Ensure PROXMOX_NODE is set (auto-detect when Settings left it blank).
    await pve.resolvePveNode();

    const [templates, networks, snippets] = await Promise.all([
      pve.listTemplates({}).catch((e) => { console.error("[mappings] template detection failed:", e.message); return []; }),
      pve.listNetworks({}).catch((e) => { console.error("[mappings] network detection failed:", e.message); return []; }),
      pve.listSnippets({}).catch((e) => { console.error("[mappings] snippet detection failed:", e.message); return []; }),
    ]);

    const tMap = getTemplateMappings();
    const nMap = getNetworkMappings();

    // Union of Proxmox-flagged templates and the catalog's known clone sources,
    // so the admin can always map the templates the portal provisions from —
    // even if they aren't flagged template=1 in Proxmox.
    const byVmid = new Map();
    for (const t of templates) {
      byVmid.set(t.vmid, { vmid: t.vmid, name: t.name || `template-${t.vmid}`, source: "proxmox" });
    }
    for (const c of listContainerTemplates()) {
      if (c.vmid != null && !byVmid.has(c.vmid)) {
        byVmid.set(c.vmid, { vmid: c.vmid, name: c.name, source: "catalog" });
      }
    }

    const templateRows = Array.from(byVmid.values()).map((t) => {
      const m = tMap[String(t.vmid)] || {};
      const cloudInitValid = m.cloudInitFile ? snippets.includes(m.cloudInitFile) : null;
      return {
        vmid: t.vmid,
        templateName: t.name,
        source: t.source,
        osName: m.osName || "",
        cloudInitFile: m.cloudInitFile || "",
        cloudInitSource: m.cloudInitSource || "snippet",
        cloudInitValid,
        credUser: m.credUser || "",
        hasPassword: !!m.credPassword,
        connectivity: m.connectivity || "ssh",
        port: m.port || (m.connectivity === "winrm" ? 5985 : 22),
        packageManager: m.packageManager || "",
      };
    });

    const networkRows = networks
      .filter(isNetworkCandidate)
      .map((n) => {
        const m = nMap[n.iface] || {};
        const detectedType = detectNetworkType(n);
        return {
          iface: n.iface,
          detectedType,
          type: m.type || detectedType,        // admin override wins
          label: m.label || "",
          active: n.active === 1 || n.active === true,
          cidr: n.cidr || n.address || "",
          autostart: n.autostart === 1,
        };
      });

    res.json({
      templates: templateRows,
      networks: networkRows,
      snippets,
      snippetStorage: process.env.SNIPPET_STORAGE || "local",
    });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// PUT /mappings/templates/:vmid — save a template mapping.
router.put("/mappings/templates/:vmid", ...admin, async (req, res) => {
  const { vmid } = req.params;
  const b = req.body || {};
  const osName = typeof b.osName === "string" ? b.osName.trim() : "";

  if (!osName) {
    return res.status(400).json({ error: "OS name is required" });
  }
  if (b.connectivity && !CONNECTIVITY.includes(b.connectivity)) {
    return res.status(400).json({ error: `connectivity must be one of ${CONNECTIVITY.join(", ")}` });
  }
  if (b.port != null && (!Number.isFinite(Number(b.port)) || Number(b.port) <= 0)) {
    return res.status(400).json({ error: "port must be a positive number" });
  }

  // Validate the cloud-init snippet actually exists in Proxmox storage.
  if (b.cloudInitFile) {
    const snippets = await pve.listSnippets({}).catch(() => []);
    if (!snippets.includes(b.cloudInitFile)) {
      return res.status(400).json({
        error: `Cloud-init file "${b.cloudInitFile}" not found in /var/lib/vz/snippets. Available: ${snippets.join(", ") || "none"}`,
      });
    }
  }

  const saved = upsertTemplateMapping(vmid, {
    osName,
    cloudInitFile: b.cloudInitFile,
    cloudInitSource: "snippet",
    credUser: b.credUser,
    credPassword: b.credPassword, // blank keeps existing (handled in store)
    connectivity: b.connectivity,
    port: b.port != null ? Number(b.port) : undefined,
    packageManager: b.packageManager,
  });

  logAudit({ actor: req.user, action: "mapping.template.save", target: `VMID ${vmid}`, detail: { osName } });
  res.json({ ok: true, mapping: { ...saved, credPassword: undefined, hasPassword: !!saved.credPassword } });
});

router.delete("/mappings/templates/:vmid", ...admin, (req, res) => {
  deleteTemplateMapping(req.params.vmid);
  logAudit({ actor: req.user, action: "mapping.template.delete", target: `VMID ${req.params.vmid}` });
  res.json({ ok: true });
});

// PUT /mappings/networks/:iface — save a network mapping (type override + label).
router.put("/mappings/networks/:iface", ...admin, (req, res) => {
  const b = req.body || {};
  const label = typeof b.label === "string" ? b.label.trim() : "";
  if (!label) {
    return res.status(400).json({ error: "Name is required" });
  }
  if (b.type && !["bridge", "vlan"].includes(b.type)) {
    return res.status(400).json({ error: "type must be 'bridge' or 'vlan'" });
  }
  const saved = upsertNetworkMapping(req.params.iface, { type: b.type, label });
  logAudit({ actor: req.user, action: "mapping.network.save", target: req.params.iface, detail: { type: b.type, label } });
  res.json({ ok: true, mapping: saved });
});

router.delete("/mappings/networks/:iface", ...admin, (req, res) => {
  deleteNetworkMapping(req.params.iface);
  logAudit({ actor: req.user, action: "mapping.network.delete", target: req.params.iface });
  res.json({ ok: true });
});

export default router;
