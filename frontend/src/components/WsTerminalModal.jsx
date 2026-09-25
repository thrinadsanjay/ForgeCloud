import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

function authToken() {
  return localStorage.getItem("forge_token") || localStorage.getItem("ssp_token") || "";
}

function buildWsUrl(path, params) {
  const wsProto = window.location.protocol === "https:" ? "wss:" : "ws:";
  const q = new URLSearchParams({ token: authToken(), ...params });
  return `${wsProto}//${window.location.host}${path}?${q}`;
}

/**
 * Interactive terminal over a Forge WebSocket proxy (docker-exec / k8s-exec).
 * @param {{ title: string, subtitle?: string, wsPath: string, params: Record<string,string>, onClose: () => void }} props
 */
export default function WsTerminalModal({ title, subtitle = "", wsPath, params, onClose }) {
  const containerRef = useRef(null);
  const [minimized, setMinimized] = useState(false);

  useEffect(() => {
    if (!containerRef.current) return undefined;

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: '"Cascadia Code", "Fira Code", "Consolas", monospace',
      theme: {
        background: "#1a1a2e",
        foreground: "#e2e8f0",
        cursor: "#6366f1",
        selectionBackground: "#6366f150",
      },
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(containerRef.current);
    fitAddon.fit();

    const ws = new WebSocket(buildWsUrl(wsPath, params));
    let disposed = false;
    let sawOpen = false;

    ws.onopen = () => {
      if (disposed) { ws.close(); return; }
      sawOpen = true;
      term.onData((data) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(data);
      });
    };
    ws.onmessage = (e) => {
      if (e.data instanceof ArrayBuffer) term.write(new Uint8Array(e.data));
      else term.write(e.data);
    };
    ws.onerror = () => {
      if (!disposed) term.writeln("\r\n\x1b[1;31mWebSocket error.\x1b[0m");
    };
    ws.onclose = () => {
      if (!disposed) {
        term.writeln(sawOpen
          ? "\r\n\x1b[1;33mSession closed.\x1b[0m"
          : "\r\n\x1b[1;31mCould not connect.\x1b[0m");
      }
    };

    const ro = new ResizeObserver(() => {
      if (!containerRef.current || containerRef.current.offsetParent === null) return;
      fitAddon.fit();
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
      }
    });
    ro.observe(containerRef.current);

    return () => {
      disposed = true;
      ro.disconnect();
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CLOSING) ws.close();
      term.dispose();
    };
  }, [wsPath, JSON.stringify(params)]);

  const handleBackdrop = (e) => {
    if (e.target !== e.currentTarget) return;
    setMinimized(true);
  };

  return (
    <>
      <div
        className={`terminal-overlay ${minimized ? "terminal-overlay-hidden" : ""}`}
        onClick={handleBackdrop}
      >
        <div className="terminal-modal">
          <div className="terminal-modal-header">
            <span>
              <span className="terminal-dot green" />
              <span className="terminal-dot yellow" />
              <span className="terminal-dot red" />
              &nbsp;&nbsp;{title}{subtitle ? ` — ${subtitle}` : ""}
            </span>
            <span className="terminal-header-actions">
              <button className="terminal-min-btn" onClick={() => setMinimized(true)} title="Minimize" aria-label="Minimize">−</button>
              <button className="close-btn" onClick={onClose} title="Close" aria-label="Close">×</button>
            </span>
          </div>
          <div className="terminal-body" ref={containerRef} />
        </div>
      </div>
      {minimized && (
        <button className="terminal-min-pill" onClick={() => setMinimized(false)} title="Restore terminal">
          <span className="terminal-dot green" />
          <span className="terminal-min-pill-label">{title}</span>
          <span className="terminal-min-pill-restore" aria-hidden="true">▢</span>
        </button>
      )}
    </>
  );
}
