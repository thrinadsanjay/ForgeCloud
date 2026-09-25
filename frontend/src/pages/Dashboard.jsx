import { useAuth } from "../context/AuthContext.jsx";
import { isAdminRole } from "../lib/roles.js";
import AdminDashboard from "./dash/AdminDashboard.jsx";
import UserDashboard from "./dash/UserDashboard.jsx";
import "./dash/fdash.css";

/**
 * Role-routed home: administrators get an ops/control-plane dashboard;
 * everyone else gets a task-focused self-service workspace.
 * These are separate compositions — not the same layout with toggles.
 */
export default function Dashboard() {
  const { user } = useAuth();
  if (isAdminRole(user?.role)) return <AdminDashboard />;
  return <UserDashboard />;
}
