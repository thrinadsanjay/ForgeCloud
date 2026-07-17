import { nanoid } from "nanoid";
import { prisma, fireAndForget } from "../db/client.js";

const tickets = new Map();

function rowToTicket(row) {
  return {
    id: row.id,
    requestId: row.requestId,
    jobId: row.jobId,
    requestNumber: row.requestNumber,
    requestSysId: row.requestSysId,
    ritmNumber: row.ritmNumber,
    ritmSysId: row.ritmSysId,
    incidentNumber: row.incidentNumber,
    incidentSysId: row.incidentSysId,
    ciNumber: row.ciNumber,
    ciSysId: row.ciSysId,
    ciClass: row.ciClass,
    cmdbItems: Array.isArray(row.cmdbItems) ? row.cmdbItems : [],
    state: row.state,
    mock: row.mock,
    workNotes: Array.isArray(row.workNotes) ? row.workNotes : [],
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function hydrateServiceNowTickets() {
  const rows = await prisma.serviceNowTicket.findMany();
  tickets.clear();
  for (const row of rows) {
    tickets.set(row.requestId, rowToTicket(row));
  }
}

function persistTicket(ticket) {
  fireAndForget(
    prisma.serviceNowTicket.upsert({
      where: { id: ticket.id },
      create: {
        id: ticket.id,
        requestId: ticket.requestId,
        jobId: ticket.jobId,
        requestNumber: ticket.requestNumber,
        requestSysId: ticket.requestSysId,
        ritmNumber: ticket.ritmNumber,
        ritmSysId: ticket.ritmSysId,
        incidentNumber: ticket.incidentNumber,
        incidentSysId: ticket.incidentSysId,
        ciNumber: ticket.ciNumber,
        ciSysId: ticket.ciSysId,
        ciClass: ticket.ciClass,
        cmdbItems: ticket.cmdbItems || [],
        state: ticket.state,
        mock: ticket.mock,
        workNotes: ticket.workNotes,
        createdAt: new Date(ticket.createdAt),
        updatedAt: new Date(ticket.updatedAt),
      },
      update: {
        jobId: ticket.jobId,
        requestNumber: ticket.requestNumber,
        requestSysId: ticket.requestSysId,
        ritmNumber: ticket.ritmNumber,
        ritmSysId: ticket.ritmSysId,
        incidentNumber: ticket.incidentNumber,
        incidentSysId: ticket.incidentSysId,
        ciNumber: ticket.ciNumber,
        ciSysId: ticket.ciSysId,
        ciClass: ticket.ciClass,
        cmdbItems: ticket.cmdbItems || [],
        state: ticket.state,
        mock: ticket.mock,
        workNotes: ticket.workNotes,
        updatedAt: new Date(ticket.updatedAt),
      },
    }),
    "servicenow-ticket"
  );
}

export function getTicketByRequestId(requestId) {
  return tickets.get(requestId) || null;
}

export function getTicketByJobId(jobId) {
  for (const t of tickets.values()) {
    if (t.jobId === jobId) return t;
  }
  return null;
}

export function getTicketByRitm({ ritmNumber, ritmSysId } = {}) {
  const num = (ritmNumber || "").trim().toUpperCase();
  const sysId = (ritmSysId || "").trim();
  for (const t of tickets.values()) {
    if (sysId && t.ritmSysId === sysId) return t;
    if (num && String(t.ritmNumber || "").toUpperCase() === num) return t;
  }
  return null;
}

export function createTicket({ requestId, catalogResult }) {
  const now = new Date().toISOString();
  const ticket = {
    id: nanoid(12),
    requestId,
    jobId: null,
    requestNumber: catalogResult.requestNumber,
    requestSysId: catalogResult.requestSysId,
    ritmNumber: catalogResult.ritmNumber,
    ritmSysId: catalogResult.ritmSysId,
    incidentNumber: null,
    incidentSysId: null,
    ciNumber: null,
    ciSysId: null,
    ciClass: null,
    cmdbItems: [],
    state: catalogResult.state || "submitted",
    mock: !!catalogResult.mock,
    workNotes: [],
    createdAt: now,
    updatedAt: now,
  };
  tickets.set(requestId, ticket);
  persistTicket(ticket);
  return ticket;
}

export function updateTicket(requestId, patch) {
  const ticket = tickets.get(requestId);
  if (!ticket) return null;
  Object.assign(ticket, patch, { updatedAt: new Date().toISOString() });
  persistTicket(ticket);
  return ticket;
}

export function linkTicketToJob(requestId, jobId) {
  return updateTicket(requestId, { jobId });
}

export function appendLocalWorkNote(requestId, message) {
  const ticket = tickets.get(requestId);
  if (!ticket) return null;
  const entry = { ts: new Date().toISOString(), message };
  ticket.workNotes = [...(ticket.workNotes || []), entry];
  ticket.updatedAt = entry.ts;
  persistTicket(ticket);
  return entry;
}

/** Public shape for API responses. */
export function ticketSummary(ticket) {
  if (!ticket) return null;
  const base = process.env.SERVICENOW_INSTANCE_URL?.replace(/\/+$/, "") || null;
  return {
    requestNumber: ticket.requestNumber,
    requestSysId: ticket.requestSysId,
    ritmNumber: ticket.ritmNumber,
    ritmSysId: ticket.ritmSysId,
    incidentNumber: ticket.incidentNumber,
    incidentSysId: ticket.incidentSysId,
    ciNumber: ticket.ciNumber,
    ciSysId: ticket.ciSysId,
    ciClass: ticket.ciClass,
    cmdbItems: ticket.cmdbItems || [],
    state: ticket.state,
    mock: ticket.mock,
    requestUrl: ticket.requestSysId && base
      ? `${base}/nav_to.do?uri=sc_request.do?sys_id=${ticket.requestSysId}`
      : null,
    ritmUrl: ticket.ritmSysId && base
      ? `${base}/nav_to.do?uri=sc_req_item.do?sys_id=${ticket.ritmSysId}`
      : null,
    incidentUrl: ticket.incidentSysId && base
      ? `${base}/nav_to.do?uri=incident.do?sys_id=${ticket.incidentSysId}`
      : null,
    ciUrl: ticket.ciSysId && base
      ? `${base}/nav_to.do?uri=${ticket.ciClass || "cmdb_ci_server"}.do?sys_id=${ticket.ciSysId}`
      : null,
  };
}
