import { useRef, useState } from "react";

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;

function formatMax(maxBytes) {
  if (maxBytes >= 1024 * 1024) return `${Math.round(maxBytes / (1024 * 1024))} MB`;
  return `${Math.round(maxBytes / 1024)} KB`;
}

/**
 * Load a text file into a settings field.
 * variants: "button" (default), "inline" (beside input + OR), "dropzone" (drag/drop panel)
 */
export default function TextFileInput({
  onLoad,
  accept = "text/*",
  label = "Upload file",
  disabled = false,
  maxBytes = DEFAULT_MAX_BYTES,
  variant = "button",
  formatsHint = "",
}) {
  const inputRef = useRef(null);
  const [fileName, setFileName] = useState("");
  const [error, setError] = useState("");
  const [dragging, setDragging] = useState(false);

  const applyFile = async (file) => {
    if (!file) return;
    setError("");
    if (file.size > maxBytes) {
      setFileName("");
      setError(`File is too large (maximum ${formatMax(maxBytes)}).`);
      return;
    }
    try {
      const text = await file.text();
      onLoad(text, file);
      setFileName(file.name);
    } catch (err) {
      setFileName("");
      setError(err.message || "Could not read file.");
    }
  };

  const onPick = async (event) => {
    const file = event.target.files?.[0];
    await applyFile(file);
    event.target.value = "";
  };

  const onDrop = async (e) => {
    e.preventDefault();
    e.stopPropagation();
    setDragging(false);
    if (disabled) return;
    const file = e.dataTransfer?.files?.[0];
    await applyFile(file);
  };

  const hidden = (
    <input
      ref={inputRef}
      type="file"
      accept={accept}
      onChange={onPick}
      disabled={disabled}
      className="ans-file-hidden"
      tabIndex={-1}
    />
  );

  if (variant === "dropzone") {
    return (
      <div className="ans-dropzone-wrap">
        {hidden}
        <button
          type="button"
          className={`ans-dropzone ${dragging ? "is-drag" : ""} ${disabled ? "is-disabled" : ""}`}
          disabled={disabled}
          onClick={() => inputRef.current?.click()}
          onDragEnter={(e) => { e.preventDefault(); setDragging(true); }}
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={(e) => { e.preventDefault(); setDragging(false); }}
          onDrop={onDrop}
        >
          <span className="ans-dropzone-icon" aria-hidden="true">⬆</span>
          <strong>Drag and drop private key file here</strong>
          <span className="muted">or</span>
          <span className="btn btn-ghost btn-sm ans-dropzone-btn">Choose file</span>
          <em className="ans-dropzone-meta">
            {formatsHint || `Max ${formatMax(maxBytes)}`}
          </em>
          {fileName && <span className="ans-file-loaded">Loaded {fileName}</span>}
        </button>
        {error && <span className="login-error ans-file-err">{error}</span>}
      </div>
    );
  }

  if (variant === "inline") {
    return (
      <div className="ans-upload-inline">
        {hidden}
        <button
          type="button"
          className="btn btn-ghost btn-sm ans-upload-btn"
          onClick={() => inputRef.current?.click()}
          disabled={disabled}
        >
          <span aria-hidden="true">⬆</span> {label}
        </button>
        {fileName && <span className="muted ans-file-name">Loaded {fileName}</span>}
        {error && <span className="login-error ans-file-err">{error}</span>}
      </div>
    );
  }

  return (
    <div className="ans-upload-button">
      {hidden}
      <button
        type="button"
        className="btn btn-ghost btn-sm"
        onClick={() => inputRef.current?.click()}
        disabled={disabled}
      >
        {label}
      </button>
      {fileName && <span className="muted" style={{ fontSize: 12 }}>Loaded {fileName}</span>}
      {error && <span className="login-error" style={{ fontSize: 12 }}>{error}</span>}
    </div>
  );
}
