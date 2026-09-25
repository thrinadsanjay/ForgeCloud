/** ServiceNow REQ/RITM/incident/CMDB links for jobs and requests. */
export default function ServiceNowPanel({ servicenow, incident, compact = false }) {
  const sn = servicenow || {};
  const inc = incident || (sn.incidentNumber ? {
    number: sn.incidentNumber,
    url: sn.incidentUrl,
  } : null);
  const cmdbList = Array.isArray(sn.cmdbItems) && sn.cmdbItems.length
    ? sn.cmdbItems
    : (sn.ciNumber ? [{ ciNumber: sn.ciNumber, name: sn.ciNumber, url: sn.ciUrl }] : []);

  if (!sn.ritmNumber && !sn.requestNumber && !inc?.number && !cmdbList.length) return null;

  if (compact) {
    return (
      <div className="sn-compact mono" style={{ fontSize: 12.5, marginBottom: 8 }}>
        {sn.ritmNumber && (
          <span>
            RITM:{" "}
            {sn.ritmUrl ? (
              <a href={sn.ritmUrl} target="_blank" rel="noreferrer">{sn.ritmNumber}</a>
            ) : sn.ritmNumber}
            {sn.mock && <span className="muted"> (demo)</span>}
          </span>
        )}
        {cmdbList.length > 0 && (
          <span style={{ marginLeft: sn.ritmNumber ? 12 : 0 }}>
            CI:{" "}
            {cmdbList.map((c, i) => (
              <span key={c.ciSysId || c.ciNumber || i}>
                {i > 0 ? ", " : ""}
                {c.url ? (
                  <a href={c.url} target="_blank" rel="noreferrer">{c.ciNumber}</a>
                ) : c.ciNumber}
              </span>
            ))}
          </span>
        )}
        {inc?.number && (
          <span style={{ marginLeft: (sn.ritmNumber || cmdbList.length) ? 12 : 0 }}>
            INC:{" "}
            {inc.url ? (
              <a href={inc.url} target="_blank" rel="noreferrer">{inc.number}</a>
            ) : inc.number}
          </span>
        )}
      </div>
    );
  }

  return (
    <div className="ds-section">
      <div className="ds-section-title">ServiceNow</div>
      <div className="ds-detail-grid">
        {sn.requestNumber && (
          <div>
            <span>Request</span>
            <b className="mono">
              {sn.requestUrl ? (
                <a href={sn.requestUrl} target="_blank" rel="noreferrer">{sn.requestNumber}</a>
              ) : sn.requestNumber}
            </b>
          </div>
        )}
        {sn.ritmNumber && (
          <div>
            <span>RITM</span>
            <b className="mono">
              {sn.ritmUrl ? (
                <a href={sn.ritmUrl} target="_blank" rel="noreferrer">{sn.ritmNumber}</a>
              ) : sn.ritmNumber}
            </b>
          </div>
        )}
        {cmdbList.map((c) => (
          <div key={c.ciSysId || c.ciNumber}>
            <span>CMDB CI</span>
            <b className="mono">
              {c.url ? (
                <a href={c.url} target="_blank" rel="noreferrer">{c.ciNumber}</a>
              ) : c.ciNumber}
              {c.name && c.name !== c.ciNumber && (
                <span className="muted" style={{ fontWeight: 400, marginLeft: 6 }}>{c.name}</span>
              )}
            </b>
          </div>
        ))}
        {sn.state && (
          <div>
            <span>Ticket state</span>
            <b>{sn.state.replace(/_/g, " ")}</b>
          </div>
        )}
        {inc?.number && (
          <div>
            <span>Incident</span>
            <b className="mono">
              {inc.url ? (
                <a href={inc.url} target="_blank" rel="noreferrer">{inc.number}</a>
              ) : inc.number}
            </b>
          </div>
        )}
      </div>
      {sn.mock && <p className="ds-note">Demo mode — configure ServiceNow URL and catalog item sys_id in Settings for live tickets.</p>}
    </div>
  );
}
