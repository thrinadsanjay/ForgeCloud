import { createContext, useCallback, useContext, useRef, useState } from "react";

// App-wide replacement for the browser's confirm()/alert() prompts: a custom
// floating dialog centered on the page. Use via the useDialog() hook:
//   const { confirm, alert } = useDialog();
//   if (!(await confirm({ title, message, tone: "danger" }))) return;
//   await alert({ title: "Done", message: "…" });
const DialogContext = createContext(null);

export function useDialog() {
  const ctx = useContext(DialogContext);
  if (!ctx) throw new Error("useDialog must be used inside <DialogProvider>");
  return ctx;
}

// Accept either a plain string or an options object.
function normalize(input, defaults) {
  const o = typeof input === "string" ? { message: input } : (input || {});
  return { ...defaults, ...o };
}

export function DialogProvider({ children }) {
  const [dialog, setDialog] = useState(null);
  const resolverRef = useRef(null);

  const settle = useCallback((result) => {
    const resolve = resolverRef.current;
    resolverRef.current = null;
    setDialog(null);
    if (resolve) resolve(result);
  }, []);

  const confirm = useCallback((opts) => new Promise((resolve) => {
    resolverRef.current = resolve;
    setDialog({
      mode: "confirm",
      ...normalize(opts, { title: "Please confirm", confirmLabel: "Confirm", cancelLabel: "Cancel", tone: "default" }),
    });
  }), []);

  const alert = useCallback((opts) => new Promise((resolve) => {
    resolverRef.current = resolve;
    setDialog({
      mode: "alert",
      ...normalize(opts, { title: "Notice", confirmLabel: "OK", tone: "default" }),
    });
  }), []);

  const value = { confirm, alert };

  return (
    <DialogContext.Provider value={value}>
      {children}
      {dialog && (
        <div
          className="dialog-overlay"
          onClick={(e) => { if (e.target === e.currentTarget) settle(dialog.mode === "confirm" ? false : undefined); }}
          onKeyDown={(e) => { if (e.key === "Escape") settle(dialog.mode === "confirm" ? false : undefined); }}
          role="presentation"
        >
          <div className="dialog-card" role="alertdialog" aria-modal="true" aria-label={dialog.title}>
            <div className={`dialog-icon dialog-icon-${dialog.tone}`} aria-hidden="true">
              {dialog.tone === "danger" ? "⚠" : dialog.mode === "confirm" ? "?" : "ℹ"}
            </div>
            {dialog.title && <h3 className="dialog-title">{dialog.title}</h3>}
            {dialog.message && <p className="dialog-message">{dialog.message}</p>}
            <div className="dialog-actions">
              {dialog.mode === "confirm" && (
                <button type="button" className="btn btn-ghost" onClick={() => settle(false)} autoFocus>
                  {dialog.cancelLabel}
                </button>
              )}
              <button
                type="button"
                className={`btn ${dialog.tone === "danger" ? "btn-danger" : "btn-primary"}`}
                onClick={() => settle(dialog.mode === "confirm" ? true : undefined)}
              >
                {dialog.confirmLabel}
              </button>
            </div>
          </div>
        </div>
      )}
    </DialogContext.Provider>
  );
}
