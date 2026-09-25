import { useEffect, useRef, useState } from "react";

function authToken() {
  return localStorage.getItem("forge_token") || localStorage.getItem("ssp_token") || "";
}

/**
 * Live log follower over a Forge WebSocket (docker-logs / k8s-logs).
 * @param {{ title: string, wsPath: string, params: Record<string,string>, onClose: () => void }} props
 */
export default function LiveLogsModal({ title, wsPath, params, onClose }) {
  const preRef = useRef(null);
  const [status, setStatus] = useState("Connecting…");
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(false);
  const bufferRef = useRef("");

  useEffect(() => {
    pausedRef.current = paused;
  }, [paused]);

  useEffect(() => {
    const wsProto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const q = new URLSearchParams({ token: authToken(), tail: "200", ...params });
    const ws = new WebSocket(`${wsProto}//${window.location.host}${wsPath}?${q}`);
    let disposed = false;

    ws.onopen = () => {
      if (!disposed) setStatus("Live");
    };
    ws.onmessage = (e) => {
      if (disposed) return;
      const chunk = typeof e.data === "string" ? e.data : new TextDecoder().decode(e.data);
      bufferRef.current += chunk;
      if (bufferRef.current.length > 500_000) {
        bufferRef.current = bufferRef.current.slice(-400_000);
      }
      if (!pausedRef.current && preRef.current) {
        preRef.current.textContent = bufferRef.current;
        preRef.current.scrollTop = preRef.current.scrollHeight;
      }
    };
    ws.onerror = () => {
      if (!disposed) setStatus("Error");
    };
    ws.onclose = () => {
      if (!disposed) setStatus("Disconnected");
    };

    return () => {
      disposed = true;
      try { ws.close(); } catch { /* ignore */ }
    };
  }, [wsPath, JSON.stringify(params)]);

  const resume = () => {
    setPaused(false);
    if (preRef.current) {
      preRef.current.textContent = bufferRef.current;
      preRef.current.scrollTop = preRef.current.scrollHeight;
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card deploy-log-modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 960 }}>
        <div className="modal-header">
          <h3>{title}</h3>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <span className={`badge ${status === "Live" ? "badge-running" : "badge-neutral"}`} style={{ fontSize: 11 }}>
              {status}
            </span>
            {paused ? (
              <button type="button" className="btn btn-ghost btn-sm" onClick={resume}>Resume</button>
            ) : (
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setPaused(true)}>Pause</button>
            )}
            <button className="ds-close" onClick={onClose} aria-label="Close">×</button>
          </div>
        </div>
        <div className="modal-body">
          <pre
            ref={preRef}
            className="mono"
            style={{ margin: 0, maxHeight: "65vh", overflow: "auto", whiteSpace: "pre-wrap", fontSize: 12.5 }}
          >
            Connecting…
          </pre>
        </div>
      </div>
    </div>
  );
}
