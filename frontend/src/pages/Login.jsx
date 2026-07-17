import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { login, getOidcStatus, getOidcLoginUrl } from "../api/client.js";
import { useAuth } from "../context/AuthContext.jsx";
import Logo from "../components/Logo.jsx";

export default function Login() {
  const [method, setMethod] = useState(null); // null | "local" | "sso"
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [ssoEnabled, setSsoEnabled] = useState(false);
  const { signIn, user } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    if (user) navigate("/", { replace: true });
  }, [user, navigate]);

  useEffect(() => {
    getOidcStatus().then((d) => setSsoEnabled(d.enabled)).catch(() => {});
  }, []);

  const handleLocal = async (e) => {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const { token, user } = await login(username, password);
      signIn(token, user);
      navigate("/", { replace: true });
    } catch (err) {
      setError(err.response?.data?.error || "Sign in failed");
    } finally {
      setBusy(false);
    }
  };

  const handleSso = async () => {
    setError("");
    try {
      const { url } = await getOidcLoginUrl();
      window.location.href = url;
    } catch {
      setError("SSO is unavailable. Contact your administrator.");
    }
  };

  return (
    <div className="login-wrap">
      <div className="login-bg" aria-hidden="true">
        <div className="login-bg-orb login-bg-orb-1" />
        <div className="login-bg-orb login-bg-orb-2" />
        <div className="login-bg-orb login-bg-orb-3" />
      </div>

      <aside className="login-aside">
        <div className="brand-lg">
          <Logo size={40} />
          Forge
        </div>
        <div className="pitch">
          <div className="eyebrow" style={{ color: "#fbbf24" }}>Private cloud platform</div>
          <h2>Build infrastructure in conversation.</h2>
          <p>
            Provision VMs, containers, and stacks on your private cloud —
            automate with workflows, track deployments, and let Forge Assist guide you.
          </p>
          <ul className="login-feature-list">
            <li>Self-service provisioning &amp; lifecycle</li>
            <li>AI copilot &amp; live deployment monitor</li>
            <li>ServiceNow, CMDB &amp; n8n automation</li>
          </ul>
        </div>
        <div className="foot">Powered by Proxmox VE</div>
      </aside>

      <main className="login-main">
        <div className="login-card">
          {!method && (
            <>
              <h1>Sign in</h1>
              <p className="sub">Choose how you'd like to sign in.</p>

              {error && <div className="login-error">{error}</div>}

              <div className="method-list">
                <button
                  className="method-option"
                  onClick={() => (ssoEnabled ? handleSso() : setMethod("sso"))}
                >
                  <span className="method-icon">◎</span>
                  <span className="method-text">
                    <span className="method-title">Company account (SSO)</span>
                    <span className="method-sub">
                      {ssoEnabled ? "Sign in with OpenID Connect" : "Not configured yet"}
                    </span>
                  </span>
                </button>

                <button className="method-option" onClick={() => setMethod("local")}>
                  <span className="method-icon">F</span>
                  <span className="method-text">
                    <span className="method-title">Local account</span>
                    <span className="method-sub">Sign in with username and password</span>
                  </span>
                </button>
              </div>
            </>
          )}

          {method === "local" && (
            <>
              <button className="btn-back" onClick={() => { setMethod(null); setError(""); }}>&larr; Back</button>
              <h1>Local sign in</h1>
              <p className="sub">Enter your Forge username and password.</p>

              {error && <div className="login-error">{error}</div>}

              <form onSubmit={handleLocal}>
                <div className="field">
                  <label>Username</label>
                  <input value={username} onChange={(e) => setUsername(e.target.value)} autoFocus autoComplete="username" />
                </div>
                <div className="field">
                  <label>Password</label>
                  <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
                </div>
                <button className="btn btn-primary" style={{ width: "100%" }} disabled={busy}>
                  {busy ? "Signing in…" : "Sign in"}
                </button>
              </form>
            </>
          )}

          {method === "sso" && (
            <>
              <button className="btn-back" onClick={() => { setMethod(null); setError(""); }}>&larr; Back</button>
              <h1>Company account</h1>
              <p className="sub">Single sign-on is not available yet.</p>
              <div className="login-error">
                OIDC SSO hasn't been configured. Ask an administrator to set it up
                under Settings → OIDC SSO, then use a local account in the meantime.
              </div>
            </>
          )}
        </div>
      </main>
    </div>
  );
}
