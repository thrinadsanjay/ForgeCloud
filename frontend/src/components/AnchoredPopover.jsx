import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/**
 * Position a fixed popover next to an anchor element, flipping above when
 * there isn't enough room below (short lists / bottom rows).
 */
export function positionNearAnchor(anchorEl, {
  gap = 6,
  estimatedHeight = 220,
  estimatedWidth = 200,
  align = "end", // "end" | "start"
} = {}) {
  if (!anchorEl) return { top: 0, left: 0, right: "auto" };
  const rect = anchorEl.getBoundingClientRect();
  const spaceBelow = window.innerHeight - rect.bottom - gap;
  const spaceAbove = rect.top - gap;
  const openUp = spaceBelow < Math.min(estimatedHeight, 160) && spaceAbove > spaceBelow;

  const top = openUp
    ? Math.max(8, rect.top - gap - estimatedHeight)
    : Math.min(window.innerHeight - 8, rect.bottom + gap);

  if (align === "start") {
    const left = Math.min(
      Math.max(8, rect.left),
      window.innerWidth - estimatedWidth - 8,
    );
    return { top, left, right: "auto", openUp };
  }

  const right = Math.max(8, window.innerWidth - rect.right);
  return { top, right, left: "auto", openUp };
}

/**
 * Portal + fixed positioning so menus aren't clipped by overflow:hidden cards
 * (adm-table-wrap, grp cards, pkg grids, etc.).
 */
export default function AnchoredPopover({
  open,
  anchorRef,
  onClose,
  className = "",
  role = "menu",
  align = "end",
  estimatedHeight = 220,
  estimatedWidth = 200,
  gap = 6,
  closeOnScroll = true,
  children,
}) {
  const panelRef = useRef(null);
  const [style, setStyle] = useState({ top: 0, right: 8, left: "auto" });

  const place = () => {
    const el = anchorRef?.current;
    if (!el) return;
    const next = positionNearAnchor(el, { gap, estimatedHeight, estimatedWidth, align });
    // If we guessed height wrong for "open up", re-measure after paint via layout effect.
    setStyle({
      position: "fixed",
      top: next.top,
      right: next.right,
      left: next.left,
      zIndex: 400,
    });
  };

  useLayoutEffect(() => {
    if (!open) return undefined;
    place();
    // After first paint, if opening upward, pin bottom edge to anchor top.
    const el = anchorRef?.current;
    const panel = panelRef.current;
    if (!el || !panel) return undefined;
    const rect = el.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.bottom - gap;
    const h = panel.offsetHeight || estimatedHeight;
    if (spaceBelow < h && rect.top > spaceBelow) {
      setStyle({
        position: "fixed",
        top: Math.max(8, rect.top - gap - h),
        right: align === "end" ? Math.max(8, window.innerWidth - rect.right) : "auto",
        left: align === "start"
          ? Math.min(Math.max(8, rect.left), window.innerWidth - (panel.offsetWidth || estimatedWidth) - 8)
          : "auto",
        zIndex: 400,
      });
    }
    return undefined;
  }, [open, align, estimatedHeight, estimatedWidth, gap]);

  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e) => {
      const t = e.target;
      if (panelRef.current?.contains(t)) return;
      if (anchorRef?.current?.contains?.(t)) return;
      onClose?.();
    };
    const onKey = (e) => { if (e.key === "Escape") onClose?.(); };
    const onReposition = () => {
      if (closeOnScroll) onClose?.();
      else place();
    };
    document.addEventListener("pointerdown", onDoc);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", onReposition);
    if (closeOnScroll) window.addEventListener("scroll", onReposition, true);
    return () => {
      document.removeEventListener("pointerdown", onDoc);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onReposition);
      if (closeOnScroll) window.removeEventListener("scroll", onReposition, true);
    };
  }, [open, onClose, closeOnScroll, anchorRef]);

  if (!open) return null;

  return createPortal(
    <>
      <div className="anchored-popover-backdrop" onClick={onClose} aria-hidden="true" />
      <div
        ref={panelRef}
        className={`anchored-popover ${className}`.trim()}
        role={role}
        style={style}
      >
        {children}
      </div>
    </>,
    document.body,
  );
}
