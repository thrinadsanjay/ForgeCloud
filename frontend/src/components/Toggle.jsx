/**
 * Contextual boolean control — prefer this over native checkboxes.
 *
 * Variants (pick by surface):
 *   rail     — settings / default brand pill
 *   glow     — provision modal (soft brand halo when on)
 *   danger   — risky ops (skip TLS, force delete)
 *   ok       — enable / healthy / backup on
 *   capsule  — compact menus with On/Off text (prefs)
 *   square   — admin catalog / technical forms
 */
export default function Toggle({
  checked = false,
  onChange,
  variant = "rail",
  size = "md",
  disabled = false,
  label,
  description,
  id,
  className = "",
  title,
}) {
  const on = !!checked;
  return (
    <div className={`forge-toggle-wrap forge-toggle-wrap-${size} ${label || description ? "has-copy" : ""} ${className}`.trim()}>
      {(label || description) && (
        <div className="forge-toggle-copy">
          {label && (
            <label className="forge-toggle-label" htmlFor={id} onClick={(e) => e.preventDefault()}>
              {label}
            </label>
          )}
          {description && <span className="forge-toggle-desc">{description}</span>}
        </div>
      )}
      <button
        type="button"
        id={id}
        role="switch"
        aria-checked={on}
        aria-label={typeof label === "string" ? label : title}
        title={title}
        disabled={disabled}
        className={`forge-toggle forge-toggle-${variant} forge-toggle-${size} ${on ? "on" : ""}`}
        onClick={() => {
          if (disabled) return;
          onChange?.(!on);
        }}
      >
        <span className="forge-toggle-track" aria-hidden="true">
          {variant === "capsule" && (
            <span className={`forge-toggle-caption ${on ? "is-on" : ""}`}>{on ? "On" : "Off"}</span>
          )}
          <span className="forge-toggle-knob" />
        </span>
      </button>
    </div>
  );
}
