import { useCallback, useEffect, useRef, useState } from "react";

const LEAVE_MS = 220;

/**
 * Floating panel open/close with leave animation + outside click / Escape.
 */
export function useFloatingPanel({ ignoreSelectors = [] } = {}) {
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [phase, setPhase] = useState("closed"); // closed | open | leaving
  const panelRef = useRef(null);
  const leaveTimer = useRef(null);
  const ignoreRef = useRef(ignoreSelectors);
  ignoreRef.current = ignoreSelectors;

  const clearLeave = () => {
    if (leaveTimer.current) {
      clearTimeout(leaveTimer.current);
      leaveTimer.current = null;
    }
  };

  const openPanel = useCallback(() => {
    clearLeave();
    setMounted(true);
    setOpen(true);
    setPhase("open");
  }, []);

  const closePanel = useCallback(() => {
    setPhase((prev) => {
      if (prev === "closed" || prev === "leaving") return prev;
      clearLeave();
      leaveTimer.current = setTimeout(() => {
        setMounted(false);
        setOpen(false);
        setPhase("closed");
        leaveTimer.current = null;
      }, LEAVE_MS);
      return "leaving";
    });
    setOpen(false);
  }, []);

  useEffect(() => () => clearLeave(), []);

  useEffect(() => {
    if (!mounted || phase === "leaving" || phase === "closed") return undefined;

    const shouldIgnore = (target) => {
      if (!(target instanceof Element)) return true;
      const selectors = [
        ".modal-overlay",
        ".terminal-overlay",
        "[role='dialog']",
        ...(ignoreRef.current || []),
      ];
      return selectors.some((sel) => {
        try { return !!target.closest(sel); } catch { return false; }
      });
    };

    const onPointerDown = (e) => {
      const target = e.target;
      if (shouldIgnore(target)) return;
      if (panelRef.current?.contains(target)) return;
      closePanel();
    };

    const onKey = (e) => {
      if (e.key === "Escape") closePanel();
    };

    const t = window.setTimeout(() => {
      document.addEventListener("pointerdown", onPointerDown);
      document.addEventListener("keydown", onKey);
    }, 10);

    return () => {
      window.clearTimeout(t);
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [mounted, phase, closePanel]);

  return {
    /** True while fully interactive (not mid-leave). */
    isOpen: phase === "open",
    mounted,
    phase,
    panelRef,
    openPanel,
    closePanel,
  };
}
