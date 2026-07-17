import { useEffect, useState } from "react";
import { getChatAnalytics } from "../api/client.js";
import AdminPageHeader from "../components/AdminPageHeader.jsx";

function Stat({ label, value, hint }) {
  return (
    <div className="chat-analytics-stat">
      <div className="chat-analytics-stat-value">{value}</div>
      <div className="chat-analytics-stat-label">{label}</div>
      {hint ? <div className="chat-analytics-stat-hint">{hint}</div> : null}
    </div>
  );
}

function RankTable({ title, rows, empty }) {
  return (
    <div className="chat-analytics-card">
      <h3 className="chat-analytics-card-title">{title}</h3>
      {!rows?.length ? (
        <p className="muted">{empty || "No data yet."}</p>
      ) : (
        <table className="chat-analytics-table">
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

  if (loading) return <p className="muted">Loading Forge Assist analytics…</p>;
  if (error) return <p className="muted" role="alert">{error}</p>;
  if (!data) return null;

  const s = data.summary || {};

  return (
    <div className="chat-analytics">
      <AdminPageHeader
        title="Forge Assist"
        description="Derived from saved chat sessions — top intents, approve vs drop-off after a plan is shown, and fields users change most between proposals."
      />

      <div className="chat-analytics-stats">
        <Stat label="Sessions" value={s.sessions ?? 0} />
        <Stat label="Messages" value={s.messages ?? 0} />
        <Stat label="Plans shown" value={s.proposalsShown ?? 0} />
        <Stat label="Approved / requested" value={s.approved ?? 0} />
        <Stat label="Drop-offs" value={s.dropOffs ?? 0} hint="Plan shown, no provision yet" />
        <Stat label="Approve rate" value={`${s.approveRate ?? 0}%`} />
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
