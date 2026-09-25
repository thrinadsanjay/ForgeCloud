/**
 * Banner shown when a provisioning backend (Proxmox / K3s / Docker) is down.
 */
export default function ProviderStatusBanner({
  providerLabel,
  checking,
  blocked,
  message,
  error,
  hosts = null,
  onRetry,
}) {
  if (checking && !blocked) {
    return (
      <div className="provider-status-banner provider-status-checking" role="status">
        Checking {providerLabel} connectivity…
      </div>
    );
  }

  if (!blocked) return null;

  const failedHosts = Array.isArray(hosts)
    ? hosts.filter((h) => !h.ok && h.error)
    : [];

  return (
    <div className="provider-status-banner provider-status-down" role="alert">
      <div className="provider-status-banner-body">
        <strong>{message || `${providerLabel} is down or unreachable`}</strong>
        {error && error !== message && failedHosts.length === 0 && (
          <span className="provider-status-detail">{error}</span>
        )}
        {failedHosts.length > 0 && (
          <ul className="provider-status-host-errors" style={{ margin: "8px 0 0", paddingLeft: 18 }}>
            {failedHosts.map((h) => (
              <li key={h.id || h.endpoint || h.name}>
                <strong>{h.name || h.endpoint || h.id}</strong>
                {h.endpoint ? ` (${h.endpoint})` : ""}: {h.error}
              </li>
            ))}
          </ul>
        )}
        <span className="provider-status-hint">
          Template selection and deploy actions are disabled until connectivity is restored.
        </span>
      </div>
      {onRetry && (
        <button type="button" className="btn btn-ghost btn-sm" onClick={onRetry} disabled={checking}>
          {checking ? "Checking…" : "Retry"}
        </button>
      )}
    </div>
  );
}
