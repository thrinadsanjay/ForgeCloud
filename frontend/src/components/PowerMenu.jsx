import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { IconPower } from "./icons.jsx";

// A compact "Power" dropdown for a resource row. `items` is a list of
// { key, label, icon, danger?, onClick }. The popover is positioned with
// fixed coordinates from the trigger's bounding box so it isn't clipped by the
// table card's `overflow: hidden`. The popover is rendered through a portal on
// document.body because the table card uses `backdrop-filter`, which would
// otherwise become the containing block for our fixed-positioned popover and
// throw off the viewport coordinates.
export default function PowerMenu({ items }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ top: 0, right: 0 });
  const btnRef = useRef(null);
  const disabled = !items.length;

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const onKey = (e) => { if (e.key === "Escape") setOpen(false); };
    // Any scroll or resize invalidates the anchored position — just close.
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
        title={disabled ? "No power actions available" : "Power options"}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <IconPower />
      </button>

      {open && createPortal(
        <>
          <div className="power-backdrop" onClick={() => setOpen(false)} />
          <div
            className="power-popover"
            role="menu"
            style={{ position: "fixed", top: pos.top, right: pos.right }}
          >
            {items.map((it) => (
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
