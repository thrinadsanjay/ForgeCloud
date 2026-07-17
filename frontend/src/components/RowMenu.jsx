import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

// A generic per-row dropdown (portal-positioned like PowerMenu so it isn't
// clipped by the table card). `items` is [{ key, label, icon, danger?, onClick }].
export default function RowMenu({ icon, title, items = [] }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ top: 0, right: 0 });
  const btnRef = useRef(null);
  const visible = items.filter(Boolean);
  const disabled = visible.length === 0;

  useEffect(() => {
    if (!open) return undefined;
    const close = () => setOpen(false);
    const onKey = (e) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    document.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const toggle = () => {
    if (open) { setOpen(false); return; }
    const rect = btnRef.current.getBoundingClientRect();
    setPos({ top: rect.bottom + 6, right: window.innerWidth - rect.right });
    setOpen(true);
  };

  return (
    <div className="power-menu">
      <button
        ref={btnRef}
        className={`icon-btn power-trigger ${open ? "power-trigger-open" : ""}`}
        disabled={disabled}
        onClick={toggle}
        title={title}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        {icon}
      </button>

      {open && createPortal(
        <>
          <div className="power-backdrop" onClick={() => setOpen(false)} />
          <div className="power-popover" role="menu" style={{ position: "fixed", top: pos.top, right: pos.right }}>
            {visible.map((it) => (
              <button
                key={it.key}
                type="button"
                role="menuitem"
                className={`power-item ${it.danger ? "power-item-danger" : ""}`}
                onClick={() => { setOpen(false); it.onClick(); }}
              >
                {it.icon}
                <span>{it.label}</span>
              </button>
            ))}
          </div>
        </>,
        document.body
      )}
    </div>
  );
}
