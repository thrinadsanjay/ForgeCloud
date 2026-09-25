import { useEffect, useState } from "react";
import {
  listDockerHostsAdmin,
  createDockerHostAdmin,
  updateDockerHostAdmin,
  deleteDockerHostAdmin,
  testDockerHostFormAdmin,
  testDockerHostAdmin,
  getGroups,
} from "../api/client.js";
import { useDialog } from "../components/DialogProvider.jsx";
import { useToast } from "../components/ToastProvider.jsx";
import EmptyState from "../components/EmptyState.jsx";
import AdminPageHeader from "../components/AdminPageHeader.jsx";
import Toggle from "../components/Toggle.jsx";
import TextFileInput from "../components/TextFileInput.jsx";

const emptyForm = () => ({
  name: "",
  endpoint: "tcp://",
  tlsCa: "",
  tlsCert: "",
  tlsKey: "",
  teamTags: "",
  appTags: "",
  skipTlsVerify: false,
  enabled: true,
});

function tagsToStr(arr) {
  return Array.isArray(arr) ? arr.join(", ") : "";
}

export default function DockerHostsAdmin({ embedded = false }) {
  const { confirm, alert } = useDialog();
  const { success, error: toastError, info } = useToast();
  const [hosts, setHosts] = useState([]);
  const [groups, setGroups] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState(null); // null | 'new' | host
  const [form, setForm] = useState(emptyForm());
  const [busy, setBusy] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [formTest, setFormTest] = useState(null);

  const load = async () => {
    setLoading(true);
    try {
      const [h, g] = await Promise.all([
        listDockerHostsAdmin(),
        getGroups().catch(() => []),
      ]);
      setHosts(Array.isArray(h) ? h : []);
      setGroups(Array.isArray(g) ? g : []);
      setError("");
    } catch (e) {
      setError(e.response?.data?.error || e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const openNew = () => {
    setForm(emptyForm());
    setEditing("new");
    setTestResult(null);
    setFormTest(null);
  };

  const openEdit = (h) => {
    setForm({
      name: h.name,
      endpoint: h.endpoint,
      tlsCa: "",
      tlsCert: "",
      tlsKey: "",
      teamTags: tagsToStr(h.teamTags),
      appTags: tagsToStr(h.appTags),
      enabled: h.enabled !== false,
      skipTlsVerify: !!h.skipTlsVerify,
    });
    setEditing(h);
    setTestResult(null);
    setFormTest(null);
  };

  const formPayload = () => {
    const payload = {
      name: form.name.trim(),
      endpoint: form.endpoint.trim(),
      teamTags: form.teamTags,
      appTags: form.appTags,
      enabled: form.enabled,
      skipTlsVerify: form.skipTlsVerify,
    };
    if (form.tlsCa.trim()) payload.tlsCa = form.tlsCa;
    if (form.tlsCert.trim()) payload.tlsCert = form.tlsCert;
    if (form.tlsKey.trim()) payload.tlsKey = form.tlsKey;
    if (editing !== "new") payload.id = editing.id;
    return payload;
  };

  const validatePayload = (payload) => {
    if (!payload.name) throw new Error("Name is required");
    if (!payload.endpoint) throw new Error("Endpoint is required");
    if (
      editing === "new"
      && !form.skipTlsVerify
      && (!payload.tlsCa || !payload.tlsCert || !payload.tlsKey)
    ) {
      throw new Error("TLS CA, certificate, and key are required (or enable Skip TLS verification)");
    }
  };

  const persist = async (payload) => {
    const { id, ...savePayload } = payload;
    if (editing === "new") {
      return createDockerHostAdmin(savePayload);
    }
    return updateDockerHostAdmin(id, savePayload);
  };

  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    setFormTest(null);
    const wasNew = editing === "new";
    try {
      const payload = formPayload();
      validatePayload(payload);
      const saved = await persist(payload);
      setEditing(null);
      await load();
      success(
        wasNew ? "Docker host added" : "Docker host updated",
        `"${saved.name || payload.name}" was saved.`,
      );
    } catch (err) {
      const msg = err.response?.data?.error || err.message;
      toastError("Couldn't save host", msg);
      await alert({ title: "Couldn't save host", message: msg, tone: "danger" });
    } finally {
      setBusy(false);
    }
  };

  const testAndSave = async () => {
    setBusy(true);
    setFormTest({ checking: true });
    try {
      const payload = formPayload();
      validatePayload(payload);
      const result = await testDockerHostFormAdmin(payload);
      const saved = await persist(payload);
      setEditing(null);
      await load();
      setTestResult({
        id: saved.id,
        ok: true,
        detail: result.version || result.apiVersion || "ok",
      });
      success(
        "Host tested & saved",
        `"${saved.name || payload.name}" · ${result.version || result.apiVersion || "ok"}`,
      );
    } catch (err) {
      const msg = err.response?.data?.error || err.message;
      setFormTest({ ok: false, detail: msg });
      toastError("Test & save failed", msg);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (h) => {
    if (!(await confirm({ title: "Delete Docker host", message: `Remove "${h.name}"? Deployed stacks are not deleted.`, confirmLabel: "Delete", tone: "danger" }))) return;
    try {
      await deleteDockerHostAdmin(h.id);
      await load();
      info("Docker host removed", `"${h.name}" was deleted from Forge.`);
    } catch (err) {
      const msg = err.response?.data?.error || err.message;
      toastError("Delete failed", msg);
      await alert({ title: "Delete failed", message: msg, tone: "danger" });
    }
  };

  const test = async (h) => {
    setTestResult({ id: h.id, checking: true });
    try {
      const r = await testDockerHostAdmin(h.id);
      setTestResult({ id: h.id, ok: true, detail: r.version || r.apiVersion || "ok" });
      success("Connection OK", `"${h.name}" · ${r.version || r.apiVersion || "ok"}`);
    } catch (err) {
      const msg = err.response?.data?.error || err.message;
      setTestResult({ id: h.id, ok: false, detail: msg });
      toastError("Connection failed", msg);
    }
  };

  const upd = (k) => (e) => {
    setForm((f) => ({ ...f, [k]: e.target.value }));
  };
  const setBool = (k) => (v) => setForm((f) => ({ ...f, [k]: v }));

  return (
    <div className={embedded ? "adm-board" : "page adm-board"}>
      {!embedded && (
        <AdminPageHeader
          eyebrow="Infrastructure"
          title="Docker hosts"
          description="Register remote Docker Engines (TLS) for Compose deploy. Scope by team tags so users only see hosts for their groups."
        />
      )}
      {embedded && (
        <div className="page-head" style={{ marginBottom: 16 }}>
          <h2 style={{ margin: 0, fontSize: 18 }}>Docker hosts</h2>
          <p className="muted" style={{ margin: "6px 0 0" }}>
            TLS-secured Engine endpoints for Compose. Empty team tags = visible to all users.
          </p>
        </div>
      )}

      <div className="row-between" style={{ marginBottom: 14 }}>
        <span className="muted" style={{ fontSize: 13 }}>{hosts.length} host{hosts.length === 1 ? "" : "s"}</span>
        <button type="button" className="btn btn-primary" onClick={openNew}>Add host</button>
      </div>

      {error && <div className="login-error" style={{ marginBottom: 12 }}>{error}</div>}

      {loading ? (
        <p className="muted">Loading…</p>
      ) : hosts.length === 0 && !editing ? (
        <EmptyState
          icon="🐳"
          title="No Docker hosts yet"
          description="Add a remote Engine with TCP TLS (typically port 2376)."
          actionLabel="Add host"
          onAction={openNew}
        />
      ) : (
        <div className="card" style={{ overflow: "auto" }}>
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Endpoint</th>
                <th>Teams</th>
                <th>TLS</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {hosts.map((h) => (
                <tr key={h.id}>
                  <td>
                    <strong>{h.name}</strong>
                    {!h.enabled && <span className="badge badge-neutral" style={{ marginLeft: 8 }}>Disabled</span>}
                  </td>
                  <td className="mono" style={{ fontSize: 12 }}>{h.endpoint}</td>
                  <td>{(h.teamTags || []).join(", ") || "— all —"}</td>
                  <td>
                    {h.skipTlsVerify ? (
                      <span className="badge badge-neutral" title="Certificate verification disabled">Skip verify</span>
                    ) : h.tlsConfigured ? (
                      "Configured"
                    ) : (
                      "Missing"
                    )}
                  </td>
                  <td>
                    {testResult?.id === h.id && testResult.checking && "Checking…"}
                    {testResult?.id === h.id && testResult.ok === true && <span className="badge badge-running">Healthy · {testResult.detail}</span>}
                    {testResult?.id === h.id && testResult.ok === false && (
                      <div>
                        <span className="badge badge-stopped">Unreachable</span>
                        <div className="login-error" style={{ marginTop: 6, maxWidth: 440, whiteSpace: "normal" }}>
                          {testResult.detail}
                        </div>
                      </div>
                    )}
                    {testResult?.id !== h.id && "—"}
                  </td>
                  <td>
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                      <button type="button" className="btn btn-ghost btn-sm" onClick={() => test(h)}>Test</button>
                      <button type="button" className="btn btn-ghost btn-sm" onClick={() => openEdit(h)}>Edit</button>
                      <button type="button" className="btn btn-ghost btn-sm" onClick={() => remove(h)}>Delete</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editing && (
        <div className="modal-overlay" onClick={() => setEditing(null)}>
          <div className="modal-card ch-modal" style={{ maxWidth: 640 }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>{editing === "new" ? "Add Docker host" : `Edit ${editing.name}`}</h3>
              <button type="button" className="ds-close" onClick={() => setEditing(null)} aria-label="Close">×</button>
            </div>
            <form className="modal-body ch-form" onSubmit={save}>
              <div className="field">
                <label>Name</label>
                <input className="control-input" value={form.name} onChange={upd("name")} required placeholder="app-team-docker" />
              </div>
              <div className="field">
                <label>Endpoint</label>
                <input className="control-input mono" value={form.endpoint} onChange={upd("endpoint")} required placeholder="tcp://docker01.lab:2376" />
              </div>
              <div className="field">
                <label>Team tags {groups.length > 0 && <span className="muted">(groups: {groups.map((g) => g.name).join(", ")})</span>}</label>
                <input className="control-input" value={form.teamTags} onChange={upd("teamTags")} placeholder="platform, payments — empty = all users" />
              </div>
              <div className="field">
                <label>App tags (optional)</label>
                <input className="control-input" value={form.appTags} onChange={upd("appTags")} placeholder="billing, portal" />
              </div>
              <div className="field">
                <label>TLS CA {editing !== "new" && <span className="muted">(leave blank to keep)</span>}</label>
                <textarea className="control-input mono" rows={3} value={form.tlsCa} onChange={upd("tlsCa")} placeholder="-----BEGIN CERTIFICATE-----" />
                <TextFileInput
                  accept=".pem,.crt,.cer,text/plain"
                  label="Upload CA"
                  onLoad={(text) => setForm((f) => ({ ...f, tlsCa: text }))}
                  disabled={busy}
                />
              </div>
              <div className="field">
                <label>Client certificate {editing !== "new" && <span className="muted">(leave blank to keep)</span>}</label>
                <textarea
                  className="control-input mono"
                  rows={3}
                  value={form.tlsCert}
                  onChange={upd("tlsCert")}
                  placeholder="-----BEGIN CERTIFICATE-----&#10;…&#10;-----END CERTIFICATE-----"
                />
                <p className="muted" style={{ margin: "4px 0 0", fontSize: 12 }}>
                  Must be a signed certificate (BEGIN CERTIFICATE), not a CSR (CERTIFICATE REQUEST) and not the Docker server cert.
                </p>
                <TextFileInput
                  accept=".pem,.crt,.cer,text/plain"
                  label="Upload certificate"
                  onLoad={(text) => setForm((f) => ({ ...f, tlsCert: text }))}
                  disabled={busy}
                />
              </div>
              <div className="field">
                <label>Client key {editing !== "new" && <span className="muted">(leave blank to keep)</span>}</label>
                <textarea className="control-input mono" rows={3} value={form.tlsKey} onChange={upd("tlsKey")} />
                <TextFileInput
                  accept=".pem,.key,text/plain"
                  label="Upload private key"
                  onLoad={(text) => setForm((f) => ({ ...f, tlsKey: text }))}
                  disabled={busy}
                />
              </div>
              <Toggle
                variant="danger"
                checked={form.skipTlsVerify}
                onChange={setBool("skipTlsVerify")}
                label="Skip TLS verification"
                description="Do not verify the Engine's server certificate (lab / self-signed). If client certificates are supplied, Docker still validates them for mutual TLS."
              />
              <Toggle
                variant="ok"
                checked={form.enabled}
                onChange={setBool("enabled")}
                label="Enabled"
                description="Disabled hosts are hidden from deploy pickers."
              />
              {formTest && !formTest.ok && (
                <div className={formTest.ok ? "pc-test-result is-ok" : formTest.checking ? "pc-test-result" : "pc-test-result is-error"}>
                  {formTest.checking ? "Testing connection…" : formTest.detail}
                </div>
              )}
              <div className="modal-footer" style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 12 }}>
                <button type="button" className="btn btn-ghost" onClick={() => setEditing(null)}>Cancel</button>
                <button type="submit" className="btn btn-ghost" disabled={busy}>{busy ? "Working…" : "Save"}</button>
                <button type="button" className="btn btn-primary" onClick={testAndSave} disabled={busy}>
                  {busy && formTest?.checking ? "Testing…" : "Test & save"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
