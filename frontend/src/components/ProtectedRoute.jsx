import { Navigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext.jsx";
import TopNav from "./TopNav.jsx";

export function ProtectedRoute({ children, adminOnly = false }) {
  const { user, loading, isAdmin } = useAuth();

  if (loading) {
    return (
      <div style={{ display: "grid", placeItems: "center", height: "100vh" }}>
        <span className="spinner" />
      </div>
    );
  }

  if (!user) return <Navigate to="/login" replace />;
  if (adminOnly && !isAdmin) return <Navigate to="/" replace />;

  return (
    <>
      <TopNav />
      {children}
    </>
  );
}
