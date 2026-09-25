import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { oidcCallback } from "../api/client.js";
import { useAuth } from "../context/AuthContext.jsx";

export default function OidcCallback() {
  const [error, setError] = useState("");
  const { signIn } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get("code");
    if (!code) {
      setError("No authorization code returned by the identity provider.");
      return;
    }
    oidcCallback(code)
      .then(({ token, user }) => {
        signIn(token, user);
        navigate("/", { replace: true });
      })
      .catch((err) => setError(err.response?.data?.error || "SSO sign-in failed."));
  }, [signIn, navigate]);

  return (
    <div style={{ display: "grid", placeItems: "center", height: "100vh", textAlign: "center" }}>
      {error ? (
        <div>
          <p style={{ color: "var(--danger)" }}>{error}</p>
          <a href="/login">Back to sign in</a>
        </div>
      ) : (
        <div>
          <span className="spinner" />
          <p className="muted" style={{ marginTop: 12 }}>Completing SSO sign-in…</p>
        </div>
      )}
    </div>
  );
}
