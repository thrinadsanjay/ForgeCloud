import { useEffect, useRef, useState } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { useAuth } from "../context/AuthContext.jsx";
import { getMyPreferences, updateMyPreferences } from "../api/client.js";
import ApiTokensPanel from "./ApiTokensPanel.jsx";
import NotificationBell from "./NotificationBell.jsx";
import Logo from "./Logo.jsx";

const THEMES = [
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
];

function normalizeTheme(theme) {
  if (theme === "dark") return "dark";
  return "light";
}

function initials(name = "") {
  return name.split(/[\s.@]+/).filter(Boolean).slice(0, 2).map((s) => s[0]?.toUpperCase()).join("");
}

export default function TopNav() {
  const { user, signOut, patchPreferences, isAdmin } = useAuth();
  const location = useLocation();
  const [theme, setTheme] = useState(() => normalizeTheme(user?.preferences?.theme || "light"));
  const [showBackground, setShowBackground] = useState(() => user?.preferences?.showBackground ?? true);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuView, setMenuView] = useState("root");
  const menuRef = useRef(null);

  useEffect(() => {
    if (user?.preferences) {
      if (user.preferences.theme) setTheme(normalizeTheme(user.preferences.theme));
      if (typeof user.preferences.showBackground === "boolean") {
        setShowBackground(user.preferences.showBackground);
      }
    }

    getMyPreferences()
      .then((d) => {
        const prefs = d.preferences || {};
        if (prefs.theme) setTheme(normalizeTheme(prefs.theme));
        if (typeof prefs.showBackground === "boolean") setShowBackground(prefs.showBackground);
        patchPreferences?.(prefs);
      })
      .catch(() => {});
  }, [user?.id]);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  useEffect(() => {
    document.body.setAttribute("data-ornaments", showBackground ? "on" : "off");
  }, [showBackground]);

  useEffect(() => {
    if (!menuOpen) setMenuView("root");
  }, [menuOpen]);

  useEffect(() => {
    const onDocClick = (e) => {
      if (!menuRef.current?.contains(e.target)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  const savePreferences = async (partial) => {
    patchPreferences?.(partial);
    try {
      await updateMyPreferences(partial);
    } catch {
      // Keep optimistic UI; backend will sync on next successful preferences fetch.
    }
  };

  const handleThemeChange = async (nextTheme) => {
    setTheme(nextTheme);
    await savePreferences({ theme: nextTheme });
  };

  const handleBackgroundToggle = async (nextValue) => {
    setShowBackground(nextValue);
    await savePreferences({ showBackground: nextValue });
  };

  const links = [
    { to: "/", label: "Dashboard", end: true },
    { to: "/provision", label: "Provisioning" },
    { to: "/resources", label: "Resources" },
    {
      to: "/deployments?tab=all",
      label: "Deployments",
      match: "/deployments",
    },
  ];
  if (isAdmin) {
    links.push({ to: "/admin", label: "Admin" });
    links.push({ to: "/audit", label: "Audit" });
  }

  return (
    <nav className="topnav">
      <div className="topnav-brand">
        <Logo size={28} className="topnav-logo" />
        <span className="topnav-wordmark">Forge</span>
      </div>

      <div className="topnav-links">
        {links.map((l) => (
          <NavLink
            key={l.match || l.to}
            to={l.to}
            end={l.end}
            className={({ isActive }) => {
              const active = l.match ? location.pathname.startsWith(l.match) : isActive;
              return `topnav-link ${active ? "active" : ""}`;
            }}
          >
            {l.label}
          </NavLink>
        ))}
      </div>

      <div className="topnav-user">
        <NotificationBell />
        <div className="user-menu" ref={menuRef}>
          <button
            className="user-chip-btn"
            onClick={() => setMenuOpen((v) => !v)}
            aria-label="Open account menu"
            aria-expanded={menuOpen}
          >
            <span className="user-chip">
              <span className="user-avatar">{initials(user?.displayName || user?.username)}</span>
              <span className="user-meta">
                <div className="name">{user?.displayName || user?.username}</div>
                <div className="role">{user?.role}</div>
              </span>
              <span className="user-caret">▾</span>
            </span>
          </button>

          {menuOpen && (
            <div className={`user-menu-popover ${menuView === "tokens" ? "user-menu-popover-wide" : ""}`}>
              <div className="user-menu-head">
                <div className="name">{user?.displayName || user?.username}</div>
                <div className="role">{user?.role}</div>
              </div>

              {menuView === "root" && (
                <>
                  <button className="menu-row" onClick={() => setMenuView("preferences")}>
                    <span className="menu-row-label">Preferences</span>
                    <span className="menu-row-arrow">›</span>
                  </button>
                  <button className="menu-row" onClick={() => setMenuView("tokens")}>
                    <span className="menu-row-label">API tokens</span>
                    <span className="menu-row-arrow">›</span>
                  </button>
                  <button className="btn-menu-signout" onClick={signOut}>Sign out</button>
                </>
              )}

              {menuView === "tokens" && (
                <>
                  <button className="popover-back" onClick={() => setMenuView("root")}>← Back</button>
                  <ApiTokensPanel />
                </>
              )}

              {menuView === "preferences" && (
                <>
                  <button className="popover-back" onClick={() => setMenuView("root")}>← Back</button>
                  <div className="user-menu-section-title">Preferences</div>
                  <label className="topnav-theme-wrap" title="Theme">
                    <span>Theme</span>
                    <select className="topnav-theme" value={theme} onChange={(e) => handleThemeChange(e.target.value)}>
                      {THEMES.map((t) => (
                        <option key={t.id} value={t.id}>{t.label}</option>
                      ))}
                    </select>
                  </label>

                  <label className="pref-toggle-row">
                    <span>Decorative background</span>
                    <input
                      type="checkbox"
                      checked={showBackground}
                      onChange={(e) => handleBackgroundToggle(e.target.checked)}
                    />
                  </label>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </nav>
  );
}
