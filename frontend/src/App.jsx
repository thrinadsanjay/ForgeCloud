import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { AuthProvider, useAuth } from "./context/AuthContext.jsx";
import { ProtectedRoute } from "./components/ProtectedRoute.jsx";
import ChatWidget from "./components/ChatWidget.jsx";
import LogPanel from "./components/LogPanel.jsx";
import JobOutcomeNotifier from "./components/JobOutcomeNotifier.jsx";
import ExpiryNotifier from "./components/ExpiryNotifier.jsx";
import ResourceStatusWatcher from "./components/ResourceStatusWatcher.jsx";
import DockerStatusWatcher from "./components/DockerStatusWatcher.jsx";
import { DialogProvider } from "./components/DialogProvider.jsx";
import { ToastProvider } from "./components/ToastProvider.jsx";

import Login from "./pages/Login.jsx";
import OidcCallback from "./pages/OidcCallback.jsx";
import Dashboard from "./pages/Dashboard.jsx";
import ProvisionHub from "./pages/ProvisionHub.jsx";
import Resources from "./pages/Resources.jsx";
import Deployments from "./pages/Deployments.jsx";
import Admin from "./pages/Admin.jsx";
import Audit from "./pages/Audit.jsx";
import Support from "./pages/Support.jsx";
import Usage from "./pages/Usage.jsx";
import Notifications from "./pages/Notifications.jsx";

function RequestsRedirect() {
  return <Navigate to="/deployments?tab=all" replace />;
}

function GlobalOverlays() {
  const { user } = useAuth();
  if (!user) return null;
  return (
    <>
      <ChatWidget />
      <LogPanel />
      <JobOutcomeNotifier />
      <ExpiryNotifier />
      <ResourceStatusWatcher />
      <DockerStatusWatcher />
    </>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <DialogProvider>
        <ToastProvider>
          <BrowserRouter>
            <Routes>
              <Route path="/login" element={<Login />} />
              <Route path="/auth/oidc/callback" element={<OidcCallback />} />
              <Route path="/auth/entra/callback" element={<OidcCallback />} />

              <Route path="/" element={<ProtectedRoute><Dashboard /></ProtectedRoute>} />
              <Route path="/provision" element={<ProtectedRoute><ProvisionHub /></ProtectedRoute>} />
              <Route path="/resources" element={<ProtectedRoute><Resources /></ProtectedRoute>} />
              <Route path="/containers" element={<Navigate to="/provision?tab=containers" replace />} />
              <Route path="/deployments" element={<ProtectedRoute><Deployments /></ProtectedRoute>} />
              <Route path="/notifications" element={<ProtectedRoute><Notifications /></ProtectedRoute>} />
              <Route path="/usage" element={<ProtectedRoute><Usage /></ProtectedRoute>} />
              <Route path="/requests" element={<ProtectedRoute><RequestsRedirect /></ProtectedRoute>} />
              <Route path="/admin" element={<ProtectedRoute adminOnly><Admin /></ProtectedRoute>} />
              <Route path="/audit" element={<ProtectedRoute adminOnly><Audit /></ProtectedRoute>} />
              <Route path="/settings" element={<ProtectedRoute adminOnly><Navigate to="/admin?tab=proxmox" replace /></ProtectedRoute>} />
              <Route path="/support" element={<ProtectedRoute><Support /></ProtectedRoute>} />
              <Route path="/users" element={<Navigate to="/admin?tab=users" replace />} />
              <Route path="/mappings" element={<Navigate to="/admin?tab=mappings" replace />} />
            </Routes>
            <GlobalOverlays />
          </BrowserRouter>
        </ToastProvider>
      </DialogProvider>
    </AuthProvider>
  );
}
