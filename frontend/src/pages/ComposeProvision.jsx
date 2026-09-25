import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { listDockerHosts, deployCompose } from "../api/client.js";
import { useDialog } from "../components/DialogProvider.jsx";
import { useToast } from "../components/ToastProvider.jsx";
import EmptyState from "../components/EmptyState.jsx";
import ProviderStatusBanner from "../components/ProviderStatusBanner.jsx";
import useProviderHealth from "../hooks/useProviderHealth.js";
import { useAuth } from "../context/AuthContext.jsx";
import TextFileInput from "../components/TextFileInput.jsx";

const SAMPLE = `services:
  web:
    image: nginx:alpine
    ports:
      - "8080:80"
`;

export default function ComposeProvision({ embedded = false }) {
  const { isAdmin } = useAuth();
  const { alert } = useDialog();
  const { info, error: toastError, success } = useToast();
  const docker = useProviderHealth("docker");
  const [hosts, setHosts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [hostId, setHostId] = useState("");
  const [project, setProject] = useState("");
  const [sourceType, setSourceType] = useState("paste");
  const [composeYaml, setComposeYaml] = useState(SAMPLE);
  const [envFile, setEnvFile] = useState("");
  const [gitUrl, setGitUrl] = useState("");
  const [branch, setBranch] = useState("");
  const [composePath, setComposePath] = useState("");
  const [gitToken, setGitToken] = useState("");

  const load = async () => {
    setLoading(true);
    try {
      const h = await listDockerHosts();
      setHosts(Array.isArray(h) ? h : []);
      if (h?.length && !hostId) setHostId(h[0].id);
      setError("");
    } catch (e) {
      setError(e.response?.data?.error || e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const hostHealth = useMemo(() => {
    const map = new Map();
    for (const h of docker.hosts || []) map.set(h.id, h);
    return map;
  }, [docker.hosts]);

  const selectedHostOk = useMemo(() => {
    if (!hostId) return false;
    if (!docker.hosts) return !docker.blocked;
    const h = hostHealth.get(hostId);
    return h ? !!h.ok : !docker.blocked;
  }, [hostId, docker.hosts, docker.blocked, hostHealth]);

  const formBlocked = docker.blocked || !selectedHostOk;

  // Prefer a reachable host when health results arrive.
  useEffect(() => {
    if (!docker.hosts?.length) return;
    const current = hostHealth.get(hostId);
    if (current?.ok) return;
    const firstOk = docker.hosts.find((h) => h.ok);
    if (firstOk) setHostId(firstOk.id);
  }, [docker.hosts, hostId, hostHealth]);

  const onComposeFile = (text) => {
    setComposeYaml(text);
    setSourceType("paste");
  };

  const submit = async (e) => {
    e.preventDefault();
    if (formBlocked) {
      await alert({
        title: "Docker unavailable",
        message: docker.message || "Docker is down or unreachable",
        tone: "danger",
      });
      return;
    }
    if (!hostId) {
      await alert({ title: "Pick a host", message: "Select a Docker host to deploy to.", tone: "danger" });
      return;
    }
    setBusy(true);
    try {
      const source = sourceType === "paste"
        ? { type: "paste", composeYaml, envFile: envFile || undefined }
        : {
          type: "git",
          gitUrl,
          branch: branch || undefined,
          composePath: composePath || undefined,
          gitToken: gitToken || undefined,
        };
      const result = await deployCompose({ hostId, project, source });
      if (result?.job?.id) {
        info("Compose deploy started", `Project "${project}" is deploying — watch the deployment monitor.`);
        window.dispatchEvent(new CustomEvent("forge:open-deployment-monitor", { detail: { jobId: result.job.id } }));
      } else {
        success("Compose deploy submitted", `Project "${project}" was accepted.`);
      }
    } catch (err) {
      const msg = err.response?.data?.error || err.message;
      toastError("Deploy failed", msg);
      await alert({ title: "Deploy failed", message: msg, tone: "danger" });
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return <p className="muted">Loading Docker hosts…</p>;
  }

  if (!hosts.length) {
    return (
      <EmptyState
        tone="warn"
        icon="🐳"
        title="No Docker hosts available"
        description={isAdmin
          ? "Register a TLS-secured Docker Engine under Admin → Docker hosts. Leave Team tags empty for all users, or match group names."
          : "Ask an admin to assign a Docker host to your team (Admin → Docker hosts → Team tags), or clear Team tags to open it to everyone."}
        actionLabel={isAdmin ? "Open Docker hosts" : undefined}
        actionHref={isAdmin ? "/admin?tab=docker" : undefined}
        secondaryLabel="Back to VMs"
        secondaryHref="/provision"
      />
    );
  }

  return (
    <div className={embedded ? "" : "page"}>
      {!embedded && (
        <div className="page-head">
          <div className="eyebrow">Create</div>
          <h1>Docker</h1>
          <p>Deploy a stack to a remote Docker Engine. Manage running stacks under Resources → Docker.</p>
        </div>
      )}

      <ProviderStatusBanner
        providerLabel="Docker"
        checking={docker.checking}
        blocked={docker.blocked}
        message={docker.message}
        error={docker.error}
        hosts={docker.hosts}
        onRetry={docker.refresh}
      />

      {!docker.blocked && hostId && !selectedHostOk && (
        <div className="provider-status-banner provider-status-down" role="alert">
          <div className="provider-status-banner-body">
            <strong>Selected Docker host is down or unreachable</strong>
            {hostHealth.get(hostId)?.error && (
              <span className="provider-status-detail">{hostHealth.get(hostId).error}</span>
            )}
            <span className="provider-status-hint">
              Pick another host or retry connectivity before deploying.
            </span>
          </div>
          <button type="button" className="btn btn-ghost btn-sm" onClick={docker.refresh} disabled={docker.checking}>
            {docker.checking ? "Checking…" : "Retry"}
          </button>
        </div>
      )}

      <p className="muted" style={{ marginBottom: 14, fontSize: 13.5 }}>
        Paste a compose file or point at a Git repo. Inventory and lifecycle live under{" "}
        <Link to="/resources?tab=docker">Resources → Docker</Link>.
      </p>

      {error && <div className="login-error" style={{ marginBottom: 12 }}>{error}</div>}

      <form
        className={`card ${docker.blocked ? "is-disabled" : ""}`}
        style={{ padding: 20, maxWidth: 720 }}
        onSubmit={submit}
        aria-disabled={formBlocked}
      >
        <div className="field">
          <label>Docker host</label>
          <select
            className="control-select"
            value={hostId}
            onChange={(e) => setHostId(e.target.value)}
            required
            disabled={docker.blocked}
          >
            {hosts.map((h) => {
              const health = hostHealth.get(h.id);
              const down = health && !health.ok;
              return (
                <option key={h.id} value={h.id} disabled={!!down}>
                  {h.name} ({h.endpoint}){down ? " — unreachable" : ""}
                </option>
              );
            })}
          </select>
        </div>

        <div className="field">
          <label>Project name</label>
          <input
            className="control-input mono"
            value={project}
            onChange={(e) => setProject(e.target.value.toLowerCase())}
            required
            pattern="[a-z0-9][a-z0-9_-]*"
            placeholder="my-app"
            title="Lowercase letters, digits, hyphen, underscore"
            disabled={formBlocked}
          />
        </div>

        <div className="field">
          <label>Source</label>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              type="button"
              className={`btn btn-sm ${sourceType === "paste" ? "btn-primary" : "btn-ghost"}`}
              onClick={() => setSourceType("paste")}
              disabled={formBlocked}
            >
              Paste / upload
            </button>
            <button
              type="button"
              className={`btn btn-sm ${sourceType === "git" ? "btn-primary" : "btn-ghost"}`}
              onClick={() => setSourceType("git")}
              disabled={formBlocked}
            >
              Git URL
            </button>
          </div>
        </div>

        {sourceType === "paste" ? (
          <>
            <div className="field">
              <label>Compose YAML</label>
              <TextFileInput
                accept=".yml,.yaml,text/yaml,text/plain"
                label="Upload Compose file"
                onLoad={onComposeFile}
                disabled={formBlocked}
              />
              <textarea
                className="control-input mono"
                rows={14}
                value={composeYaml}
                onChange={(e) => setComposeYaml(e.target.value)}
                required
                disabled={formBlocked}
              />
            </div>
            <div className="field">
              <label>Optional .env</label>
              <TextFileInput
                accept=".env,text/plain"
                label="Upload .env file"
                onLoad={(text) => setEnvFile(text)}
                disabled={formBlocked}
              />
              <textarea
                className="control-input mono"
                rows={4}
                value={envFile}
                onChange={(e) => setEnvFile(e.target.value)}
                placeholder="KEY=value"
                disabled={formBlocked}
              />
            </div>
          </>
        ) : (
          <>
            <div className="field">
              <label>Git URL</label>
              <input
                className="control-input"
                value={gitUrl}
                onChange={(e) => setGitUrl(e.target.value)}
                required
                placeholder="https://github.com/org/repo.git"
                disabled={formBlocked}
              />
            </div>
            <div className="field">
              <label>Branch (optional)</label>
              <input
                className="control-input"
                value={branch}
                onChange={(e) => setBranch(e.target.value)}
                placeholder="main"
                disabled={formBlocked}
              />
            </div>
            <div className="field">
              <label>Compose path (optional)</label>
              <input
                className="control-input mono"
                value={composePath}
                onChange={(e) => setComposePath(e.target.value)}
                placeholder="deploy/docker-compose.yml"
                disabled={formBlocked}
              />
            </div>
            <div className="field">
              <label>Git token (optional, private repos)</label>
              <input
                className="control-input"
                type="password"
                value={gitToken}
                onChange={(e) => setGitToken(e.target.value)}
                autoComplete="off"
                disabled={formBlocked}
              />
            </div>
          </>
        )}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 8 }}>
          <button type="submit" className="btn btn-primary" disabled={busy || formBlocked}>
            {busy ? "Deploying…" : "Deploy stack"}
          </button>
        </div>
      </form>
    </div>
  );
}
