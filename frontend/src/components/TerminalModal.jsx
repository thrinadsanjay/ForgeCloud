import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

function LoginForm({ hostname, ip, onConnect }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!username.trim()) { setError("Username is required"); return; }
    if (!password) { setError("Password is required"); return; }
    onConnect({ username: username.trim(), password });
  };

  return (
    <div className="terminal-login">
      <div className="terminal-login-icon">⬡</div>
      <h3>{hostname}</h3>
      <p className="terminal-login-ip">{ip}</p>
      <form onSubmit={handleSubmit}>
        <label>
          Username
          <input
            type="text"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoFocus
            autoComplete="username"
          />
        </label>
        <label>
          Password
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
          />
        </label>
        {error && <p className="terminal-login-error">{error}</p>}
        <button type="submit" className="btn btn-primary" style={{ width: "100%" }}>Connect</button>
      </form>
    </div>
  );
}

function SshTerminal({ vmid, ip, hostname, credentials, onClose }) {
  const containerRef = useRef(null);

  useEffect(() => {
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: '"Cascadia Code", "Fira Code", "Consolas", monospace',
      theme: {
        background: "#1a1a2e",
        foreground: "#e2e8f0",
        cursor: "#6366f1",
        selectionBackground: "#6366f150",
        black: "#1a1a2e", brightBlack: "#4a5568",
        red: "#fc8181", brightRed: "#feb2b2",
        green: "#68d391", brightGreen: "#9ae6b4",
        yellow: "#f6e05e", brightYellow: "#faf089",
        blue: "#76e4f7", brightBlue: "#bee3f8",
        magenta: "#b794f4", brightMagenta: "#d6bcfa",
        cyan: "#81e6d9", brightCyan: "#b2f5ea",
        white: "#e2e8f0", brightWhite: "#ffffff",
      },
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(containerRef.current);
    fitAddon.fit();
    term.writeln(`\x1b[1;34mConnecting to ${hostname} (${ip}) as ${credentials.username}...\x1b[0m`);

    const { cols, rows } = term;
    // The proxy resolves the IP from the VMID server-side and authorizes the
    // connection against the JWT — the browser never dictates the target host.
    const token = localStorage.getItem("forge_token") || localStorage.getItem("ssp_token") || "";
    const wsUrl = `ws://${window.location.host}/ws/ssh?vmid=${encodeURIComponent(vmid)}&token=${encodeURIComponent(token)}&cols=${cols}&rows=${rows}`;
    const ws = new WebSocket(wsUrl);
    ws.binaryType = "arraybuffer";

    // React StrictMode runs effects mount→cleanup→mount in dev. If cleanup fires
    // while the socket is still CONNECTING, calling ws.close() throws the
    // "closed before the connection is established" warning and aborts the handshake.
    // Track disposal and, if we're torn down mid-connect, close cleanly on open instead.
    let disposed = false;

    ws.onopen = () => {
      if (disposed) { ws.close(); return; }
      // Send credentials as first message before any input
      ws.send(JSON.stringify({
        type: "auth",
        username: credentials.username,
        password: credentials.password,
      }));

      term.onData((data) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(data);
      });
    };

    ws.onmessage = (e) => {
      if (e.data instanceof ArrayBuffer) {
        term.write(new Uint8Array(e.data));
      } else {
        term.write(e.data);
      }
    };

    ws.onerror = () => {
      term.writeln("\r\n\x1b[1;31mWebSocket error — check backend logs.\x1b[0m");
    };

    ws.onclose = () => {
      term.writeln("\r\n\x1b[1;33mConnection closed.\x1b[0m");
    };

    const resizeObserver = new ResizeObserver(() => {
      // While minimized the terminal is display:none (no layout box); fitting to a
      // zero-size element throws. Skip until it's visible again — the observer
      // re-fires with real dimensions when the panel is restored.
      if (!containerRef.current || containerRef.current.offsetParent === null) return;
      fitAddon.fit();
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
      }
    });
    resizeObserver.observe(containerRef.current);

    return () => {
      disposed = true;
      resizeObserver.disconnect();
      // Only close a socket that has actually opened; a CONNECTING socket is
      // closed by the onopen handler above once the handshake completes.
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CLOSING) {
        ws.close();
      }
      term.dispose();
    };
  }, [vmid, ip, hostname, credentials]);

  return <div className="terminal-body" ref={containerRef} />;
}

export default function TerminalModal({ vmid, ip, hostname, onClose }) {
  const [credentials, setCredentials] = useState(null);
  const [minimized, setMinimized] = useState(false);

  // Clicking the backdrop minimizes an active session (keeping the SSH
  // connection alive, like the chat/monitor panels) rather than tearing it
  // down. Before login there's nothing to preserve, so it just closes.
  const handleBackdropClick = (e) => {
    if (e.target !== e.currentTarget) return;
    if (credentials) setMinimized(true);
    else onClose();
  };

  return (
    <>
      {/* The overlay stays mounted while minimized (just display:none) so the
          SshTerminal — and its WebSocket — is never unmounted. */}
      <div
        className={`terminal-overlay ${minimized ? "terminal-overlay-hidden" : ""}`}
        onClick={handleBackdropClick}
      >
        <div className={`terminal-modal ${!credentials ? "terminal-modal-login" : ""}`}>
          <div className="terminal-modal-header">
            <span>
              <span className="terminal-dot green" />
              <span className="terminal-dot yellow" />
              <span className="terminal-dot red" />
              &nbsp;&nbsp;{hostname} — {ip}
            </span>
            <span className="terminal-header-actions">
              {credentials && (
                <button
                  className="terminal-min-btn"
                  onClick={() => setMinimized(true)}
                  title="Minimize session"
                  aria-label="Minimize session"
                >−</button>
              )}
              <button className="close-btn" onClick={onClose} title="Close session" aria-label="Close session">×</button>
            </span>
          </div>

          {!credentials
            ? <LoginForm hostname={hostname} ip={ip} onConnect={setCredentials} />
            : <SshTerminal vmid={vmid} ip={ip} hostname={hostname} credentials={credentials} onClose={onClose} />
          }
        </div>
      </div>

      {minimized && credentials && (
        <button
          className="terminal-min-pill"
          onClick={() => setMinimized(false)}
          title="Restore SSH session"
        >
          <span className="terminal-dot green" />
          <span className="terminal-min-pill-label">{hostname} — SSH</span>
          <span className="terminal-min-pill-restore" aria-hidden="true">▢</span>
        </button>
      )}
    </>
  );
}

