import { useEffect, useRef, useState } from "react";
import { getExpiringResources } from "../api/client.js";
import ExtendExpiryModal from "./ExtendExpiryModal.jsx";

// How far ahead we warn, and how often we re-check while the app is open.
const WARN_WITHIN_DAYS = 7;
const POLL_MS = 30 * 60 * 1000; // re-check every 30 minutes

// Local calendar day, used to throttle a resource's reminder to once per day.
function today() {
  const d = new Date();
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}
const LEGACY_DISMISS_PREFIX = "ssp_expiry_dismissed_";
const dismissKey = (vmid) => `forge_expiry_dismissed_${vmid}`;

function wasDismissedToday(vmid) {
  try {
    const key = dismissKey(vmid);
    if (localStorage.getItem(key) === today()) return true;
    return localStorage.getItem(`${LEGACY_DISMISS_PREFIX}${vmid}`) === today();
  } catch {
    return false;
  }
}
function markDismissedToday(vmid) {
  try {
    localStorage.setItem(dismissKey(vmid), today());
  } catch {
    /* ignore storage errors */
  }
}

function describe(r) {
  if (r.expired) return "has expired and been powered off. Request a renewal to restore access.";
  if (r.daysLeft <= 0) return "expires today and will be powered off unless renewed.";
  if (r.daysLeft === 1) return "will be powered off tomorrow unless renewed.";
  return `will be powered off in ${r.daysLeft} days unless renewed.`;
}

// Watches the caller's resources and raises a daily toast for any that will be
// decommissioned within a week, offering a Renew action. Once dismissed, a
// resource's toast stays hidden until the next calendar day.
export default function ExpiryNotifier() {
  const [items, setItems] = useState([]);       // expiring resources currently shown
  const [renewTarget, setRenewTarget] = useState(null);
  const cancelled = useRef(false);

  const refresh = async () => {
    try {
      const rows = await getExpiringResources(WARN_WITHIN_DAYS);
      if (cancelled.current) return;
      setItems(rows.filter((r) => !wasDismissedToday(r.vmid)));
    } catch {
      /* transient — keep the current list and try again next tick */
    }
  };

  useEffect(() => {
    cancelled.current = false;
    refresh();
    const t = setInterval(refresh, POLL_MS);
    return () => { cancelled.current = true; clearInterval(t); };
  }, []);

  const dismiss = (vmid) => {
    markDismissedToday(vmid);
    setItems((list) => list.filter((r) => r.vmid !== vmid));
  };

  if (items.length === 0 && !renewTarget) return null;

  return (
    <>
      <div className="toast-stack" role="region" aria-label="Expiry reminders">
        {items.map((r) => (
          <div key={r.vmid} className={`toast ${r.expired ? "toast-error" : "toast-warn"}`} role="alert">
            <div className="toast-icon" aria-hidden="true">⏳</div>
            <div className="toast-body">
              <div className="toast-title">
                {r.type === "container" ? "Container" : "VM"} {r.name} {r.expired ? "expired" : "expiring soon"}
              </div>
              <div className="toast-msg">
                <strong>{r.name}</strong> (VMID {r.vmid}) {describe(r)}
              </div>
              <div className="toast-actions">
                <button className="toast-link" onClick={() => setRenewTarget(r)}>Renew</button>
                <button className="toast-link" onClick={() => dismiss(r.vmid)}>Remind me tomorrow</button>
              </div>
            </div>
            <button className="toast-close" onClick={() => dismiss(r.vmid)} aria-label="Dismiss">×</button>
          </div>
        ))}
      </div>

      {renewTarget && (
        <ExtendExpiryModal
          resource={renewTarget}
          onClose={() => setRenewTarget(null)}
          onSaved={() => {
            // Renewed — clear this reminder and re-check the window.
            setItems((list) => list.filter((r) => r.vmid !== renewTarget.vmid));
            setTimeout(refresh, 600);
          }}
        />
      )}
    </>
  );
}
