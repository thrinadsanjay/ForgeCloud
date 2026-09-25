import { spawn } from "child_process";
import { verifyToken } from "../services/authService.js";
import { getDockerHostSecrets, canUseHost } from "../services/dockerHostStore.js";
import { withDockerCliEnv } from "../services/dockerService.js";
import { logAudit } from "../services/auditService.js";
import { writeTempKubeconfig, k3sConfig, streamPodLogs } from "../services/k3sService.js";
import fs from "fs";
import { createPathWebSocketServer } from "./wsRouter.js";

function authUser(token) {
  const claims = verifyToken(token);
  return { id: claims.sub, username: claims.username, role: claims.role };
}

function fail(ws, text) {
  try {
    if (ws.readyState === 1) ws.send(`\r\n${text}\r\n`);
  } catch { /* ignore */ }
  try { ws.close(); } catch { /* ignore */ }
}

function bridgeProcess(ws, child, { binary = false } = {}) {
  child.stdout.on("data", (d) => {
    if (ws.readyState === 1) ws.send(binary ? d : d.toString());
  });
  child.stderr.on("data", (d) => {
    if (ws.readyState === 1) ws.send(binary ? d : d.toString());
  });
  child.on("close", () => {
    try { ws.close(); } catch { /* ignore */ }
  });
  child.on("error", (err) => fail(ws, `Error: ${err.message}`));

  ws.on("message", (msg) => {
    const str = msg.toString();
    try {
      const parsed = JSON.parse(str);
      if (parsed.type === "resize" && child.stdin) {
        // docker/kubectl don't always honor resize via stdin; best-effort SIGWINCH not available.
        return;
      }
    } catch {
      /* raw input */
    }
    if (child.stdin && !child.stdin.destroyed) child.stdin.write(Buffer.isBuffer(msg) ? msg : str);
  });
  ws.on("close", () => {
    try { child.kill("SIGTERM"); } catch { /* ignore */ }
  });
}

/** Interactive shell over `docker exec -i` into a remote Engine container. */
export function attachDockerExecWs(httpServer) {
  const wss = createPathWebSocketServer(httpServer, "/ws/docker-exec");

  wss.on("connection", (ws, req) => {
    const url = new URL(req.url, "http://localhost");
    const token = url.searchParams.get("token");
    const hostId = url.searchParams.get("hostId");
    const containerId = url.searchParams.get("containerId");
    const shell = url.searchParams.get("shell") || "/bin/sh";

    let user;
    try {
      user = authUser(token);
    } catch {
      fail(ws, "Error: authentication required");
      return;
    }
    if (!hostId || !containerId) {
      fail(ws, "Error: hostId and containerId are required");
      return;
    }

    const host = getDockerHostSecrets(hostId);
    if (!host || !canUseHost(user, host)) {
      fail(ws, "Error: Docker host not found");
      return;
    }

    let cli;
    try {
      cli = withDockerCliEnv(host);
    } catch (e) {
      fail(ws, `Error: ${e.message}`);
      return;
    }

    logAudit({
      actor: user,
      action: "compose.container.exec",
      target: `${hostId}/${containerId}`,
      status: "success",
    });

    const child = spawn(
      "docker",
      ["exec", "-i", containerId, shell],
      { env: { ...cli.env, TERM: "xterm-256color" }, shell: false },
    );
    child.on("close", () => cli.cleanup());
    child.on("error", () => cli.cleanup());
    if (ws.readyState === 1) {
      ws.send(`\r\nConnected to ${host.name} · ${String(containerId).slice(0, 12)} (${shell})\r\n\r\n`);
    }
    bridgeProcess(ws, child);
  });

  console.log("WebSocket Docker exec proxy attached at /ws/docker-exec");
}

/** Follow `docker logs -f` for a remote Engine container. */
export function attachDockerLogsWs(httpServer) {
  const wss = createPathWebSocketServer(httpServer, "/ws/docker-logs");

  wss.on("connection", (ws, req) => {
    const url = new URL(req.url, "http://localhost");
    const token = url.searchParams.get("token");
    const hostId = url.searchParams.get("hostId");
    const containerId = url.searchParams.get("containerId");
    const tail = Math.min(Math.max(Number(url.searchParams.get("tail") || 200), 1), 2000);

    let user;
    try {
      user = authUser(token);
    } catch {
      fail(ws, "Error: authentication required");
      return;
    }
    if (!hostId || !containerId) {
      fail(ws, "Error: hostId and containerId are required");
      return;
    }

    const host = getDockerHostSecrets(hostId);
    if (!host || !canUseHost(user, host)) {
      fail(ws, "Error: Docker host not found");
      return;
    }

    let cli;
    try {
      cli = withDockerCliEnv(host);
    } catch (e) {
      fail(ws, `Error: ${e.message}`);
      return;
    }

    const child = spawn(
      "docker",
      ["logs", "-f", "--tail", String(tail), "--timestamps", containerId],
      { env: cli.env, shell: false },
    );
    child.on("close", () => cli.cleanup());
    child.on("error", () => cli.cleanup());
    bridgeProcess(ws, child);
  });

  console.log("WebSocket Docker logs proxy attached at /ws/docker-logs");
}

/** Interactive shell over kubectl exec -i into a pod. */
export function attachK8sExecWs(httpServer) {
  const wss = createPathWebSocketServer(httpServer, "/ws/k8s-exec");

  wss.on("connection", async (ws, req) => {
    const url = new URL(req.url, "http://localhost");
    const token = url.searchParams.get("token");
    const namespace = url.searchParams.get("namespace");
    const pod = url.searchParams.get("pod");
    const container = url.searchParams.get("container") || "";
    const shell = url.searchParams.get("shell") || "/bin/sh";

    let user;
    try {
      user = authUser(token);
    } catch {
      fail(ws, "Error: authentication required");
      return;
    }
    if (!namespace || !pod) {
      fail(ws, "Error: namespace and pod are required");
      return;
    }

    const cfg = k3sConfig();
    if (!cfg.url || !cfg.token) {
      fail(ws, "Error: Kubernetes is not configured");
      return;
    }

    let kubeconfig;
    try {
      kubeconfig = await writeTempKubeconfig(cfg);
    } catch (e) {
      fail(ws, `Error: ${e.message}`);
      return;
    }

    logAudit({
      actor: user,
      action: "k8s.pod.exec_interactive",
      target: `${namespace}/${pod}`,
      status: "success",
    });

    const args = [
      "--kubeconfig", kubeconfig,
      "exec", "-n", namespace, "-i", pod,
      ...(container ? ["-c", container] : []),
      "--", shell,
    ];
    const child = spawn("kubectl", args, {
      env: { ...process.env, TERM: "xterm-256color" },
      shell: false,
    });
    const cleanup = () => { try { fs.unlinkSync(kubeconfig); } catch { /* ignore */ } };
    child.on("close", cleanup);
    child.on("error", cleanup);
    if (ws.readyState === 1) {
      ws.send(`\r\nConnected to ${namespace}/${pod} (${shell})\r\n\r\n`);
    }
    bridgeProcess(ws, child);
  });

  console.log("WebSocket Kubernetes exec proxy attached at /ws/k8s-exec");
}

/** Follow pod logs via Kubernetes API (no kubectl binary required). */
export function attachK8sLogsWs(httpServer) {
  const wss = createPathWebSocketServer(httpServer, "/ws/k8s-logs");

  wss.on("connection", async (ws, req) => {
    const url = new URL(req.url, "http://localhost");
    const token = url.searchParams.get("token");
    const namespace = url.searchParams.get("namespace");
    const pod = url.searchParams.get("pod");
    const container = url.searchParams.get("container") || "";
    const tail = Math.min(Math.max(Number(url.searchParams.get("tail") || 200), 1), 2000);

    try {
      authUser(token);
    } catch {
      fail(ws, "Error: authentication required");
      return;
    }
    if (!namespace || !pod) {
      fail(ws, "Error: namespace and pod are required");
      return;
    }

    const cfg = k3sConfig();
    if (!cfg.url || !cfg.token) {
      fail(ws, "Error: Kubernetes is not configured");
      return;
    }

    const stream = streamPodLogs(namespace, pod, {
      tailLines: tail,
      container: container || undefined,
      follow: true,
      timestamps: true,
      onData: (chunk) => {
        if (ws.readyState === 1) ws.send(chunk);
      },
      onEnd: () => {
        try { ws.close(); } catch { /* ignore */ }
      },
      onError: (err) => fail(ws, `Error: ${err.message || err}`),
    });

    ws.on("close", () => stream.destroy());
    ws.on("error", () => stream.destroy());
  });

  console.log("WebSocket Kubernetes logs proxy attached at /ws/k8s-logs");
}
