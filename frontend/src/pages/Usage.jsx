import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { getMyUsage, getAdminUsage, getTeamUsage } from "../api/client.js";
import { useAuth } from "../context/AuthContext.jsx";
import { isAdminRole } from "../lib/roles.js";
import EmptyState from "../components/EmptyState.jsx";

function fmtMoney(n, currency = "INR") {
  const v = Number(n) || 0;
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      maximumFractionDigits: 0,
    }).format(v);
  } catch {
    return `${currency} ${Math.round(v).toLocaleString()}`;
  }
}

function QuotaBar({ used, max, label }) {
  if (!max) return <span className="muted">{label}: {used} (unlimited)</span>;
  const pct = Math.min(100, Math.round((used / max) * 100));
  const tone = pct >= 90 ? "red" : pct >= 70 ? "amber" : "ok";
  return (
    <div className={`usage-quota-bar usage-quota-${tone}`}>
      <div className="usage-quota-meta">
        <span>{label}</span>
        <strong>{used} / {max}</strong>
      </div>
      <div className="usage-quota-track" aria-hidden="true">
        <span style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function TotalsCards({ totals, currency }) {
  return (
    <div className="usage-stat-grid">
      <div className="usage-stat">
        <span className="muted">Resources</span>
        <strong>{totals?.vms ?? 0}</strong>
      </div>
      <div className="usage-stat">
        <span className="muted">vCPU</span>
        <strong>{totals?.cpu ?? 0}</strong>
      </div>
      <div className="usage-stat">
        <span className="muted">RAM</span>
        <strong>{totals?.memoryGB ?? 0} GB</strong>
      </div>
      <div className="usage-stat">
        <span className="muted">Disk</span>
        <strong>{totals?.diskGB ?? 0} GB</strong>
      </div>
      <div className="usage-stat usage-stat-cost">
        <span className="muted">Est. monthly</span>
        <strong>{fmtMoney(totals?.estimatedMonthly, currency)}</strong>
      </div>
    </div>
  );
}

function ResourceTable({ rows }) {
  if (!rows?.length) {
    return <p className="muted" style={{ margin: 0 }}>No owned compute resources.</p>;
  }
  return (
    <div className="card" style={{ overflow: "auto" }}>
      <table className="table">
        <thead>
          <tr>
            <th>Host</th>
            <th>Owner</th>
            <th>Status</th>
            <th>CPU</th>
            <th>RAM</th>
            <th>Disk</th>
            <th>Est. / mo</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={`${r.owner || ""}-${r.vmid}`}>
              <td>
                <strong>{r.hostname}</strong>
                <div className="mono muted" style={{ fontSize: 12 }}>#{r.vmid}{r.ip ? ` · ${r.ip}` : ""}</div>
              </td>
              <td>{r.owner || "—"}</td>
              <td><span className={`badge ${r.status === "running" ? "badge-running" : "badge-neutral"}`}>{r.status}</span></td>
              <td className="mono">{r.cpu}</td>
              <td className="mono">{r.memoryGB}G</td>
              <td className="mono">{r.diskGB}G</td>
              <td className="mono">{fmtMoney(r.estimatedMonthly)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function Usage() {
  const { user } = useAuth();
  const admin = isAdminRole(user?.role);
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") || (admin ? "overview" : "mine");
  const teamFocus = params.get("team") || "";

  const [me, setMe] = useState(null);
  const [adminData, setAdminData] = useState(null);
  const [teamDetail, setTeamDetail] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const setTab = (next) => {
    const p = new URLSearchParams(params);
    p.set("tab", next);
    if (next !== "teams") p.delete("team");
    setParams(p, { replace: true });
  };

  const openTeam = (name) => {
    const p = new URLSearchParams(params);
    p.set("tab", "teams");
    p.set("team", name);
    setParams(p, { replace: true });
  };

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError("");
    (async () => {
      try {
        // Always keep personal usage available for the "My usage" tab.
        const personal = await getMyUsage().catch(() => null);
        if (alive && personal) setMe(personal);

        if (admin && (tab === "overview" || tab === "users" || tab === "teams" || tab === "rates")) {
          const data = await getAdminUsage();
          if (!alive) return;
          setAdminData(data);
        }

        if (teamFocus) {
          const detail = await getTeamUsage(teamFocus);
          if (alive) setTeamDetail(detail);
        } else if (alive) {
          setTeamDetail(null);
        }
      } catch (e) {
        if (alive) setError(e.response?.data?.error || e.message);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [admin, tab, teamFocus]);

  const currency = adminData?.currency || me?.currency || "INR";
  const disclaimer = adminData?.disclaimer || me?.disclaimer;

  const tabs = useMemo(() => {
    if (admin) {
      return [
        { id: "overview", label: "Overview" },
        { id: "teams", label: "Teams" },
        { id: "users", label: "Users" },
        { id: "rates", label: "Rates" },
        { id: "mine", label: "My usage" },
      ];
    }
    return [
      { id: "mine", label: "My usage" },
      { id: "teams", label: "My teams" },
    ];
  }, [admin]);

  return (
    <div className="page usage-page">
      <div className="page-head">
        <div className="eyebrow">{admin ? "Administration" : "Account"}</div>
        <h1>Usage &amp; cost</h1>
        <p>
          Estimated showback from catalog rates and current resource sizes.
          {disclaimer ? ` ${disclaimer}` : ""}
        </p>
      </div>

      <div className="usage-tabs" role="tablist" aria-label="Usage views">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            className={`usage-tab ${tab === t.id ? "on" : ""}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {error && <div className="login-error" style={{ marginBottom: 14 }}>{error}</div>}
      {loading && <p className="muted">Loading usage…</p>}

      {!loading && !error && tab === "overview" && admin && adminData && (
        <section className="usage-section">
          <TotalsCards totals={adminData.overview} currency={currency} />
          <div className="usage-stat-grid" style={{ marginTop: 12 }}>
            <div className="usage-stat">
              <span className="muted">Users</span>
              <strong>{adminData.overview.users}</strong>
            </div>
            <div className="usage-stat">
              <span className="muted">With resources</span>
              <strong>{adminData.overview.usersWithResources}</strong>
            </div>
            <div className="usage-stat">
              <span className="muted">Teams</span>
              <strong>{adminData.overview.teams}</strong>
            </div>
          </div>

          <h2 className="usage-h2">Top teams by estimated cost</h2>
          <div className="card" style={{ overflow: "auto" }}>
            <table className="table">
              <thead>
                <tr>
                  <th>Team</th>
                  <th>Members</th>
                  <th>VMs</th>
                  <th>CPU</th>
                  <th>RAM</th>
                  <th>Est. / mo</th>
                </tr>
              </thead>
              <tbody>
                {adminData.teams.slice(0, 8).map((t) => (
                  <tr key={t.name}>
                    <td>
                      <button type="button" className="linkish" onClick={() => openTeam(t.name)}>
                        {t.name}
                      </button>
                    </td>
                    <td>{t.memberCount}</td>
                    <td className="mono">{t.totals.vms}</td>
                    <td className="mono">{t.totals.cpu}</td>
                    <td className="mono">{t.totals.memoryGB}G</td>
                    <td className="mono">{fmtMoney(t.totals.estimatedMonthly, currency)}</td>
                  </tr>
                ))}
                {!adminData.teams.length && (
                  <tr><td colSpan={6} className="empty">No teams yet.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {!loading && !error && tab === "users" && admin && adminData && (
        <section className="usage-section">
          <div className="card" style={{ overflow: "auto" }}>
            <table className="table">
              <thead>
                <tr>
                  <th>User</th>
                  <th>Role</th>
                  <th>VMs</th>
                  <th>CPU</th>
                  <th>RAM</th>
                  <th>Disk</th>
                  <th>Est. / mo</th>
                </tr>
              </thead>
              <tbody>
                {adminData.users.map((u) => (
                  <tr key={u.username}>
                    <td>
                      <strong>{u.displayName || u.username}</strong>
                      <div className="mono muted" style={{ fontSize: 12 }}>{u.username}</div>
                    </td>
                    <td>{u.role}</td>
                    <td className="mono">{u.totals.vms}</td>
                    <td className="mono">{u.totals.cpu}</td>
                    <td className="mono">{u.totals.memoryGB}G</td>
                    <td className="mono">{u.totals.diskGB}G</td>
                    <td className="mono">{fmtMoney(u.totals.estimatedMonthly, currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {!loading && !error && tab === "rates" && admin && adminData && (
        <section className="usage-section">
          <div className="card card-pad">
            <h2 className="usage-h2" style={{ marginTop: 0 }}>Catalog rates</h2>
            <p className="muted">Used for estimated monthly showback on this page and the provision form.</p>
            <dl className="usage-rates">
              <div><dt>Per vCPU / month</dt><dd className="mono">{fmtMoney(adminData.rates.perCpu, currency)}</dd></div>
              <div><dt>Per GB RAM / month</dt><dd className="mono">{fmtMoney(adminData.rates.perGbRam, currency)}</dd></div>
              <div><dt>Per GB disk / month</dt><dd className="mono">{fmtMoney(adminData.rates.perGbStorage, currency)}</dd></div>
            </dl>
            <Link className="btn btn-primary btn-sm" to="/admin?tab=cost">Edit rates in Admin</Link>
          </div>
        </section>
      )}

      {!loading && !error && tab === "mine" && (me || (admin && adminData)) && (
        <section className="usage-section">
          {(() => {
            const mine = me || null;
            // Admin "My usage" still loads /usage/me when tab flips — ensure me is loaded
            if (!mine) return <p className="muted">Loading your usage…</p>;
            return (
              <>
                <TotalsCards totals={mine.me.totals} currency={currency} />
                <h2 className="usage-h2">My resources</h2>
                <ResourceTable rows={mine.me.resources} />
                {mine.teams?.length > 0 && (
                  <>
                    <h2 className="usage-h2">My teams</h2>
                    <div className="usage-team-grid">
                      {mine.teams.map((t) => (
                        <button key={t.name} type="button" className="usage-team-card" onClick={() => openTeam(t.name)}>
                          <strong>{t.name}</strong>
                          <span className="muted">{t.totals.vms} resources · {fmtMoney(t.totals.estimatedMonthly, currency)}/mo</span>
                          {t.limited && (
                            <div className="usage-quota-stack">
                              {t.quotas.maxVms ? <QuotaBar used={t.used.vms} max={t.quotas.maxVms} label="VMs" /> : null}
                              {t.quotas.maxCpu ? <QuotaBar used={t.used.cpu} max={t.quotas.maxCpu} label="CPU" /> : null}
                              {t.quotas.maxMemoryGB ? <QuotaBar used={t.used.memoryGB} max={t.quotas.maxMemoryGB} label="RAM GB" /> : null}
                            </div>
                          )}
                        </button>
                      ))}
                    </div>
                  </>
                )}
                {!mine.teams?.length && (
                  <EmptyState
                    icon="◇"
                    title="No team memberships"
                    description="When an admin adds you to a group, team quotas and shared usage appear here."
                  />
                )}
              </>
            );
          })()}
        </section>
      )}

      {!loading && !error && tab === "teams" && !teamFocus && (
        <section className="usage-section">
          {admin && adminData ? (
            <div className="card" style={{ overflow: "auto" }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>Team</th>
                    <th>Quota</th>
                    <th>VMs</th>
                    <th>CPU</th>
                    <th>RAM</th>
                    <th>Est. / mo</th>
                  </tr>
                </thead>
                <tbody>
                  {adminData.teams.map((t) => (
                    <tr key={t.name}>
                      <td>
                        <button type="button" className="linkish" onClick={() => openTeam(t.name)}>{t.name}</button>
                        <div className="muted" style={{ fontSize: 12 }}>{t.memberCount} members</div>
                      </td>
                      <td>
                        {t.limited ? (
                          <span className="muted" style={{ fontSize: 12.5 }}>
                            {t.quotas.maxVms ? `VMs ${t.used.vms}/${t.quotas.maxVms}` : ""}
                            {t.quotas.maxCpu ? ` · CPU ${t.used.cpu}/${t.quotas.maxCpu}` : ""}
                            {t.quotas.maxMemoryGB ? ` · RAM ${t.used.memoryGB}/${t.quotas.maxMemoryGB}` : ""}
                          </span>
                        ) : <span className="muted">Unlimited</span>}
                      </td>
                      <td className="mono">{t.totals.vms}</td>
                      <td className="mono">{t.totals.cpu}</td>
                      <td className="mono">{t.totals.memoryGB}G</td>
                      <td className="mono">{fmtMoney(t.totals.estimatedMonthly, currency)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : me ? (
            <div className="usage-team-grid">
              {me.teams.map((t) => (
                <button key={t.name} type="button" className="usage-team-card" onClick={() => openTeam(t.name)}>
                  <strong>{t.name}</strong>
                  <span className="muted">{t.totals.vms} resources · {fmtMoney(t.totals.estimatedMonthly, currency)}/mo</span>
                </button>
              ))}
              {!me.teams.length && (
                <EmptyState icon="◇" title="No teams" description="You are not a member of any group yet." />
              )}
            </div>
          ) : null}
        </section>
      )}

      {!loading && !error && tab === "teams" && teamFocus && teamDetail?.team && (
        <section className="usage-section">
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setTab("teams")} style={{ marginBottom: 12 }}>
            ← All teams
          </button>
          <h2 className="usage-h2" style={{ marginTop: 0 }}>{teamDetail.team.name}</h2>
          <TotalsCards totals={teamDetail.team.totals} currency={currency} />
          {teamDetail.team.limited && (
            <div className="usage-quota-stack" style={{ margin: "14px 0" }}>
              {teamDetail.team.quotas.maxVms ? <QuotaBar used={teamDetail.team.used.vms} max={teamDetail.team.quotas.maxVms} label="VMs" /> : null}
              {teamDetail.team.quotas.maxCpu ? <QuotaBar used={teamDetail.team.used.cpu} max={teamDetail.team.quotas.maxCpu} label="CPU" /> : null}
              {teamDetail.team.quotas.maxMemoryGB ? <QuotaBar used={teamDetail.team.used.memoryGB} max={teamDetail.team.quotas.maxMemoryGB} label="RAM GB" /> : null}
            </div>
          )}
          <h3 className="usage-h3">Members</h3>
          <div className="card" style={{ overflow: "auto", marginBottom: 16 }}>
            <table className="table">
              <thead>
                <tr>
                  <th>Member</th>
                  <th>Resources</th>
                  <th>CPU</th>
                  <th>RAM</th>
                  <th>Est. / mo</th>
                </tr>
              </thead>
              <tbody>
                {teamDetail.team.members.map((m) => (
                  <tr key={m.username}>
                    <td>
                      <strong>{m.displayName || m.username}</strong>
                      <div className="mono muted" style={{ fontSize: 12 }}>{m.username}</div>
                    </td>
                    <td className="mono">{m.totals.vms}</td>
                    <td className="mono">{m.totals.cpu}</td>
                    <td className="mono">{m.totals.memoryGB}G</td>
                    <td className="mono">{fmtMoney(m.totals.estimatedMonthly, currency)}</td>
                  </tr>
                ))}
                {!teamDetail.team.members.length && (
                  <tr><td colSpan={5} className="empty">No members with ownership records.</td></tr>
                )}
              </tbody>
            </table>
          </div>
          <h3 className="usage-h3">Team resources</h3>
          <ResourceTable rows={teamDetail.team.resources} />
        </section>
      )}
    </div>
  );
}
