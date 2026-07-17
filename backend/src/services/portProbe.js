import net from "net";
import { exec } from "child_process";

/**
 * ICMP ping a host once with a short timeout. Resolves true if it replies.
 * Uses the system ping binary so it works without raw-socket privileges.
 * Broader than a TCP probe — catches any reachable device, not just SSH hosts.
 * If ping is unavailable or ICMP is blocked, falls back to a quick TCP check
 * on a few common ports so the conflict check still has some signal.
 */
export function isHostLive(ip, { timeoutSec = 1 } = {}) {
  return new Promise((resolve) => {
    exec(`ping -c 1 -W ${timeoutSec} ${ip}`, async (err, stdout) => {
      if (!err) return resolve(true); // got an ICMP reply
      // ping missing / ICMP filtered: fall back to TCP on common service ports.
      if (/not found|No such file/i.test(String(err.message))) {
        const anyOpen = await tcpAny(ip, [22, 80, 443, 3389], timeoutSec * 1000);
        return resolve(anyOpen);
      }
      // ping ran but no reply — treat as not live.
      resolve(false);
    });
  });
}

function tcpAny(host, ports, timeoutMs) {
  return Promise.all(
    ports.map(
      (port) =>
        new Promise((res) => {
          const s = new net.Socket();
          let done = false;
          const end = (v) => { if (!done) { done = true; s.destroy(); res(v); } };
          s.setTimeout(timeoutMs);
          s.once("connect", () => end(true));
          s.once("timeout", () => end(false));
          s.once("error", () => end(false));
          s.connect(port, host);
        })
    )
  ).then((results) => results.some(Boolean));
}

/**
 * Resolves true once a TCP connection to host:port succeeds, or false if it
 * never comes up within the timeout. Used to confirm a freshly-booted VM is
 * actually accepting SSH before we tell the user it's ready to connect.
 */
export function waitForPort({ host, port = 22, timeoutMs = 120000, intervalMs = 3000, connectTimeoutMs = 4000 }) {
  const deadline = Date.now() + timeoutMs;

  return new Promise((resolve) => {
    const attempt = () => {
      const socket = new net.Socket();
      let settled = false;

      const cleanup = () => {
        if (settled) return;
        settled = true;
        socket.removeAllListeners();
        socket.destroy();
      };

      socket.setTimeout(connectTimeoutMs);

      socket.once("connect", () => {
        cleanup();
        resolve(true);
      });

      const retryOrFail = () => {
        cleanup();
        if (Date.now() >= deadline) {
          resolve(false);
        } else {
          setTimeout(attempt, intervalMs);
        }
      };

      socket.once("timeout", retryOrFail);
      socket.once("error", retryOrFail);

      socket.connect(port, host);
    };

    attempt();
  });
}
