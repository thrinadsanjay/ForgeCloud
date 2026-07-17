import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { IconCamera, IconRestore, IconArchive, IconChevronDown } from "./icons.jsx";

// A single dropdown button per resource row for snapshot / restore / backup.
// Positioned via a portal (like PowerMenu) so the table card's overflow and
// backdrop-filter don't clip it.
export default function SnapshotMenu({ onTake, onRestore, onBackup }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ top: 0, right: 0 });
  const btnRef = useRef(null);

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

  const items = [
    { key: "take", label: "Take snapshot", icon: <IconCamera size={15} />, onClick: onTake },
    { key: "restore", label: "Restore snapshot", icon: <IconRestore size={15} />, onClick: onRestore },
    { key: "backup", label: "Configure backup", icon: <IconArchive size={15} />, onClick: onBackup },
  ];

  return (
    <div className="power-menu">
      <button
        ref={btnRef}
        className={`icon-btn power-trigger snap-trigger ${open ? "power-trigger-open" : ""}`}
        onClick={toggle}
        title="Snapshots & backups"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <IconCamera />
        <IconChevronDown size={12} style={{ marginLeft: -2 }} />
      </button>

      {open && createPortal(
        <>
          <div className="power-backdrop" onClick={() => setOpen(false)} />
          <div className="power-popover" role="menu" style={{ position: "fixed", top: pos.top, right: pos.right }}>
            {items.map((it) => (
              <button
                key={it.key}
                type="button"
                role="menuitem"
                className="power-item"
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
