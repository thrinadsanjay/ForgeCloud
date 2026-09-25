import { Link } from "react-router-dom";

/**
 * Friendly empty / blocked panel for sparse pages.
 * Use actionHref + actionLabel for navigation, or onAction for a button.
 */
export default function EmptyState({
  icon = "◇",
  title,
  description,
  actionLabel,
  actionHref,
  onAction,
  secondaryLabel,
  secondaryHref,
  tone = "neutral",
}) {
  return (
    <div className={`empty-state empty-state-${tone}`} role="status">
      <div className="empty-state-icon" aria-hidden="true">{icon}</div>
      <h3 className="empty-state-title">{title}</h3>
      {description && <p className="empty-state-desc">{description}</p>}
      {(actionLabel || secondaryLabel) && (
        <div className="empty-state-actions">
          {actionLabel && actionHref && (
            <Link className="btn btn-primary" to={actionHref}>{actionLabel}</Link>
          )}
          {actionLabel && onAction && !actionHref && (
            <button type="button" className="btn btn-primary" onClick={onAction}>{actionLabel}</button>
          )}
          {secondaryLabel && secondaryHref && (
            <Link className="btn btn-ghost" to={secondaryHref}>{secondaryLabel}</Link>
          )}
        </div>
      )}
    </div>
  );
}
