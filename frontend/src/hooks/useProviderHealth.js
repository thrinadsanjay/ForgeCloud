import { useCallback, useEffect, useState } from "react";
import {
  getProxmoxStatus,
  getK3sStatus,
  getDockerStatus,
} from "../api/client.js";

const FETCHERS = {
  proxmox: getProxmoxStatus,
  k3s: getK3sStatus,
  docker: getDockerStatus,
};

/**
 * Probe Proxmox / K3s / Docker reachability for provisioning pages.
 * @param {"proxmox"|"k3s"|"docker"} provider
 */
export default function useProviderHealth(provider) {
  const [state, setState] = useState({
    status: "loading", // loading | ready
    ok: false,
    configured: true,
    usable: true,
    message: "",
    error: "",
    hosts: null,
  });

  const refresh = useCallback(async () => {
    const fetch = FETCHERS[provider];
    if (!fetch) {
      setState({
        status: "ready",
        ok: false,
        configured: false,
        usable: false,
        message: "Unknown provider",
        error: "",
        hosts: null,
      });
      return;
    }
    setState((s) => ({ ...s, status: "loading" }));
    try {
      const data = await fetch();
      const hosts = Array.isArray(data?.hosts) ? data.hosts : null;
      // Docker infra status puts failures on hosts[].error, not a top-level error.
      const hostErrors = (hosts || [])
        .filter((h) => !h.ok && h.error)
        .map((h) => `${h.name || h.endpoint || h.id}: ${h.error}`)
        .join(" · ");
      const ok = !!data?.ok;
      const usable = data?.usable !== false;
      setState({
        status: "ready",
        ok,
        configured: data?.configured !== false,
        usable,
        message: data?.message || (ok ? "OK" : "Unreachable"),
        error: data?.error || hostErrors || "",
        hosts,
      });
    } catch (e) {
      const labels = { proxmox: "Proxmox", k3s: "Kubernetes", docker: "Docker" };
      setState({
        status: "ready",
        ok: false,
        configured: true,
        usable: false,
        message: `${labels[provider] || "Provider"} is down or unreachable`,
        error: e.response?.data?.error || e.message,
        hosts: null,
      });
    }
  }, [provider]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Block deploy only when the platform is down — not when the caller lacks admin rights.
  // Docker may be up platform-wide but have no host visible to this user's groups.
  const blocked = state.status === "ready" && (!state.ok || (provider === "docker" && !state.usable));
  const checking = state.status === "loading";

  return { ...state, blocked, checking, refresh };
}
