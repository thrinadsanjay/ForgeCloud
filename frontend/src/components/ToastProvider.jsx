import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";

/**
 * App-wide transient toasts (success / info / warn / error).
 *
 *   const { toast, success, info, warn, error } = useToast();
 *   success("Settings saved");
 *   toast({ tone: "warn", title: "VM stopped", message: "…", ttlMs: 12000, actions: [...] });
 *
 * Sticky toasts (ttlMs: 0) stay until dismissed — used for expiry reminders.
 */
const ToastContext = createContext(null);

let toastSeq = 0;
function nextId() {
  toastSeq += 1;
  return `t-${Date.now().toString(36)}-${toastSeq}`;
}

const TONE_ICON = {
  success: "✓",
  info: "ℹ",
  warn: "!",
  error: "⚠",
};

const DEFAULT_TTL = {
  success: 6000,
  info: 7000,
  warn: 12000,
  error: 15000,
};

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used inside <ToastProvider>");
  return ctx;
}

/** Optional hook — returns null helpers when outside provider (for rare shared modules). */
export function useToastOptional() {
  return useContext(ToastContext);
}

export function ToastProvider({ children }) {
  const [items, setItems] = useState([]);
  const timers = useRef(new Map());

  const dismiss = useCallback((id) => {
    const t = timers.current.get(id);
    if (t) {
      clearTimeout(t);
      timers.current.delete(id);
    }
    setItems((list) => list.filter((x) => x.id !== id));
  }, []);

  const toast = useCallback((opts) => {
    const tone = opts?.tone || "info";
    const id = opts?.id || nextId();
    const ttlMs = opts?.ttlMs != null
      ? opts.ttlMs
      : (DEFAULT_TTL[tone] ?? 8000);
    const entry = {
      id,
      tone,
      title: opts?.title || "",
      message: opts?.message || "",
      icon: opts?.icon || TONE_ICON[tone] || "ℹ",
      actions: Array.isArray(opts?.actions) ? opts.actions : [],
      sticky: ttlMs === 0,
    };

    setItems((list) => {
      // Replace existing toast with same id (useful for expiry refresh).
      const without = list.filter((x) => x.id !== id);
      return [...without, entry].slice(-8);
    });

    if (ttlMs > 0) {
      const prev = timers.current.get(id);
      if (prev) clearTimeout(prev);
      timers.current.set(id, setTimeout(() => dismiss(id), ttlMs));
    }
    return id;
  }, [dismiss]);

  const success = useCallback((title, message, extra) => toast({ tone: "success", title, message, ...extra }), [toast]);
  const info = useCallback((title, message, extra) => toast({ tone: "info", title, message, ...extra }), [toast]);
  const warn = useCallback((title, message, extra) => toast({ tone: "warn", title, message, ...extra }), [toast]);
  const error = useCallback((title, message, extra) => toast({ tone: "error", title, message, ...extra }), [toast]);

  const value = useMemo(
    () => ({ toast, success, info, warn, error, dismiss }),
    [toast, success, info, warn, error, dismiss],
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toast-stack" role="region" aria-label="Notifications">
        {items.map((t) => (
          <div key={t.id} className={`toast toast-${t.tone}`} role="status">
            <div className="toast-icon" aria-hidden="true">{t.icon}</div>
            <div className="toast-body">
              {t.title && <div className="toast-title">{t.title}</div>}
              {t.message && <div className="toast-msg">{t.message}</div>}
              {t.actions.length > 0 && (
                <div className="toast-actions">
                  {t.actions.map((a) => (
                    a.href ? (
                      <a
                        key={a.key || a.label}
                        className="toast-link"
                        href={a.href}
                        target={a.external ? "_blank" : undefined}
                        rel={a.external ? "noreferrer" : undefined}
                        onClick={() => { if (a.dismiss !== false) dismiss(t.id); }}
                      >
                        {a.label}
                      </a>
                    ) : (
                      <button
                        key={a.key || a.label}
                        type="button"
                        className="toast-link"
                        onClick={() => {
                          a.onClick?.();
                          if (a.dismiss !== false) dismiss(t.id);
                        }}
                      >
                        {a.label}
                      </button>
                    )
                  ))}
                </div>
              )}
            </div>
            <button type="button" className="toast-close" onClick={() => dismiss(t.id)} aria-label="Dismiss">×</button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
