import { useEffect, useState } from "react";
import { getChatAnalytics } from "../api/client.js";
import AdminPageHeader from "../components/AdminPageHeader.jsx";

function RankTable({ title, rows, empty }) {
  return (
    <div className="adm-table-wrap">
      <div className="adm-table-head">
        <h3 className="adm-table-title">{title}</h3>
      </div>
      <div className="adm-scroll">
        {!rows?.length ? (
          <p className="muted" style={{ padding: "14px" }}>{empty || "No data yet."}</p>
        ) : (
          <table className="table table-dense">
            <thead>
              <tr>
                <th>Name</th>
                <th>Count</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.name}>
                  <td>{r.name}</td>
                  <td>{r.count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

export default function ChatAnalytics() {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getChatAnalytics()
      .then((res) => {
        if (!cancelled) setData(res);
      })
      .catch((err) => {
        if (!cancelled) setError(err.response?.data?.error || err.message || "Failed to load");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) {
    return (
      <div className="adm-board">
        <AdminPageHeader title="Forge Assist" description="Loading analytics…" />
        <p className="muted">Loading Forge Assist analytics…</p>
      </div>
    );
  }
  if (error) {
    return (
      <div className="adm-board">
        <AdminPageHeader title="Forge Assist" description="Could not load analytics." />
        <p className="muted" role="alert">{error}</p>
      </div>
    );
  }
  if (!data) return null;

  const s = data.summary || {};

  return (
    <div className="adm-board">
      <AdminPageHeader
        title="Forge Assist"
        description="Derived from saved chat sessions — top intents, approve vs drop-off after a plan is shown, and fields users change most between proposals."
      />

      <div className="adm-stat-grid" style={{ gridTemplateColumns: "repeat(3, minmax(0, 1fr))" }}>
        <div className="adm-stat-card">
          <span className="adm-stat-icon is-brand" aria-hidden="true">◎</span>
          <div>
            <div className="adm-stat-label">Sessions</div>
            <div className="adm-stat-value">{s.sessions ?? 0}</div>
            <div className="adm-stat-hint">{s.messages ?? 0} messages</div>
          </div>
        </div>
        <div className="adm-stat-card">
          <span className="adm-stat-icon is-blue" aria-hidden="true">▣</span>
          <div>
            <div className="adm-stat-label">Plans shown</div>
            <div className="adm-stat-value">{s.proposalsShown ?? 0}</div>
            <div className="adm-stat-hint">{s.approved ?? 0} approved</div>
          </div>
        </div>
        <div className="adm-stat-card">
          <span className="adm-stat-icon is-amber" aria-hidden="true">↘</span>
          <div>
            <div className="adm-stat-label">Drop-offs</div>
            <div className="adm-stat-value">{s.dropOffs ?? 0}</div>
            <div className="adm-stat-hint">{s.approveRate ?? 0}% approve rate</div>
          </div>
        </div>
      </div>

      <div className="chat-analytics-grid">
        <RankTable title="Top intents" rows={data.topIntents} empty="No user chats yet." />
        <RankTable title="Proposals by kind" rows={data.proposalsByKind} />
        <RankTable
          title="Most-modified fields"
          rows={data.mostModifiedFields}
          empty="No refined proposals yet (size, network, packages, …)."
        />
      </div>
    </div>
  );
}
