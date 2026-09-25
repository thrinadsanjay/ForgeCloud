import { useEffect, useRef, useState } from "react";
import { getExpiringResources } from "../api/client.js";
import ExtendExpiryModal from "./ExtendExpiryModal.jsx";
import { useToast } from "./ToastProvider.jsx";

const WARN_WITHIN_DAYS = 7;
const POLL_MS = 30 * 60 * 1000;

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
  } catch { /* ignore */ }
}

function describe(r) {
  if (r.expired) return "has expired and been powered off. Request a renewal to restore access.";
  if (r.daysLeft <= 0) return "expires today and will be powered off unless renewed.";
  if (r.daysLeft === 1) return "will be powered off tomorrow unless renewed.";
  return `will be powered off in ${r.daysLeft} days unless renewed.`;
}

/**
 * Daily sticky toasts for resources expiring within a week (or already expired).
 */
export default function ExpiryNotifier() {
  const { toast, dismiss } = useToast();
  const [renewTarget, setRenewTarget] = useState(null);
  const shown = useRef(new Set());
  const cancelled = useRef(false);

  const refresh = async () => {
    try {
      const rows = await getExpiringResources(WARN_WITHIN_DAYS);
      if (cancelled.current) return;
      const visible = rows.filter((r) => !wasDismissedToday(r.vmid));
      const visibleIds = new Set(visible.map((r) => r.vmid));

      for (const id of [...shown.current]) {
        if (!visibleIds.has(id)) {
          dismiss(`expiry-${id}`);
          shown.current.delete(id);
        }
      }

      for (const r of visible) {
        const id = `expiry-${r.vmid}`;
        shown.current.add(r.vmid);
        toast({
          id,
          tone: r.expired ? "error" : "warn",
          icon: "⏳",
          ttlMs: 0,
          title: `${r.type === "container" ? "Container" : "VM"} ${r.name} ${r.expired ? "expired" : "expiring soon"}`,
          message: `${r.name} (VMID ${r.vmid}) ${describe(r)}`,
          actions: [
            {
              key: "renew",
              label: "Renew",
              dismiss: false,
              onClick: () => setRenewTarget(r),
            },
            {
              key: "later",
              label: "Remind me tomorrow",
              onClick: () => {
                markDismissedToday(r.vmid);
                shown.current.delete(r.vmid);
              },
            },
          ],
        });
      }
    } catch {
      /* transient */
    }
  };

  useEffect(() => {
    cancelled.current = false;
    refresh();
    const t = setInterval(refresh, POLL_MS);
    return () => { cancelled.current = true; clearInterval(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return renewTarget ? (
    <ExtendExpiryModal
      resource={renewTarget}
      onClose={() => setRenewTarget(null)}
      onSaved={() => {
        const vmid = renewTarget.vmid;
        dismiss(`expiry-${vmid}`);
        shown.current.delete(vmid);
        setRenewTarget(null);
        setTimeout(refresh, 600);
      }}
    />
  ) : null;
}
