import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { IconPower } from "./icons.jsx";
import { positionNearAnchor } from "./AnchoredPopover.jsx";

// A compact "Power" dropdown for a resource row. `items` is a list of
// { key, label, icon, danger?, onClick }. Portal + fixed coords so table
// cards with overflow/backdrop-filter don't clip the menu.
export default function PowerMenu({ items }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ top: 0, right: 0 });
  const btnRef = useRef(null);
  const disabled = !items.length;

  useEffect(() => {
    if (!open) return;
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
    const next = positionNearAnchor(btnRef.current, {
      estimatedHeight: 8 + items.length * 40,
      estimatedWidth: 200,
      align: "end",
    });
    setPos({ top: next.top, right: next.right });
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
