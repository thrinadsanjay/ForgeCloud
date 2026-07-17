import { createContext, useContext, useEffect, useState } from "react";
import { getMe } from "../api/client.js";

const TOKEN_KEY = "forge_token";
const LEGACY_TOKEN_KEY = "ssp_token";

function readToken() {
  return localStorage.getItem(TOKEN_KEY) || localStorage.getItem(LEGACY_TOKEN_KEY);
}

function writeToken(token) {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.removeItem(LEGACY_TOKEN_KEY);
}

function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(LEGACY_TOKEN_KEY);
}

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const token = readToken();
    if (!token) {
      setLoading(false);
      return;
    }
    getMe()
      .then((d) => setUser(d.user))
      .catch(() => clearToken())
      .finally(() => setLoading(false));
  }, []);

  const signIn = (token, user) => {
    writeToken(token);
    setUser(user);
  };

  const signOut = () => {
    clearToken();
    setUser(null);
  };

  const patchPreferences = (partial) => {
    setUser((u) => (u ? { ...u, preferences: { ...u.preferences, ...partial } } : u));
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        loading,
        signIn,
        signOut,
        patchPreferences,
        isAdmin: user?.role === "admin",
        isApprover: user?.role === "approver",
        canReviewDeployments: user?.role === "admin" || user?.role === "approver",
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
