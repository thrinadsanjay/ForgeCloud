import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { IconTag } from "./icons.jsx";
import { setResourceTags, autoTagResource } from "../api/client.js";

// user-*/group-* tags gate visibility and can't be removed from the UI.
const isProtected = (t) => t.startsWith("user-") || t.startsWith("group-");

export default function TagsMenu({ resource, onChanged }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ top: 0, right: 0 });
  const [tags, setTags] = useState(resource.tags || []);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const btnRef = useRef(null);

  // Reflect server-side tag changes from the periodic resource refresh.
  useEffect(() => { setTags(resource.tags || []); }, [resource.tags]);

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

  const descriptive = tags.filter((t) => !isProtected(t));

  const putTags = async (next) => {
    setBusy(true); setError("");
    try {
      const r = await setResourceTags(resource.type, resource.vmid, next);
      setTags(r.tags);
      onChanged?.();
    } catch (e) {
      setError(e.response?.data?.error || e.message);
    } finally {
      setBusy(false);
    }
  };

  const addTag = () => {
    const v = input.trim();
    if (!v) return;
    setInput("");
    putTags([...descriptive, v]);
  };

  const removeTag = (t) => putTags(descriptive.filter((x) => x !== t));

  const autoTag = async () => {
    setBusy(true); setError("");
    try {
      const r = await autoTagResource(resource.type, resource.vmid, resource.name);
      setTags(r.tags);
      onChanged?.();
    } catch (e) {
      setError(e.response?.data?.error || e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="power-menu">
      <button
        ref={btnRef}
        className={`icon-btn power-trigger ${open ? "power-trigger-open" : ""}`}
        onClick={toggle}
        title="Tags & info"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <IconTag />
      </button>

      {open && createPortal(
        <>
          <div className="power-backdrop" onClick={() => setOpen(false)} />
          <div className="tags-popover" style={{ position: "fixed", top: pos.top, right: pos.right }}>
            <div className="tags-pop-head">Tags</div>

            <div className="tags-chips">
              {tags.length === 0 && <span className="muted" style={{ fontSize: 12 }}>No tags yet</span>}
              {tags.map((t) => (
                <span key={t} className={`tag-chip ${isProtected(t) ? "tag-chip-locked" : ""}`}>
                  {t}
                  {!isProtected(t) && (
                    <button className="tag-chip-x" title="Remove" disabled={busy} onClick={() => removeTag(t)}>×</button>
                  )}
                </span>
              ))}
            </div>

            <div className="tags-add">
              <input
                className="ch-input"
                placeholder="Add a tag"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addTag(); } }}
              />
              <button className="btn btn-ghost btn-sm" disabled={busy || !input.trim()} onClick={addTag}>Add</button>
            </div>

            <button className="tags-auto-btn" disabled={busy} onClick={autoTag}>
              {busy ? "Working…" : "✨ Auto-tag from apps, env & name"}
            </button>

            {error && <div className="tags-err">{error}</div>}
          </div>
        </>,
        document.body
      )}
    </div>
  );
}
