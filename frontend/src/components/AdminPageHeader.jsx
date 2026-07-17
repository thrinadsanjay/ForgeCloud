/**
 * Shared Admin page chrome — breadcrumb, title, description, optional toolbar.
 * Content pages must NOT render their own secondary navigation.
 */
export default function AdminPageHeader({
  section = "Administration",
  title,
  description,
  actions,
  children,
}) {
  return (
    <header className="adm-page-header">
      <div className="adm-page-header-row">
        <div className="adm-page-header-text">
          <div className="adm-breadcrumb">{section}</div>
          <h1 className="adm-page-title">{title}</h1>
          {description && <p className="adm-page-desc">{description}</p>}
        </div>
        {actions && <div className="adm-page-actions">{actions}</div>}
      </div>
      {children}
    </header>
  );
}
