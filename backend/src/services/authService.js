import jwt from "jsonwebtoken";
import axios from "axios";

const JWT_SECRET = process.env.JWT_SECRET || "dev-insecure-secret-change-me";
const JWT_EXPIRY = process.env.JWT_EXPIRY || "8h";

export function issueToken(user) {
  return jwt.sign(
    {
      sub: user.id,
      username: user.username,
      displayName: user.displayName,
      role: user.role,
      source: user.source,
    },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRY }
  );
}

export function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET);
}

// --- Generic OpenID Connect (OIDC) ---
// Supports any provider via issuer discovery. Legacy ENTRA_* env vars still work.

function oidcConfig() {
  const issuer = (process.env.OIDC_ISSUER
    || (process.env.ENTRA_TENANT_ID
      ? `https://login.microsoftonline.com/${process.env.ENTRA_TENANT_ID}/v2.0`
      : "")).replace(/\/+$/, "");
  return {
    issuer,
    clientId: process.env.OIDC_CLIENT_ID || process.env.ENTRA_CLIENT_ID || "",
    clientSecret: process.env.OIDC_CLIENT_SECRET || process.env.ENTRA_CLIENT_SECRET || "",
    redirectUri: process.env.OIDC_REDIRECT_URI || process.env.ENTRA_REDIRECT_URI || "",
    scopes: (process.env.OIDC_SCOPES || "openid profile email").trim() || "openid profile email",
  };
}

let discoveryCache = { issuer: "", doc: null, at: 0 };

async function discoverOidc(issuer) {
  if (discoveryCache.issuer === issuer && discoveryCache.doc && Date.now() - discoveryCache.at < 3600_000) {
    return discoveryCache.doc;
  }
  const url = `${issuer}/.well-known/openid-configuration`;
  const res = await axios.get(url, { timeout: 15000 });
  discoveryCache = { issuer, doc: res.data, at: Date.now() };
  return res.data;
}

export function isOidcConfigured() {
  const c = oidcConfig();
  return Boolean(c.issuer && c.clientId && c.clientSecret && c.redirectUri);
}

/** Infer IdP brand from issuer URL for login UI (single configured OIDC app). */
export function detectOidcProvider(issuer = "") {
  const u = String(issuer || "").toLowerCase();
  if (/login\.microsoftonline\.com|sts\.windows\.net|microsoftonline/.test(u)) {
    return { id: "azure", name: "Azure AD" };
  }
  if (/accounts\.google\.com|googleapis\.com\/o\/oauth2/.test(u)) {
    return { id: "google", name: "Google Workspace" };
  }
  if (/gitlab/.test(u)) return { id: "gitlab", name: "GitLab" };
  if (/okta\.com/.test(u)) return { id: "okta", name: "Okta" };
  if (/auth0\.com/.test(u)) return { id: "auth0", name: "Auth0" };
  if (/keycloak|\/realms\//.test(u)) return { id: "keycloak", name: "Keycloak" };
  if (/pingone\.com|pingidentity|pingfederate/.test(u)) {
    return { id: "ping", name: "Ping Identity" };
  }
  if (/jumpcloud/.test(u)) return { id: "jumpcloud", name: "JumpCloud" };
  if (/onelogin\.com/.test(u)) return { id: "onelogin", name: "OneLogin" };
  if (/cognito-idp|amazoncognito/.test(u)) return { id: "cognito", name: "Amazon Cognito" };
  return { id: "oidc", name: "OpenID Connect" };
}

/** Public SSO status for the login page — only configured providers. */
export function getOidcPublicStatus() {
  if (!isOidcConfigured()) {
    return { enabled: false, providers: [] };
  }
  const { issuer } = oidcConfig();
  const detected = detectOidcProvider(issuer);
  return {
    enabled: true,
    providers: [{ id: detected.id, name: detected.name }],
  };
}

/** @deprecated use isOidcConfigured */
export const isEntraConfigured = isOidcConfigured;

export async function getOidcAuthUrl(state) {
  const c = oidcConfig();
  if (!isOidcConfigured()) throw new Error("OIDC SSO is not configured");
  const meta = await discoverOidc(c.issuer);
  const authorize = meta.authorization_endpoint;
  if (!authorize) throw new Error("OIDC discovery did not return authorization_endpoint");
  const params = new URLSearchParams({
    client_id: c.clientId,
    response_type: "code",
    redirect_uri: c.redirectUri,
    response_mode: "query",
    scope: c.scopes,
    state: state || "",
  });
  return `${authorize}?${params.toString()}`;
}

/** @deprecated use getOidcAuthUrl */
export async function getEntraAuthUrl(state) {
  return getOidcAuthUrl(state);
}

export async function exchangeOidcCode(code) {
  const c = oidcConfig();
  if (!isOidcConfigured()) throw new Error("OIDC SSO is not configured");
  const meta = await discoverOidc(c.issuer);
  const tokenUrl = meta.token_endpoint;
  if (!tokenUrl) throw new Error("OIDC discovery did not return token_endpoint");

  const body = new URLSearchParams({
    client_id: c.clientId,
    client_secret: c.clientSecret,
    grant_type: "authorization_code",
    code,
    redirect_uri: c.redirectUri,
    scope: c.scopes,
  });

  const res = await axios.post(tokenUrl, body.toString(), {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    timeout: 20000,
  });

  const idToken = res.data.id_token;
  // Decode without JWKS verification (same shortcut as before). Code exchange
  // was over TLS to the configured issuer token endpoint.
  const claims = jwt.decode(idToken);
  if (!claims) throw new Error("OIDC provider did not return a valid id_token");
  return {
    username: claims.preferred_username || claims.email || claims.upn || claims.sub,
    displayName: claims.name || claims.preferred_username || claims.email || claims.sub,
    email: claims.email || claims.preferred_username || claims.upn || "",
  };
}

/** @deprecated use exchangeOidcCode */
export async function exchangeEntraCode(code) {
  return exchangeOidcCode(code);
}
