import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { login, getOidcStatus, getOidcLoginUrl } from "../api/client.js";
import { useAuth } from "../context/AuthContext.jsx";
import Logo from "../components/Logo.jsx";
import Toggle from "../components/Toggle.jsx";

const REMEMBER_KEY = "forge.login.rememberUser";

function IconUser({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M20 21a8 8 0 0 0-16 0" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <circle cx="12" cy="8" r="4" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  );
}

function IconLock({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="5" y="11" width="14" height="10" rx="2" stroke="currentColor" strokeWidth="1.8" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function IconEye({ open }) {
  if (open) {
    return (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M3 3l18 18" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        <path d="M10.6 10.6a2 2 0 0 0 2.8 2.8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        <path d="M9.9 5.2A10.5 10.5 0 0 1 12 5c5 0 9.3 3.1 11 7-.5 1.2-1.3 2.4-2.3 3.4M6.1 6.1C4.2 7.4 2.7 9.2 2 12c1.7 3.9 6 7 11 7 1.4 0 2.7-.2 3.9-.7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
    );
  }
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" stroke="currentColor" strokeWidth="1.8" />
      <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  );
}

function FeatureIcon({ kind }) {
  const common = { width: 16, height: 16, viewBox: "0 0 24 24", fill: "none", "aria-hidden": true };
  if (kind === "provision") {
    return (
      <svg {...common}>
        <path d="M12 3v18M3 12h18" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        <rect x="7" y="7" width="10" height="10" rx="2" stroke="currentColor" strokeWidth="1.8" />
      </svg>
    );
  }
  if (kind === "ai") {
    return (
      <svg {...common}>
        <path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4v8z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
      </svg>
    );
  }
  if (kind === "integrate") {
    return (
      <svg {...common}>
        <circle cx="8" cy="8" r="3" stroke="currentColor" strokeWidth="1.8" />
        <circle cx="16" cy="16" r="3" stroke="currentColor" strokeWidth="1.8" />
        <path d="M10.5 10.5l3 3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <path d="M12 3l8 4v5c0 5-3.5 8.5-8 10-4.5-1.5-8-5-8-10V7l8-4z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
    </svg>
  );
}

/** Brand mark for a configured OIDC provider. */
function ProviderMark({ id }) {
  if (id === "azure") {
    return (
      <svg width="28" height="28" viewBox="0 0 23 23" aria-hidden="true">
        <path fill="#f25022" d="M1 1h10v10H1z" />
        <path fill="#7fba00" d="M12 1h10v10H12z" />
        <path fill="#00a4ef" d="M1 12h10v10H1z" />
        <path fill="#ffb900" d="M12 12h10v10H12z" />
      </svg>
    );
  }
  if (id === "google") {
    return (
      <svg width="28" height="28" viewBox="0 0 24 24" aria-hidden="true">
        <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" />
        <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
        <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
        <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
      </svg>
    );
  }
  if (id === "gitlab") {
    return (
      <svg width="28" height="28" viewBox="0 0 24 24" aria-hidden="true">
        <path fill="#E24329" d="M12 21.2L16.35 8.1H7.65L12 21.2z" />
        <path fill="#FC6D26" d="M12 21.2l4.35-13.1h4.1L12 21.2z" />
        <path fill="#FCA326" d="M20.45 8.1l1.75 5.35c.16.5-.01 1.05-.43 1.35L12 21.2l8.45-13.1z" />
        <path fill="#E24329" d="M3.55 8.1l-1.75 5.35c-.16.5.01 1.05.43 1.35L12 21.2 3.55 8.1z" />
        <path fill="#FC6D26" d="M3.55 8.1h4.1L5.7 3.45c-.2-.62-1.08-.62-1.28 0L3.55 8.1z" />
        <path fill="#FCA326" d="M20.45 8.1h-4.1l1.95-4.65c.2-.62 1.08-.62 1.28 0L20.45 8.1z" />
      </svg>
    );
  }
  if (id === "okta") {
    return (
      <svg width="28" height="28" viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="9" fill="#007DC1" />
        <circle cx="12" cy="12" r="3.5" fill="#fff" />
      </svg>
    );
  }
  if (id === "auth0") {
    return (
      <svg width="28" height="28" viewBox="0 0 24 24" aria-hidden="true">
        <path fill="#EB5424" d="M12 2l2.6 8H22l-6.6 4.8 2.5 7.7L12 17.7 6.1 22.5l2.5-7.7L2 10h7.4L12 2z" />
      </svg>
    );
  }
  if (id === "keycloak") {
    return (
      <svg width="28" height="28" viewBox="0 0 24 24" aria-hidden="true">
        <rect width="24" height="24" rx="6" fill="#4D4D4D" />
        <path fill="#fff" d="M7 7h4.2c2.4 0 3.8 1.2 3.8 3.1 0 1.3-.7 2.3-1.9 2.8L16 17h-2.4l-2.5-3.7H9.2V17H7V7zm2.2 1.8v2.8h1.7c1.1 0 1.8-.5 1.8-1.4s-.7-1.4-1.8-1.4H9.2z" />
      </svg>
    );
  }
  if (id === "cognito") {
    return (
      <svg width="28" height="28" viewBox="0 0 24 24" aria-hidden="true">
        <path fill="#FF9900" d="M6.5 18.5c-2.5 0-4.5-2-4.5-4.5s2-4.5 4.5-4.5c.4-2.6 2.6-4.5 5.3-4.5 2.4 0 4.4 1.5 5.1 3.7 2.2.2 3.9 2.1 3.9 4.3 0 2.4-1.9 4.5-4.4 4.5H6.5z" />
      </svg>
    );
  }
  // Generic OIDC / Ping / JumpCloud / OneLogin
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="#E67E22" strokeWidth="1.8" />
      <path d="M8 12a4 4 0 0 0 8 0" stroke="#E67E22" strokeWidth="1.8" strokeLinecap="round" />
      <circle cx="12" cy="10" r="1.5" fill="#E67E22" />
    </svg>
  );
}

const FEATURES = [
  { kind: "provision", text: "Self-service provisioning & lifecycle" },
  { kind: "ai", text: "AI-powered Forge Assistant" },
  { kind: "integrate", text: "ServiceNow, Ansible & CMDB integration" },
  { kind: "rbac", text: "Enterprise RBAC & Approval workflows" },
];

export default function Login() {
  const [username, setUsername] = useState(() => {
    try { return localStorage.getItem(REMEMBER_KEY) || ""; } catch { return ""; }
  });
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [remember, setRemember] = useState(() => {
    try { return Boolean(localStorage.getItem(REMEMBER_KEY)); } catch { return false; }
  });
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [busy, setBusy] = useState(false);
  const [providers, setProviders] = useState([]);
  const { signIn, user } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    if (user) navigate("/", { replace: true });
  }, [user, navigate]);

  useEffect(() => {
    getOidcStatus()
      .then((d) => {
        const list = Array.isArray(d?.providers) ? d.providers : (d?.enabled ? [{ id: "oidc", name: "OpenID Connect" }] : []);
        setProviders(list);
      })
      .catch(() => setProviders([]));
  }, []);

  const handleLocal = async (e) => {
    e.preventDefault();
    setError("");
    setInfo("");
    setBusy(true);
    try {
      const { token, user: nextUser } = await login(username, password);
      try {
        if (remember) localStorage.setItem(REMEMBER_KEY, username.trim());
        else localStorage.removeItem(REMEMBER_KEY);
      } catch { /* ignore */ }
      signIn(token, nextUser);
      navigate("/", { replace: true });
    } catch (err) {
      setError(err.response?.data?.error || "Sign in failed");
    } finally {
      setBusy(false);
    }
  };

  const handleSso = async () => {
    setError("");
    setInfo("");
    try {
      const { url } = await getOidcLoginUrl();
      window.location.href = url;
    } catch {
      setError("SSO is unavailable. Contact your administrator.");
    }
  };

  const onForgot = (e) => {
    e.preventDefault();
    setInfo("Password resets are managed by your administrator. Contact them if you need access restored.");
    setError("");
  };

  return (
    <div className="login-wrap login-v2">
      <aside className="login-aside" aria-label="Forge product overview">
        <div className="login-aside-top">
          <div className="brand-lg">
            <Logo size={36} />
            <span>Forge</span>
          </div>

          <div className="pitch">
            <div className="login-caption">Private cloud platform</div>
            <h1>Build infrastructure in conversation.</h1>
            <p>
              Provision virtual machines, containers, Kubernetes workloads and infrastructure
              through a unified self-service platform powered by automation.
            </p>
            <ul className="login-feature-list">
              {FEATURES.map((f) => (
                <li key={f.kind}>
                  <span className="login-feature-icon"><FeatureIcon kind={f.kind} /></span>
                  <span>{f.text}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>

        <div className="login-aside-mesh" aria-hidden="true" />
        <div className="foot">Powered by Proxmox VE</div>
      </aside>

      <main className="login-main">
        <div className="login-main-inner">
          <div className="login-welcome">
            <div className="login-welcome-mark" aria-hidden="true">
              <Logo size={40} />
            </div>
            <h2>Welcome back</h2>
            <p>Sign in to access your Forge portal</p>
          </div>

          <div className="login-card">
            <div className="login-card-head">
              <span className="login-card-head-icon"><IconUser size={18} /></span>
              <span>Forge Account</span>
            </div>

            {error && <div className="login-error" role="alert">{error}</div>}
            {info && <div className="login-info" role="status">{info}</div>}

            <form className="login-form" onSubmit={handleLocal}>
              <div className="field">
                <label htmlFor="login-username">Username</label>
                <div className="login-input-wrap">
                  <span className="login-input-icon"><IconUser /></span>
                  <input
                    id="login-username"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    autoFocus
                    autoComplete="username"
                    placeholder="Enter your username"
                    required
                  />
                </div>
              </div>

              <div className="field">
                <label htmlFor="login-password">Password</label>
                <div className="login-input-wrap">
                  <span className="login-input-icon"><IconLock /></span>
                  <input
                    id="login-password"
                    type={showPassword ? "text" : "password"}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoComplete="current-password"
                    placeholder="Enter your password"
                    required
                  />
                  <button
                    type="button"
                    className={`login-eye ${showPassword ? "on" : ""}`}
                    onClick={() => setShowPassword((v) => !v)}
                    aria-label={showPassword ? "Hide password" : "Show password"}
                    title={showPassword ? "Hide password" : "Show password"}
                  >
                    <IconEye open={showPassword} />
                  </button>
                </div>
              </div>

              <div className="login-form-meta">
                <label className="login-remember">
                  <Toggle variant="glow" size="sm" checked={remember} onChange={setRemember} />
                  <span>Remember me</span>
                </label>
                <a className="login-forgot" href="#forgot" onClick={onForgot}>Forgot password?</a>
              </div>

              <button className="btn btn-primary login-submit" type="submit" disabled={busy}>
                {busy ? "Signing in…" : "Sign in"}
              </button>
            </form>
          </div>

          {providers.length > 0 && (
            <section className="login-sso" aria-label="Single Sign-On">
              <div className="login-divider" role="separator"><span>OR</span></div>
              <h3>Single Sign-On</h3>
              <p className="login-sso-sub">Sign in using your organization&apos;s identity provider.</p>
              <div className="login-sso-grid">
                {providers.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    className="login-sso-card"
                    title={p.name}
                    onClick={handleSso}
                  >
                    <ProviderMark id={p.id} />
                    <span className="login-sso-name">{p.name}</span>
                  </button>
                ))}
              </div>
              <p className="login-sso-note">
                <IconLock size={14} />
                <span>Secure authentication via OpenID Connect (OIDC)</span>
              </p>
            </section>
          )}
        </div>
      </main>
    </div>
  );
}
