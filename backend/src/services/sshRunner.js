import { Client } from "ssh2";

// Run a single command over SSH and resolve { code, stdout, stderr }.
// Used post-boot to configure the VM as root (credentials come from the
// template mapping). Never used with the end-user's account.
export function runSsh({ host, port = 22, username, password, command, timeoutMs = 180000 }) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { conn.end(); } catch (_) {}
      reject(new Error("SSH command timed out"));
    }, timeoutMs);

    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { conn.end(); } catch (_) {}
      fn(arg);
    };

    conn.on("ready", () => {
      conn.exec(command, (err, stream) => {
        if (err) return finish(reject, err);
        stream
          .on("close", (code) => finish(resolve, { code: code ?? 0, stdout, stderr }))
          .on("data", (d) => { stdout += d.toString(); })
          .stderr.on("data", (d) => { stderr += d.toString(); });
      });
    });

    conn.on("error", (err) => finish(reject, err));

    conn.connect({
      host, port, username, password,
      readyTimeout: 20000,
      hostVerifier: () => true, // internal hosts; host keys rotate on clone
    });
  });
}
