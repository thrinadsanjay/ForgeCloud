import { WebSocketServer } from "ws";
import { Client } from "ssh2";
import { verifyToken } from "../services/authService.js";
import { getOwner } from "../services/ownershipStore.js";
import { getGuestAgentIp, getResourceTags } from "../services/proxmoxService.js";
import { canSeeTags } from "../services/visibility.js";
import { logAudit } from "../services/auditService.js";

export function attachTerminalWs(httpServer) {
  const wss = new WebSocketServer({ server: httpServer, path: "/ws/ssh" });

  wss.on("connection", (ws, req) => {
    const url = new URL(req.url, "http://localhost");
    const token = url.searchParams.get("token");
    const vmid = url.searchParams.get("vmid");
    const cols = parseInt(url.searchParams.get("cols") || "220");
    const rows = parseInt(url.searchParams.get("rows") || "50");

    // 1. Authenticate the portal user from their JWT (passed as a query param
    //    since browsers can't set headers on a WebSocket handshake).
    let user;
    try {
      const claims = verifyToken(token);
      user = { id: claims.sub, username: claims.username, role: claims.role };
    } catch (_) {
      ws.send("\r\nError: authentication required\r\n");
      ws.close();
      return;
    }

    if (!vmid) {
      ws.send("\r\nError: no VM specified\r\n");
      ws.close();
      return;
    }

    const owner = getOwner(Number(vmid));

    (async () => {
    // 2. Authorize by tag: admins connect to any VM; others only to VMs whose
    //    Proxmox tags include their user tag or a group tag.
    if (user.role !== "admin") {
      const tags = await getResourceTags({ vmid: Number(vmid), type: "vm" }).catch(() => "");
      if (!canSeeTags(tags, user)) {
        ws.send("\r\nError: you can only connect to VMs assigned to you or your group\r\n");
        logAudit({ actor: user, action: "vm.connect", target: `VMID ${vmid}`, status: "denied" });
        ws.close();
        return;
      }
    }

    // 3. Resolve the target IP on the server from the VMID — first the IP we
    //    recorded from DHCP, then a live guest-agent lookup as a fallback. The
    //    client never supplies an IP, so it can't point the proxy at any host.
    let ip = owner?.ip || null;
    if (!ip) ip = await getGuestAgentIp({ vmid: Number(vmid) }).catch(() => null);
    if (!ip) {
      ws.send("\r\nError: no known IP address for this VM (DHCP lease not detected yet)\r\n");
      ws.close();
      return;
    }

    // Wait for the first message which must be the auth payload:
    // { type: "auth", username: "...", password: "..." }
    ws.once("message", (msg) => {
      let creds;
      try {
        const parsed = JSON.parse(msg.toString());
        if (parsed.type !== "auth" || !parsed.username || !parsed.password) {
          ws.send("\r\nError: first message must be auth credentials\r\n");
          ws.close();
          return;
        }
        creds = { username: parsed.username, password: parsed.password };
      } catch (e) {
        ws.send("\r\nError: invalid auth message\r\n");
        ws.close();
        return;
      }

      const ssh = new Client();

      ssh.on("ready", () => {
        ws.send(`\r\nConnected to ${ip} as ${creds.username}\r\n\r\n`);
        logAudit({
          actor: user,
          action: "vm.connect",
          target: `VMID ${vmid} (${ip})`,
          status: "success",
          detail: { sshUser: creds.username },
        });

        ssh.shell({ term: "xterm-256color", cols, rows }, (err, stream) => {
          if (err) {
            ws.send(`\r\nShell error: ${err.message}\r\n`);
            ws.close();
            return;
          }

          // VM → browser
          stream.on("data", (data) => {
            if (ws.readyState === 1) ws.send(data);
          });
          stream.stderr.on("data", (data) => {
            if (ws.readyState === 1) ws.send(data);
          });
          stream.on("close", () => {
            ws.close();
            ssh.end();
          });

          // browser → VM
          ws.on("message", (msg) => {
            const str = msg.toString();
            try {
              const parsed = JSON.parse(str);
              if (parsed.type === "resize") {
                stream.setWindow(parsed.rows, parsed.cols);
                return;
              }
            } catch (_) { /* normal input */ }
            stream.write(str);
          });

          ws.on("close", () => {
            try { stream.close(); } catch (_) {}
            ssh.end();
          });
        });
      });

      ssh.on("error", (err) => {
        const msg = `\r\nSSH error: ${err.message}\r\n`;
        if (ws.readyState === 1) {
          ws.send(msg);
          ws.close();
        }
      });

      ssh.connect({
        host: ip,
        port: 22,
        username: creds.username,
        password: creds.password,
        readyTimeout: 20000,
        hostVerifier: () => true,
      });
    });
    })();
  });

  console.log("WebSocket SSH proxy attached at /ws/ssh");
}

