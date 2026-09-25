/**
 * Batch noisy toasts into one digest flushed after a quiet period.
 * Use for resource/docker status watchers so flaps don't spam the corner.
 */
const buckets = new Map();

const TONE_RANK = { info: 0, success: 1, warn: 2, error: 3 };

function worseTone(a, b) {
  return (TONE_RANK[b] || 0) >= (TONE_RANK[a] || 0) ? b : a;
}

/**
 * @param {Function} toast - from useToast().toast
 * @param {{ key: string, tone?: string, title: string, message?: string, href?: string, flushMs?: number }} opts
 */
export function enqueueToastDigest(toast, opts) {
  const key = String(opts?.key || "default");
  const flushMs = Number(opts.flushMs) > 0 ? Number(opts.flushMs) : 10_000;
  let bucket = buckets.get(key);
  if (!bucket) {
    bucket = { items: [], tone: opts.tone || "info", href: opts.href || null, timer: null };
    buckets.set(key, bucket);
  }

  bucket.items.push({
    title: opts.title || "Update",
    message: opts.message || "",
  });
  bucket.tone = worseTone(bucket.tone, opts.tone || "info");
  if (opts.href) bucket.href = opts.href;

  if (bucket.timer) clearTimeout(bucket.timer);
  bucket.timer = setTimeout(() => {
    const b = buckets.get(key);
    buckets.delete(key);
    if (!b?.items?.length) return;
    const n = b.items.length;
    const title = n === 1 ? b.items[0].title : `${n} updates`;
    const message = n === 1
      ? (b.items[0].message || b.items[0].title)
      : b.items.map((i) => i.title).slice(0, 5).join(" · ") + (n > 5 ? ` · +${n - 5} more` : "");
    toast({
      tone: b.tone,
      id: `digest-${key}`,
      title,
      message,
      ttlMs: n > 1 ? 12_000 : 8_000,
      actions: b.href
        ? [{ key: "view", label: "Open", href: b.href }]
        : [],
    });
  }, flushMs);
}
