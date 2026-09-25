/**
 * Normalize SSH keys pasted through settings UI / env (newlines often become spaces or \\n).
 */

function wrapPem(label, b64) {
  const body = String(b64 || "").replace(/\s+/g, "");
  const lines = [];
  for (let i = 0; i < body.length; i += 70) lines.push(body.slice(i, i + 70));
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
}

function unescapeNewlines(raw) {
  return String(raw || "")
    .replace(/\\r\\n/g, "\n")
    .replace(/\\n/g, "\n")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
}

/**
 * Re-wrap a PEM/OpenSSH private key that lost newlines (single-line paste).
 */
export function normalizeSshPrivateKey(raw) {
  let s = unescapeNewlines(raw).trim();
  if (!s) return "";

  const begin = s.match(/-----BEGIN ([^-]+)-----/);
  const end = s.match(/-----END ([^-]+)-----/);
  if (begin && end) {
    const label = begin[1].trim();
    const startIdx = s.indexOf(begin[0]) + begin[0].length;
    const endIdx = s.indexOf(end[0]);
    const body = s.slice(startIdx, endIdx);
    return wrapPem(label, body);
  }

  // Headers missing — recover common bodies.
  const compact = s.replace(/\s+/g, "");
  if (compact.startsWith("b3BlbnNzaC1rZXktdjE")) {
    return wrapPem("OPENSSH PRIVATE KEY", compact);
  }
  if (/^MII[A-Za-z0-9+/=]+$/.test(compact) && compact.length > 100) {
    // PKCS#8 / RSA PEM body without headers
    return wrapPem(compact.startsWith("MIIE") || compact.startsWith("MIIB") ? "PRIVATE KEY" : "PRIVATE KEY", compact);
  }

  return s;
}

/**
 * Ensure OpenSSH public key form: `type base64 [comment]`.
 */
export function normalizeSshPublicKey(raw) {
  let s = unescapeNewlines(raw).trim();
  if (!s) return "";

  // Multi-line authorized_keys style — take first non-empty line after unescape
  if (s.includes("\n")) {
    s = s.split(/\n/).map((l) => l.trim()).find((l) => l && !l.startsWith("#")) || s;
  }

  if (/^(ssh-rsa|ssh-ed25519|ecdsa-sha2-[^\s]+|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-[^\s]+|ssh-dss)\s+\S/.test(s)) {
    const parts = s.trim().split(/\s+/);
    const type = parts[0];
    const blob = parts[1];
    const comment = parts.slice(2).join(" ");
    return comment ? `${type} ${blob} ${comment}` : `${type} ${blob}`;
  }

  const compact = s.replace(/\s+/g, "");
  if (compact.startsWith("AAAAB3NzaC1yc2E")) return `ssh-rsa ${compact}`;
  if (compact.startsWith("AAAAC3NzaC1lZDI1NTE5")) return `ssh-ed25519 ${compact}`;
  if (compact.startsWith("AAAAE2VjZHNhLXNoYTItbmlzdHAyNTY")) return `ecdsa-sha2-nistp256 ${compact}`;
  if (compact.startsWith("AAAAE2VjZHNhLXNoYTItbmlzdHAzODQ")) return `ecdsa-sha2-nistp384 ${compact}`;
  if (compact.startsWith("AAAAE2VjZHNhLXNoYTItbmlzdHA1MjE")) return `ecdsa-sha2-nistp521 ${compact}`;
  return s.includes(" ") ? compact : s;
}

export function isLikelyValidSshPrivateKey(raw) {
  const key = normalizeSshPrivateKey(raw);
  return /-----BEGIN [^-]*PRIVATE KEY-----/.test(key)
    && /-----END [^-]*PRIVATE KEY-----/.test(key)
    && key.length > 80;
}

export function describePrivateKeyProblem(raw) {
  const s = String(raw || "").trim();
  if (!s) return "Forge deploy private key is not set.";
  const normalized = normalizeSshPrivateKey(s);
  if (!isLikelyValidSshPrivateKey(normalized)) {
    return [
      "Forge deploy private key is malformed (OpenSSH cannot load it — often \"error in libcrypto\").",
      "Paste the full private key including -----BEGIN … PRIVATE KEY----- and -----END …----- lines.",
      "Use a multiline field; single-line pastes strip headers and break the key.",
    ].join(" ");
  }
  return null;
}
