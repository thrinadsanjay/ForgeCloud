import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { testConnection as testProxmox } from "../services/proxmoxService.js";
import { testConnection as testK3s } from "../services/k3sService.js";
import { testConnection as testDocker } from "../services/dockerService.js";
import {
  listDockerHosts,
  hostsVisibleTo,
  getDockerHostSecrets,
} from "../services/dockerHostStore.js";

const router = Router();
router.use(requireAuth);

function failMessage(provider, err) {
  const raw = String(err?.message || err || "").trim();
  if (/not configured/i.test(raw)) return `${provider} is not configured`;
  if (/required|token|password|username|TLS materials/i.test(raw) && /not|missing|incomplete|required/i.test(raw)) {
    return `${provider} is not configured`;
  }
  return `${provider} is down or unreachable`;
}

function isConfiguredError(err) {
  const raw = String(err?.message || err || "");
  return /not configured|are required|is required|TLS materials are incomplete/i.test(raw);
}

async function probeDockerHost(h) {
  try {
    const secrets = getDockerHostSecrets(h.id);
    const detail = await testDocker(secrets);
    return {
      id: h.id,
      name: h.name,
      endpoint: h.endpoint,
      ok: true,
      detail: { version: detail?.version, apiVersion: detail?.apiVersion },
    };
  } catch (e) {
    return {
      id: h.id,
      name: h.name,
      endpoint: h.endpoint,
      ok: false,
      error: e.message,
    };
  }
}

// Lightweight reachability probes for provisioning pages (any signed-in user).
// These are app-level: they use server credentials, not the caller's admin rights.
router.get("/infra/status/proxmox", async (_req, res) => {
  try {
    const detail = await testProxmox({ light: true });
    res.json({
      ok: true,
      configured: true,
      message: "Proxmox is reachable",
      detail: { node: detail?.node, host: detail?.host },
    });
  } catch (e) {
    const configured = !isConfiguredError(e);
    res.json({
      ok: false,
      configured,
      message: failMessage("Proxmox", e),
      error: e.message,
    });
  }
});

router.get("/infra/status/k3s", async (_req, res) => {
  try {
    const detail = await testK3s();
    res.json({
      ok: true,
      configured: true,
      message: "Kubernetes is reachable",
      detail: { url: detail?.url, gitVersion: detail?.gitVersion },
    });
  } catch (e) {
    const configured = !isConfiguredError(e);
    res.json({
      ok: false,
      configured,
      message: failMessage("Kubernetes", e),
      error: e.message,
    });
  }
});

router.get("/infra/status/docker", async (req, res) => {
  const all = listDockerHosts().filter((h) => h.enabled);
  if (!all.length) {
    return res.json({
      ok: false,
      configured: false,
      message: "No Docker hosts are configured",
      hosts: [],
    });
  }

  // Platform health = any enabled host reachable (app-level, not user ACL).
  const probed = await Promise.all(all.map(probeDockerHost));
  const anyOk = probed.some((h) => h.ok);

  // UI list still respects group visibility so users only deploy to hosts they can use.
  const visibleIds = new Set(hostsVisibleTo(req.user).map((h) => h.id));
  const hosts = probed.filter((h) => visibleIds.has(h.id));
  const visibleOk = hosts.some((h) => h.ok);

  res.json({
    ok: anyOk,
    configured: true,
    // Provisioning still needs a visible host; surface that separately.
    usable: visibleOk,
    message: anyOk
      ? (visibleOk ? "Docker host(s) reachable" : "Docker is reachable, but no host is available for your groups")
      : "Docker is down or unreachable",
    hosts,
  });
});

export default router;
