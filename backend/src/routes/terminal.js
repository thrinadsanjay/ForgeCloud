import { Client } from "ssh2";
import { verifyToken } from "../services/authService.js";
import { getOwner } from "../services/ownershipStore.js";
import { getGuestAgentIp, getResourceTags } from "../services/proxmoxService.js";
import { canSeeTags } from "../services/visibility.js";
import { logAudit } from "../services/auditService.js";
import { createPathWebSocketServer } from "./wsRouter.js";

/** Wait for the first WebSocket text/binary message, or use one already buffered. */
function waitForFirstMessage(ws, buffered) {
  if (buffered.length) return Promise.resolve(buffered.shift());
  return new Promise((resolve, reject) => {
    const onMsg = (msg) => {
      cleanup();
      resolve(msg);
    };
    const onClose = () => {
      cleanup();
      reject(new Error("WebSocket closed before auth"));
    };
    const cleanup = () => {
      ws.off("message", onMsg);
      ws.off("close", onClose);
    };
    ws.on("message", onMsg);
    ws.on("close", onClose);
  });
}

export function attachTerminalWs(httpServer) {
  const wss = createPathWebSocketServer(httpServer, "/ws/ssh");

  wss.on("connection", (ws, req) => {
    const url = new URL(req.url, "http://localhost");
    const token = url.searchParams.get("token");
    const vmid = url.searchParams.get("vmid");
    const cols = parseInt(url.searchParams.get("cols") || "220", 10);
    const rows = parseInt(url.searchParams.get("rows") || "50", 10);

    // Buffer early messages immediately — the browser sends auth on `open`,
    // which often arrives before our async auth/IP lookups finish.
    const early = [];
    const bufferEarly = (msg) => early.push(msg);
    ws.on("message", bufferEarly);

    const fail = (text) => {
      try {
        if (ws.readyState === 1) ws.send(`\r\n${text}\r\n`);
      } catch {
        /* ignore */
      }
      try { ws.close(); } catch { /* ignore */ }
    };

    let user;
    try {
      const claims = verifyToken(token);
      user = { id: claims.sub, username: claims.username, role: claims.role };
    } catch (_) {
      fail("Error: authentication required");
      return;
    }

    if (!vmid) {
      fail("Error: no VM specified");
      return;
    }

    (async () => {
      try {
        // Authorize by tag: admins any VM; others only tagged for them/group.
        if (user.role !== "admin") {
          const tags = await getResourceTags({ vmid: Number(vmid), type: "vm" }).catch(() => "");
          if (!canSeeTags(tags, user)) {
            logAudit({ actor: user, action: "vm.connect", target: `VMID ${vmid}`, status: "denied" });
            fail("Error: you can only connect to VMs assigned to you or your group");
            return;
          }
        }

        // Resolve IP server-side from ownership / guest agent (never trust client IP).
        const owner = getOwner(Number(vmid));
        let ip = owner?.ip || null;
        if (!ip) ip = await getGuestAgentIp({ vmid: Number(vmid) }).catch(() => null);
        if (!ip) {
          fail("Error: no known IP address for this VM (DHCP lease not detected yet)");
          return;
        }

        ws.off("message", bufferEarly);
        let raw;
        try {
          raw = await waitForFirstMessage(ws, early);
        } catch {
          return;
        }

        let creds;
        try {
          const parsed = JSON.parse(raw.toString());
          if (parsed.type !== "auth" || !parsed.username || !parsed.password) {
            fail("Error: first message must be auth credentials");
            return;
          }
          creds = { username: parsed.username, password: parsed.password };
        } catch {
          fail("Error: invalid auth message");
          return;
        }

        const ssh = new Client();

        ssh.on("ready", () => {
          if (ws.readyState === 1) {
            ws.send(`\r\nConnected to ${ip} as ${creds.username}\r\n\r\n`);
          }
          logAudit({
            actor: user,
            action: "vm.connect",
            target: `VMID ${vmid} (${ip})`,
            status: "success",
            detail: { sshUser: creds.username },
          });

          ssh.shell({ term: "xterm-256color", cols, rows }, (err, stream) => {
            if (err) {
              fail(`Shell error: ${err.message}`);
              ssh.end();
              return;
            }

            stream.on("data", (data) => {
              if (ws.readyState === 1) ws.send(data);
            });
            stream.stderr.on("data", (data) => {
              if (ws.readyState === 1) ws.send(data);
            });
            stream.on("close", () => {
              try { ws.close(); } catch { /* ignore */ }
              ssh.end();
            });

            ws.on("message", (msg) => {
              const str = msg.toString();
              try {
                const parsed = JSON.parse(str);
                if (parsed.type === "resize") {
                  stream.setWindow(parsed.rows, parsed.cols);
                  return;
                }
              } catch {
                /* normal input */
              }
              stream.write(str);
            });

            ws.on("close", () => {
              try { stream.close(); } catch { /* ignore */ }
              ssh.end();
            });
          });
        });

        ssh.on("error", (err) => {
          console.warn(`[terminal] SSH to ${ip} (VMID ${vmid}) failed: ${err.message}`);
          fail(`SSH error: ${err.message}`);
        });

        ssh.connect({
          host: ip,
          port: 22,
          username: creds.username,
          password: creds.password,
          readyTimeout: 20000,
          hostVerifier: () => true,
        });
      } catch (err) {
        console.error("[terminal] unexpected error:", err);
        fail(`Error: ${err.message || "terminal session failed"}`);
      }
    })();
  });

  console.log("WebSocket SSH proxy attached at /ws/ssh");
}
