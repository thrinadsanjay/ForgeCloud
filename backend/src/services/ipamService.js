import https from "https";
import axios from "axios";

// --- IPAM (IP Address Management) integration ---
// Thin client for whichever IPAM the admin links in Settings (phpIPAM, NetBox,
// Infoblox, …). Only a connectivity test is implemented today; reserve/release
// calls can be layered on top of the same configured base URL + token.

function config() {
  return {
    url: process.env.IPAM_URL || "",
    username: process.env.IPAM_USERNAME || "",
    token: process.env.IPAM_API_TOKEN || "",
    verifyTls: process.env.IPAM_VERIFY_TLS !== "false",
  };
}

export function isConfigured() {
  return !!config().url;
}

// Verify connectivity to the configured IPAM API. Most IPAM products answer a
// GET on their API root with 200/401/403 when reachable — anything other than a
// network error means the endpoint is live. Returns { url, platform }.
export async function testConnection() {
  const { url, token, verifyTls } = config();
  if (!url) throw new Error("IPAM API base URL is not configured");

  const headers = {};
  if (token) {
    // Send the token both ways so it works across common IPAM APIs.
    headers.token = token;                     // phpIPAM
    headers.Authorization = `Token ${token}`;  // NetBox / generic bearer-style
  }

  try {
    const res = await axios.get(url.replace(/\/+$/, "") + "/", {
      headers,
      timeout: 10000,
      // Treat 2xx–4xx as "reachable"; only network/5xx errors are failures.
      validateStatus: (s) => s >= 200 && s < 500,
      httpsAgent: url.startsWith("https") ? new https.Agent({ rejectUnauthorized: verifyTls }) : undefined,
    });
    if (res.status === 401 || res.status === 403) {
      throw new Error("Reached the IPAM API, but authentication was rejected — check the token");
    }
    return { url, platform: "IPAM" };
  } catch (err) {
    if (err.message?.startsWith("Reached the IPAM API")) throw err;
    throw new Error(err.response?.data?.message || err.message);
  }
}
