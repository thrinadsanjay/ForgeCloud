import { useEffect, useRef, useState } from "react";
import {
  streamChatMessage,
  getJob,
  listChatSessions,
  createChatSession,
  getChatSession,
  saveChatSession,
  deleteChatSession,
  getVmTemplates,
  getContainerTemplates,
  getStacks,
  getEnvironments,
  getPackages,
  getCostRates,
  extendResource,
  getTemplateDefaults,
  provisionVm,
  provisionContainer,
  provisionStack,
  provisionInternal,
  resourceAction,
} from "../api/client.js";
import TerminalModal from "./TerminalModal.jsx";
import ChatMarkdown from "./ChatMarkdown.jsx";
import { useAuth } from "../context/AuthContext.jsx";
import { useLocation, useNavigate } from "react-router-dom";
import { useFloatingPanel } from "../hooks/useFloatingPanel.js";
import ProvisionForm, {
  DEFAULT_COST_RATES,
  FALLBACK_PACKAGE_IDS,
  buildPackageCategories,
  formatMoney,
} from "./ProvisionForm.jsx";
import {
  QUICK_ACTIONS,
  matchOfflineIntent,
  runOfflineIntent,
  renewExpiringItem,
  retryFailedJob,
} from "../lib/chatOffline.js";

const OPEN_GREETING_TEXT = "How may I help you today?";

function personalizedGreeting(firstName) {
  const name = firstName ? ` ${firstName}` : "";
  return {
    role: "assistant",
    text: `Hi${name} — ${OPEN_GREETING_TEXT.toLowerCase()} Use the shortcuts below for list / status / reboot / renew / failed jobs (works without AI), or describe a new workload for a plan to Approve or Modify.`,
  };
}

function formatSessionWhen(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

const QUICK_PROMPTS = [
  "I want to run an LLM",
  "I need to host a website",
  "I want an NFS file server",
  "Propose a small API server",
];

// Fallback pre-selection when the assistant couldn't infer packages from the
// use case (e.g. a bare "give me a VM"). Use-case matches from the backend take
// precedence over these.
const FALLBACK_PACKAGES_BY_KIND = {
  vm: ["python"],
  container: ["python"],
  stack: ["python", "postgres"],
};

const FALLBACK_PACKAGE_OPTIONS = ["python", "docker", "git", "nginx", "postgres"];

// Resolve the packages that should start out checked: prefer whatever the
// assistant inferred from the use case, keeping only names we can actually
// render, and fall back to a light per-kind default when nothing was inferred.
function resolveSelectedPackages(proposal, kind, packageOptions = FALLBACK_PACKAGE_OPTIONS) {
  const source =
    proposal.packageSelection?.selected ||
    proposal.packageSelection?.effective ||
    proposal.packages ||
    proposal.additionalPackages ||
    proposal.packageSelection?.additional;
  const known = Array.isArray(source) ? source.filter((pkg) => packageOptions.includes(pkg)) : [];
  const list = known.length ? known : FALLBACK_PACKAGES_BY_KIND[kind] || [];
  return Array.from(new Set(list));
}

// Environments come only from admin-labelled networks (Mappings). Never invent
// a bridge like vmbr0 — if none are mapped, leave the list empty.
function environmentOptions(catalogs) {
  return Array.isArray(catalogs.environments) ? catalogs.environments : [];
}

function environmentLabel(iface, catalogs) {
  if (!iface) return "Not selected";
  const env = environmentOptions(catalogs).find((e) => e.iface === iface || e.label === iface);
  return env?.label || iface;
}

// Derive a valid Linux login name from the signed-in user so the proposal is
// prefilled and never blocks on an empty username.
function defaultUsernameFrom(user) {
  const raw = (user?.username || user?.displayName || user?.email || "").split("@")[0];
  const clean = raw.toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 20);
  if (!clean) return "clouduser";
  return /^[a-z]/.test(clean) ? clean : `u${clean}`;
}

function ensureProposalShape(proposal, catalogs) {
  if (!proposal) return null;
  const pkgOpts = catalogs.packageOptions || FALLBACK_PACKAGE_OPTIONS;

  if (proposal.kind === "stack") {
    const stack = catalogs.stacks.find((s) => s.id === proposal.stackId);
    if (!stack && catalogs.vmTemplates.length) {
      return ensureProposalShape({
        ...proposal,
        kind: "vm",
        templateId: catalogs.vmTemplates[0].id,
        templateName: catalogs.vmTemplates[0].name,
        hostname: proposal.hostname || proposal.hostnamePrefix || "",
      }, catalogs);
    }
    const resolved = stack || catalogs.stacks[0] || null;
    return {
      ...proposal,
      kind: "stack",
      stackId: proposal.stackId || resolved?.id || "",
      stackName: proposal.stackName || resolved?.name || "",
      hostnamePrefix: proposal.hostnamePrefix || "",
      cpu: Number(proposal.cpu) > 0 ? Number(proposal.cpu) : 2,
      memoryGB: Number(proposal.memoryGB) > 0 ? Number(proposal.memoryGB) : 2,
      additionalDiskGB: Number(proposal.additionalDiskGB) || 0,
      packages: resolveSelectedPackages(proposal, "stack", pkgOpts),
    };
  }

  if (proposal.kind === "container") {
    const template = catalogs.containerTemplates.find((t) => t.id === proposal.templateId);
    if (!template && catalogs.vmTemplates.length) {
      return ensureProposalShape({
        ...proposal,
        kind: "vm",
        templateId: catalogs.vmTemplates[0].id,
        templateName: catalogs.vmTemplates[0].name,
      }, catalogs);
    }
    const resolved = template || catalogs.containerTemplates[0] || null;
    return {
      ...proposal,
      kind: "container",
      templateId: proposal.templateId || resolved?.id || "",
      templateName: proposal.templateName || resolved?.name || "",
      hostname: proposal.hostname || "",
      cpu: Number(proposal.cpu) > 0 ? Number(proposal.cpu) : 2,
      memoryGB: Number(proposal.memoryGB) > 0 ? Number(proposal.memoryGB) : 2,
      packages: resolveSelectedPackages(proposal, "container", pkgOpts),
    };
  }

  const template = catalogs.vmTemplates.find((t) => t.id === proposal.templateId)
    || (proposal.templateId ? null : catalogs.vmTemplates[0])
    || null;
  const envOpts = environmentOptions(catalogs);
  const envRaw = String(proposal.environment || "").trim();
  const envMatch = envOpts.find((e) => e.iface === envRaw || e.label === envRaw)
    || (envOpts.length === 1 && !envRaw ? envOpts[0] : null);
  return {
    ...proposal,
    kind: "vm",
    templateId: proposal.templateId || template?.id || "",
    templateName: proposal.templateName || template?.name || "",
    hostname: proposal.hostname || "",
    cpu: Number(proposal.cpu) > 0 ? Number(proposal.cpu) : 2,
    memoryGB: Number(proposal.memoryGB) > 0 ? Number(proposal.memoryGB) : 2,
    additionalDiskGB: Number(proposal.additionalDiskGB) || 0,
    // Keep the backend iface; resolve to mapped iface when catalogs are loaded.
    environment: envMatch?.iface || envRaw,
    username: proposal.username || catalogs.defaultUsername || "",
    sudoAccess: proposal.sudoAccess ?? false,
    packages: resolveSelectedPackages(proposal, "vm", pkgOpts),
  };
}

function proposalIssues(proposal, catalogs) {
  const draft = ensureProposalShape(proposal, catalogs);
  if (!draft) return ["Proposal is unavailable."];
  if (!draft.cpu || !draft.memoryGB) return ["CPU and memory are required."];
  if (draft.kind === "stack") {
    const stack = catalogs.stacks.find((s) => s.id === draft.stackId);
    const issues = [];
    if (!stack) issues.push("No valid stack is selected.");
    if (!draft.hostnamePrefix) issues.push("Hostname prefix is required.");
    return issues;
  }
  if (draft.kind === "container") {
    const template = catalogs.containerTemplates.find((t) => t.id === draft.templateId);
    const issues = [];
    if (!template && catalogs.containerTemplates.length) issues.push("No valid container template is selected.");
    if (!draft.hostname) issues.push("Hostname is required.");
    return issues;
  }
  const template = catalogs.vmTemplates.find((t) => t.id === draft.templateId);
  const issues = [];
  // Only flag a missing template when the catalog is loaded — otherwise a
  // transient load failure would block Approve on a perfectly valid proposal.
  if (!template && catalogs.vmTemplates.length) issues.push("No valid VM template is selected.");
  if (!draft.templateId) issues.push("No valid VM template is selected.");
  if (!draft.hostname) issues.push("Hostname is required.");
  if (!draft.environment) issues.push("Network is required.");
  if (!draft.username) issues.push("Username is required.");
  return issues;
}

const KIND_BADGE = { vm: "Virtual machine", container: "Container", stack: "Stack" };

function formatLifetimeLabel(proposal) {
  if (proposal?.permanent) return "Permanent";
  const days = Number(proposal?.ttlDays);
  if (!Number.isFinite(days) || days <= 0) return null;
  if (days === 1) return "1 day";
  if (days % 365 === 0) {
    const y = days / 365;
    return `${y} year${y === 1 ? "" : "s"}`;
  }
  if (days % 30 === 0) {
    const m = days / 30;
    return `${m} month${m === 1 ? "" : "s"}`;
  }
  if (days % 7 === 0) {
    const w = days / 7;
    return `${w} week${w === 1 ? "" : "s"}`;
  }
  return `${days} days`;
}

function ttlFieldsFromProposal(proposal) {
  if (proposal?.permanent) return { ttlUnit: "permanent", ttlValue: 30 };
  const days = Number(proposal?.ttlDays);
  if (!Number.isFinite(days) || days <= 0) return { ttlUnit: "days", ttlValue: 30 };
  if (days % 365 === 0) return { ttlUnit: "years", ttlValue: days / 365 };
  if (days % 30 === 0) return { ttlUnit: "months", ttlValue: days / 30 };
  return { ttlUnit: "days", ttlValue: days };
}

const TTL_CHIP_VALUES = {
  "2 days": { ttlDays: 2, permanent: false },
  "1 week": { ttlDays: 7, permanent: false },
  "30 days": { ttlDays: 30, permanent: false },
  Permanent: { ttlDays: null, permanent: true },
};

const POST_BUILD_CHIPS = [
  "Install more packages?",
  "Extend lifetime by 7 days",
  "Show my resources",
];

// Fallback cost calc for proposals that predate server-side cost, or when rates
// changed after the proposal was drafted.
function computeCostFallback(draft, rates = DEFAULT_COST_RATES) {
  const cpu = Number(draft.cpu) || 0;
  const memoryGB = Number(draft.memoryGB) || 0;
  const extraDisk = draft.kind === "container" ? 0 : (Number(draft.additionalDiskGB) || 0);
  const cpuCost = cpu * (rates.perCpu || 0);
  const ramCost = memoryGB * (rates.perGbRam || 0);
  const storageCost = extraDisk * (rates.perGbStorage || 0);
  return {
    currency: rates.currency || "INR",
    perCpu: rates.perCpu || 0,
    perGbRam: rates.perGbRam || 0,
    perGbStorage: rates.perGbStorage || 0,
    cpuCost, ramCost, storageCost,
    total: cpuCost + ramCost + storageCost,
    hasStorage: extraDisk > 0,
  };
}

// A provisioning proposal rendered as a read-only estimation slip: labelled
// spec rows + an itemized monthly cost, with Approve / Modify actions.
function ProposalCard({ proposal, catalogs, busy, onApprove, onModify }) {
  const draft = ensureProposalShape(proposal, catalogs);
  if (!draft) return null;

  const name = draft.kind === "stack" ? draft.stackName : draft.templateName;
  const packages = draft.packages || [];
  const cost = draft.cost || computeCostFallback(draft, catalogs.costRates);
  const cur = cost.currency;
  const sizeLabel = draft.size ? draft.size.charAt(0).toUpperCase() + draft.size.slice(1) : "Custom";
  const issues = proposalIssues(draft, catalogs);
  const canApprove = issues.length === 0;

  return (
    <div className="chat-slip">
      <div className="chat-slip-head">
        <div>
          <div className="chat-slip-eyebrow">Recommended plan</div>
          <div className="chat-slip-title">{name || "Proposed resource"}</div>
        </div>
        <span className="chat-slip-badge">{KIND_BADGE[draft.kind] || "Resource"}</span>
      </div>

      {draft.rationale || draft.description ? (
        <p className="chat-slip-desc">{draft.rationale || draft.description}</p>
      ) : null}

      <div className="chat-slip-rows">
        <div className="chat-slip-row">
          <span className="chat-slip-k">Size</span>
          <span className="chat-slip-v">{sizeLabel}</span>
        </div>
        {draft.sizeReason && (
          <div className="chat-slip-advice">
            <span className="chat-slip-advice-k">Why this size</span>
            <span className="chat-slip-advice-v">{draft.sizeReason}</span>
          </div>
        )}
        <div className="chat-slip-row">
          <span className="chat-slip-k">CPU</span>
          <span className="chat-slip-v">{draft.cpu} {draft.cpu === 1 ? "core" : "cores"}</span>
        </div>
        <div className="chat-slip-row">
          <span className="chat-slip-k">Memory</span>
          <span className="chat-slip-v">{draft.memoryGB} GB</span>
        </div>
        {draft.kind === "stack" ? (
          <div className="chat-slip-row">
            <span className="chat-slip-k">Hostname prefix</span>
            <span className="chat-slip-v">{draft.hostnamePrefix || "Not set"}</span>
          </div>
        ) : (
          <div className="chat-slip-row">
            <span className="chat-slip-k">Hostname</span>
            <span className="chat-slip-v">{draft.hostname || "Not set"}</span>
          </div>
        )}
        {draft.kind === "vm" && (
          <div className="chat-slip-row">
            <span className="chat-slip-k">Environment</span>
            <span className={`chat-slip-v ${!draft.environment ? "muted" : ""}`}>
              {environmentLabel(draft.environment, catalogs)}
            </span>
          </div>
        )}
        {draft.application ? (
          <div className="chat-slip-row">
            <span className="chat-slip-k">Application</span>
            <span className="chat-slip-v">{draft.application}</span>
          </div>
        ) : null}
        {draft.additionalDiskGB > 0 && (
          <div className="chat-slip-row">
            <span className="chat-slip-k">Additional disk</span>
            <span className="chat-slip-v">{draft.additionalDiskGB} GB</span>
          </div>
        )}
        {formatLifetimeLabel(draft) ? (
          <div className="chat-slip-row">
            <span className="chat-slip-k">Lifetime</span>
            <span className="chat-slip-v">{formatLifetimeLabel(draft)}</span>
          </div>
        ) : (
          <div className="chat-slip-row">
            <span className="chat-slip-k">Lifetime</span>
            <span className="chat-slip-v muted">Not set — Modify or tap a chip</span>
          </div>
        )}
        {draft.capabilityNotes && (
          <div className="chat-slip-advice">
            <span className="chat-slip-advice-k">Catalog note</span>
            <span className="chat-slip-advice-v">{draft.capabilityNotes}</span>
          </div>
        )}
        {draft.storageNote && (
          <div className="chat-slip-advice">
            <span className="chat-slip-advice-k">Why this disk</span>
            <span className="chat-slip-advice-v">{draft.storageNote}</span>
          </div>
        )}
        <div className="chat-slip-row chat-slip-row-pkg">
          <span className="chat-slip-k">Packages</span>
          <span className="chat-slip-v">
            {packages.length > 0 ? (
              <span className="chat-slip-pkgs">
                {packages.map((pkg) => (
                  <span key={pkg} className="chat-slip-chip">{pkg}</span>
                ))}
              </span>
            ) : (
              <span className="muted">None</span>
            )}
          </span>
        </div>
        {draft.packageNotes && (
          <div className="chat-slip-advice">
            <span className="chat-slip-advice-k">Why these packages</span>
            <span className="chat-slip-advice-v">{draft.packageNotes}</span>
          </div>
        )}
      </div>

      <div className="chat-slip-cost">
        <div className="chat-slip-cost-title">Estimated monthly cost</div>
        <div className="chat-slip-cost-line">
          <span>{draft.cpu} × CPU @ {formatMoney(cost.perCpu, cur)}</span>
          <span>{formatMoney(cost.cpuCost, cur)}</span>
        </div>
        <div className="chat-slip-cost-line">
          <span>{draft.memoryGB} × GB RAM @ {formatMoney(cost.perGbRam, cur)}</span>
          <span>{formatMoney(cost.ramCost, cur)}</span>
        </div>
        {cost.hasStorage && (
          <div className="chat-slip-cost-line">
            <span>{draft.additionalDiskGB} × GB data disk @ {formatMoney(cost.perGbStorage, cur)}</span>
            <span>{formatMoney(cost.storageCost, cur)}</span>
          </div>
        )}
        <div className="chat-slip-total">
          <span>Total</span>
          <span>{formatMoney(cost.total, cur)}<span className="chat-slip-per"> /mo</span></span>
        </div>
      </div>

      {draft.kind === "vm" && !draft.environment && (
        <p className="chat-slip-note">Choose a network in chat or click Modify before approving.</p>
      )}
      {draft.kind === "vm" && draft.environment && canApprove && (
        <p className="chat-slip-note">Approve starts provisioning. Use Modify to change anything first.</p>
      )}
      {!canApprove && (
        <p className="chat-slip-note">Modify required: {issues[0]}</p>
      )}

      <div className="chat-slip-actions">
        <button className="btn btn-primary btn-sm" disabled={busy || !canApprove} onClick={() => onApprove(draft)}>
          {busy ? "Working…" : "Approve"}
        </button>
        <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => onModify(draft)}>
          Modify
        </button>
      </div>
    </div>
  );
}

export default function ChatWidget({ onJobCreated = () => {} }) {
  const { user } = useAuth();
  const firstName = (user?.displayName || user?.username || "").split(/[\s.]/)[0];
  const greeting = (() => {
    const h = new Date().getHours();
    if (h < 12) return "Good morning";
    if (h < 18) return "Good afternoon";
    return "Good evening";
  })();
  const {
    isOpen,
    mounted,
    phase,
    panelRef,
    openPanel,
    closePanel,
  } = useFloatingPanel({
    ignoreSelectors: [".chat-bubble", ".chat-welcome-pop"],
  });
  const [unreadCount, setUnreadCount] = useState(0);
  // Welcome bubble beside the icon. Shows once per page load / login — the
  // widget mounts at the app root and survives route changes, so this won't
  // re-fire as the user navigates within the app.
  const [showWelcome, setShowWelcome] = useState(true);
  const [welcomeEntered, setWelcomeEntered] = useState(false);
  const [welcomeLeaving, setWelcomeLeaving] = useState(false);
  const welcomeTimerRef = useRef(null);
  const [messages, setMessages] = useState(() => [personalizedGreeting(firstName)]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [provisioningIndex, setProvisioningIndex] = useState(null);
  const [connectTarget, setConnectTarget] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const [sessionId, setSessionId] = useState(null);
  const [sessions, setSessions] = useState([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyQuery, setHistoryQuery] = useState("");
  // { proposal, messageIndex } while the floating Modify form is open.
  const [modifyState, setModifyState] = useState(null);
  const [catalogs, setCatalogs] = useState({
    vmTemplates: [], containerTemplates: [], stacks: [], environments: [],
    packageOptions: FALLBACK_PACKAGE_OPTIONS,
    packageCategories: buildPackageCategories(),
    templateDefaults: {},
    costRates: DEFAULT_COST_RATES,
  });
  const scrollRef = useRef(null);
  const inputRef = useRef(null);
  const prevCountRef = useRef(1);
  const sessionIdRef = useRef(null);
  const location = useLocation();
  const navigate = useNavigate();

  useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);

  // Collapse the chat to its bubble when the user navigates to another page.
  useEffect(() => {
    closePanel();
    setHistoryOpen(false);
  }, [location.pathname, closePanel]);

  // Clear unread when opened
  useEffect(() => {
    if (isOpen) setUnreadCount(0);
  }, [isOpen]);

  // Load session list + catalogs on mount. Do NOT restore the last transcript
  // into the open panel — start clean; history is available via the History UI.
  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        const listed = await listChatSessions().catch(() => ({ sessions: [] }));
        if (!cancelled) setSessions(Array.isArray(listed.sessions) ? listed.sessions : []);

        const [vmTemplates, containerTemplates, stacks, environments, packageOptions, templateDefaults, costRates] = await Promise.all([
          getVmTemplates().catch(() => []),
          getContainerTemplates().catch(() => []),
          getStacks().catch(() => []),
          getEnvironments().catch(() => []),
          getPackages().catch(() => FALLBACK_PACKAGE_OPTIONS).then((data) => {
            if (!Array.isArray(data)) return FALLBACK_PACKAGE_OPTIONS;
            return data.map((p) => (typeof p === "string" ? p : p.id));
          }),
          getTemplateDefaults().catch(() => ({})),
          getCostRates().catch(() => DEFAULT_COST_RATES),
        ]);

        if (cancelled) return;
        const ids = Array.isArray(packageOptions) && packageOptions.length ? packageOptions : FALLBACK_PACKAGE_IDS;
        setCatalogs((c) => ({
          ...c, vmTemplates, containerTemplates, stacks, environments, packageOptions,
          packageCategories: buildPackageCategories(ids),
          templateDefaults: templateDefaults || {},
          costRates: costRates || DEFAULT_COST_RATES,
        }));
      } catch {
        // ignore catalog load errors
      } finally {
        if (!cancelled) setLoaded(true);
      }
    };

    load();

    return () => {
      cancelled = true;
    };
  }, []);

  // Keep a prefill login name derived from the signed-in user, used to
  // pre-populate VM proposals.
  useEffect(() => {
    setCatalogs((c) => ({ ...c, defaultUsername: defaultUsernameFrom(user) }));
  }, [user?.id]);

  // Persist the active session whenever messages change (after load), debounced.
  useEffect(() => {
    if (!loaded || !sessionId) return;
    const t = setTimeout(() => {
      saveChatSession(sessionId, { messages }).then((res) => {
        const s = res?.session;
        if (!s) return;
        setSessions((prev) => {
          const rest = prev.filter((x) => x.id !== s.id);
          return [{
            id: s.id,
            title: s.title,
            updatedAt: s.updatedAt,
            createdAt: s.createdAt,
            preview: s.preview,
            messageCount: s.messageCount,
          }, ...rest];
        });
      }).catch(() => {});
    }, 600);
    return () => clearTimeout(t);
  }, [messages, loaded, sessionId]);

  const ensureSession = async () => {
    if (sessionIdRef.current) return sessionIdRef.current;
    const res = await createChatSession();
    const id = res?.session?.id;
    if (!id) throw new Error("Could not create chat session");
    sessionIdRef.current = id;
    setSessionId(id);
    setSessions((prev) => {
      const s = res.session;
      const meta = {
        id: s.id,
        title: s.title || "New chat",
        updatedAt: s.updatedAt,
        createdAt: s.createdAt,
        preview: s.preview || "",
        messageCount: s.messageCount || 0,
      };
      return [meta, ...prev.filter((x) => x.id !== id)];
    });
    return id;
  };

  const startNewChat = async () => {
    setHistoryOpen(false);
    setModifyState(null);
    setProvisioningIndex(null);
    setMessages([personalizedGreeting(firstName)]);
    setSessionId(null);
    sessionIdRef.current = null;
  };

  const openSession = async (id) => {
    if (!id || id === sessionId) {
      setHistoryOpen(false);
      return;
    }
    try {
      const res = await getChatSession(id);
      const s = res?.session;
      if (!s) return;
      sessionIdRef.current = s.id;
      setSessionId(s.id);
      setMessages(Array.isArray(s.messages) && s.messages.length ? s.messages : [personalizedGreeting(firstName)]);
      setHistoryOpen(false);
      setModifyState(null);
    } catch {
      setMessages((m) => [...m, { role: "assistant", text: "Could not open that chat session." }]);
    }
  };

  const removeSession = async (id, e) => {
    e?.stopPropagation?.();
    try {
      await deleteChatSession(id);
      setSessions((prev) => prev.filter((s) => s.id !== id));
      if (sessionId === id) {
        sessionIdRef.current = null;
        setSessionId(null);
        setMessages([personalizedGreeting(firstName)]);
      }
    } catch {
      // ignore
    }
  };

  const clearCurrentChat = async () => {
    const id = sessionIdRef.current;
    if (id) {
      try { await deleteChatSession(id); } catch { /* ignore */ }
      setSessions((prev) => prev.filter((s) => s.id !== id));
    }
    await startNewChat();
  };

  const dismissWelcome = () => {
    clearTimeout(welcomeTimerRef.current);
    // Play the exit animation, then unmount.
    setWelcomeLeaving(true);
    welcomeTimerRef.current = setTimeout(() => setShowWelcome(false), 240);
  };

  const startWelcomeTimer = () => {
    clearTimeout(welcomeTimerRef.current);
    welcomeTimerRef.current = setTimeout(dismissWelcome, 9000);
  };
  const pauseWelcomeTimer = () => clearTimeout(welcomeTimerRef.current);

  // Let the bubble slide in a beat after login (feels intentional, not jarring
  // mid route-transition), then auto-dismiss after a few idle seconds.
  useEffect(() => {
    if (!showWelcome || isOpen || welcomeLeaving) return undefined;
    if (!welcomeEntered) {
      const enter = setTimeout(() => setWelcomeEntered(true), 650);
      return () => clearTimeout(enter);
    }
    startWelcomeTimer();
    return () => clearTimeout(welcomeTimerRef.current);
  }, [showWelcome, isOpen, welcomeEntered, welcomeLeaving]);

  // Announce the outcome of a provision call as an assistant message and wire
  // up job polling / approval routing.
  const announceProvisionResult = (result) => {
    if (result?.job?.id) {
      setMessages((m) => [...m, { role: "assistant", text: `Provisioning started from your proposal. Tracking as job ${result.job.id}.` }]);
      onJobCreated?.(result.job.id);
      pollJobInChat(result.job.id);
    } else if (result?.request?.id) {
      setMessages((m) => [...m, { role: "assistant", text: `Request ${result.request.id} exceeds the size policy — it's awaiting approval on Deployments.` }]);
      window.dispatchEvent(new CustomEvent("forge:open-deployment-monitor", { detail: { requestId: result.request.id } }));
    }
  };

  // Provision directly from a fully-resolved proposal (used by Approve on
  // containers/stacks and by the Modify form's submit).
  const provisionFromProposal = async (proposal, messageIndex) => {
    if (!proposal) return;
    const issues = proposalIssues(proposal, catalogs);
    if (issues.length) {
      setMessages((m) => [...m, { role: "assistant", text: `This proposal still needs a few details before I can build it: ${issues[0]}` }]);
      return;
    }
    setProvisioningIndex(messageIndex);
    try {
      const vmTpl = catalogs.vmTemplates.find((t) => t.id === proposal.templateId);
      const isInternal = proposal.kind === "vm" && vmTpl?.provider === "internal";
      let result;
      if (isInternal) {
        result = await provisionInternal({
          templateId: proposal.templateId,
          hostname: proposal.hostname,
          application: proposal.application,
          cpu: proposal.cpu,
          memoryGB: proposal.memoryGB,
          additionalDiskGB: proposal.additionalDiskGB,
          ttlDays: proposal.ttlDays,
          permanent: proposal.permanent,
        });
      } else if (proposal.kind === "stack") {
        result = await provisionStack({
          stackId: proposal.stackId,
          hostnamePrefix: proposal.hostnamePrefix,
          application: proposal.application,
          cpu: proposal.cpu,
          memoryGB: proposal.memoryGB,
          additionalDiskGB: proposal.additionalDiskGB,
          ttlDays: proposal.ttlDays,
          permanent: proposal.permanent,
          packages: proposal.packages,
          packageSelection: proposal.packageSelection,
        });
      } else if (proposal.kind === "container") {
        result = await provisionContainer({
          templateId: proposal.templateId,
          hostname: proposal.hostname,
          application: proposal.application,
          cpu: proposal.cpu,
          memoryGB: proposal.memoryGB,
          ttlDays: proposal.ttlDays,
          permanent: proposal.permanent,
          packages: proposal.packages,
          packageSelection: proposal.packageSelection,
        });
      } else {
        result = await provisionVm({
          templateId: proposal.templateId,
          hostname: proposal.hostname,
          application: proposal.application,
          cpu: proposal.cpu,
          memoryGB: proposal.memoryGB,
          additionalDiskGB: proposal.additionalDiskGB,
          ttlDays: proposal.ttlDays,
          permanent: proposal.permanent,
          packages: proposal.packages,
          packageSelection: proposal.packageSelection,
          environment: proposal.environment,
          username: proposal.username,
          sudoAccess: proposal.sudoAccess,
        });
      }
      announceProvisionResult(result);
    } catch (err) {
      const errText = err.response?.data?.error || err.message;
      setMessages((m) => [...m, { role: "assistant", text: `Error: ${errText}` }]);
    } finally {
      setProvisioningIndex(null);
    }
  };

  // Build the { kind, item } shape the shared ProvisionForm expects from a
  // chat proposal, resolving the real catalog entry so description/provider/
  // workflow steps are available.
  const selectedFromProposal = (proposal) => {
    if (proposal.kind === "stack") {
      const item = catalogs.stacks.find((s) => s.id === proposal.stackId)
        || { id: proposal.stackId, name: proposal.stackName, description: proposal.description };
      return { kind: "stack", item };
    }
    if (proposal.kind === "container") {
      const item = catalogs.containerTemplates.find((t) => t.id === proposal.templateId)
        || { id: proposal.templateId, name: proposal.templateName, description: proposal.description };
      return { kind: "container", item };
    }
    const item = catalogs.vmTemplates.find((t) => t.id === proposal.templateId)
      || { id: proposal.templateId, name: proposal.templateName, description: proposal.description };
    return { kind: "vm", item };
  };

  const initialValuesFromProposal = (proposal) => ({
    hostname: proposal.kind === "stack" ? (proposal.hostnamePrefix || "") : (proposal.hostname || ""),
    application: proposal.application || "",
    cpu: proposal.cpu,
    memoryGB: proposal.memoryGB,
    additionalDiskGB: proposal.additionalDiskGB || 0,
    username: proposal.username || catalogs.defaultUsername || "",
    environment: proposal.environment || "",
    sudoAccess: proposal.sudoAccess ?? false,
    ...ttlFieldsFromProposal(proposal),
  });

  // Approve starts provisioning when the proposal is complete. Only open Modify
  // when something required is still missing (network, username, etc.).
  const approveProposal = (proposal, messageIndex) => {
    const ready = {
      ...proposal,
      username: proposal.username || catalogs.defaultUsername || "",
      environment: proposal.environment || "",
    };
    const issues = proposalIssues(ready, catalogs);
    if (issues.length) {
      setModifyState({ proposal: ready, messageIndex });
      return;
    }
    provisionFromProposal(ready, messageIndex);
  };

  // The Modify form (shared ProvisionForm) submitted — merge its values back
  // onto the proposal identity and provision.
  const submitModify = async (form) => {
    if (!modifyState) return;
    const { proposal, messageIndex } = modifyState;
    const merged = {
      ...proposal,
      hostname: proposal.kind === "stack" ? proposal.hostname : form.hostname,
      hostnamePrefix: proposal.kind === "stack" ? form.hostname : proposal.hostnamePrefix,
      application: form.application,
      cpu: form.cpu,
      memoryGB: form.memoryGB,
      additionalDiskGB: form.additionalDiskGB,
      size: form.size,
      ttlDays: form.ttlDays,
      permanent: form.permanent,
      packages: form.packages,
      packageSelection: form.packageSelection,
      environment: form.environment,
      username: form.username,
      sudoAccess: form.sudoAccess,
    };
    setModifyState(null);
    await provisionFromProposal(merged, messageIndex);
  };

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, isOpen]);

  useEffect(() => {
    const prev = prevCountRef.current;
    if (messages.length > prev) {
      const newest = messages[messages.length - 1];
      if (newest?.role === "assistant" && !isOpen) {
        setUnreadCount((n) => n + 1);
      }
    }
    prevCountRef.current = messages.length;
  }, [messages, isOpen]);

  const pollJobInChat = (jobId) => {
    let lastStatus = null;
    let cancelled = false;

    const poll = async () => {
      if (cancelled) return;
      try {
        const job = await getJob(jobId);

        if (job.status !== lastStatus) {
          lastStatus = job.status;
          const msg = { role: "assistant", text: statusToChatLine(job) };
          // When ready, attach Connect targets + post-build follow-up chips.
          if (job.status === "ready") {
            const withIp = (job.resources || []).filter((r) => r.ip);
            msg.resources = withIp.length ? withIp : (job.resources || []);
            msg.suggestedReplies = [...POST_BUILD_CHIPS];
          }
          if (job.status === "failed") {
            msg.jobList = [{
              id: job.id,
              name: job.payload?.hostname || job.payload?.name || job.id,
              kind: job.kind || job.payload?.kind || "job",
              status: job.status,
              error: job.error || job.message || "",
            }];
            msg.suggestedReplies = ["Show failed deployments", "Show my resources"];
          }
          setMessages((m) => [...m, msg]);
        }

        if (job.status === "ready" || job.status === "failed") {
          return; // stop polling
        }
      } catch (e) {
        // transient — keep trying
      }
      setTimeout(poll, 2500);
    };

    poll();
    return () => {
      cancelled = true;
    };
  };

  const statusToChatLine = (job) => {
    if (job.status === "failed") {
      return `Job ${job.id} failed: ${job.error || job.message}`;
    }
    if (job.status === "ready") {
      const lines = job.resources.map(
        (r) => `  - ${r.hostname} (VMID ${r.vmid}${r.role ? `, ${r.role}` : ""})${r.ip ? ` — IP ${r.ip}` : ""}`
      );
      return `Job ${job.id} is ready:\n${lines.join("\n")}`;
    }
    return `Job ${job.id}: ${job.message}`;
  };

  const send = async (overrideText, opts = {}) => {
    const text = (typeof overrideText === "string" ? overrideText : input).trim();
    if (!text || sending) return;

    const replaceFrom = Number.isInteger(opts.replaceFromUser) ? opts.replaceFromUser : null;
    const base = replaceFrom != null ? messages.slice(0, replaceFrom) : messages;
    const nextMessages = [...base, { role: "user", text }];
    setMessages(nextMessages);
    setInput("");
    setSending(true);

    // Offline intents first — no AI required (list / reboot / expiry / failed jobs).
    const offlineIntent = matchOfflineIntent(text);
    if (offlineIntent && offlineIntent.type !== "extend_ready") {
      setMessages((m) => [...m, { role: "assistant", text: "Working…", streaming: true, statusOnly: true }]);
      try {
        const reply = await runOfflineIntent(offlineIntent);
        setMessages((m) => {
          const copy = [...m];
          const last = copy[copy.length - 1];
          if (last?.streaming) copy[copy.length - 1] = reply || { role: "assistant", text: "Done.", offline: true };
          else copy.push(reply || { role: "assistant", text: "Done.", offline: true });
          return copy;
        });
      } catch (err) {
        const errText = err.response?.data?.error || err.message;
        setMessages((m) => {
          const copy = [...m];
          const last = copy[copy.length - 1];
          const errMsg = {
            role: "assistant",
            text: `Couldn't complete that: ${errText}`,
            isError: true,
            suggestedReplies: QUICK_ACTIONS.map((a) => a.text),
          };
          if (last?.streaming) copy[copy.length - 1] = errMsg;
          else copy.push(errMsg);
          return copy;
        });
      } finally {
        setSending(false);
      }
      return;
    }

    // Placeholder assistant bubble for status / progressive text.
    setMessages((m) => [...m, { role: "assistant", text: "", streaming: true }]);

    try {
      await ensureSession();

      const history = nextMessages
        .filter((m) => m.role === "user" || m.role === "assistant")
        .map((m) => ({ role: m.role, text: m.text }));

      // The most recent proposal, so a follow-up ("make it 16 GB") refines it.
      const lastProposal = [...base].reverse().find((m) => m.proposal)?.proposal || null;
      // Only continue guided clarify when the latest assistant turn left an active draft.
      const lastAssist = [...base].reverse().find((m) => m.role === "assistant" && !m.statusOnly);
      const activeGuided = lastAssist?.guidedDraft?.active ? lastAssist.guidedDraft : null;

      let streamed = "";
      const res = await streamChatMessage(
        { message: text, history, lastProposal, guidedDraft: activeGuided },
        {
          onStatus: (data) => {
            const statusText = data?.text || "Thinking…";
            setMessages((m) => {
              const copy = [...m];
              const last = copy[copy.length - 1];
              if (last?.streaming) {
                copy[copy.length - 1] = { ...last, text: statusText, statusOnly: true };
              }
              return copy;
            });
          },
          onDelta: (data) => {
            streamed += data?.text || "";
            const snap = streamed;
            setMessages((m) => {
              const copy = [...m];
              const last = copy[copy.length - 1];
              if (last?.streaming) {
                copy[copy.length - 1] = { ...last, text: snap, statusOnly: false };
              }
              return copy;
            });
          },
        }
      );

      setMessages((m) => {
        const copy = [...m];
        const last = copy[copy.length - 1];
        const finalMsg = {
          role: "assistant",
          text: res.reply || streamed || "",
          proposal: res.proposal ? ensureProposalShape(res.proposal, catalogs) : null,
          resourceList: res.resourceList || null,
          suggestedReplies: Array.isArray(res.suggestedReplies) ? res.suggestedReplies : [],
          guidedDraft: res.guidedDraft || null,
        };
        if (last?.streaming) copy[copy.length - 1] = finalMsg;
        else copy.push(finalMsg);
        return copy;
      });

      if (res.job) {
        onJobCreated?.(res.job.id);
        pollJobInChat(res.job.id);
      }
    } catch (err) {
      const errText = err.response?.data?.error || err.message;
      setMessages((m) => {
        const copy = [...m];
        const last = copy[copy.length - 1];
        const errMsg = {
          role: "assistant",
          text: `Error: ${errText}\n\nYou can still use quick actions below — they work without AI.`,
          isError: true,
          suggestedReplies: QUICK_ACTIONS.map((a) => a.text),
        };
        if (last?.streaming) copy[copy.length - 1] = errMsg;
        else copy.push(errMsg);
        return copy;
      });
    } finally {
      setSending(false);
    }
  };

  const regenerateLastReply = () => {
    if (sending) return;
    let userIdx = -1;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (messages[i].role === "user" && String(messages[i].text || "").trim()) {
        userIdx = i;
        break;
      }
    }
    if (userIdx < 0) return;
    send(messages[userIdx].text, { replaceFromUser: userIdx });
  };

  const exportSessionMarkdown = () => {
    const title = sessions.find((s) => s.id === sessionId)?.title || "Forge Assist chat";
    const lines = [
      `# ${title}`,
      "",
      `_Exported ${new Date().toISOString()}_`,
      "",
    ];
    for (const m of messages) {
      if (m.streaming || m.statusOnly) continue;
      const who = m.role === "user" ? "You" : "Forge Assist";
      lines.push(`## ${who}`, "", String(m.text || "").trim() || "_(empty)_", "");
      if (m.proposal) {
        const p = m.proposal;
        const name = p.kind === "stack" ? p.stackName : p.templateName;
        lines.push("### Proposed plan", "");
        lines.push(`- **Kind:** ${p.kind || "vm"}`);
        lines.push(`- **Name:** ${name || "—"}`);
        lines.push(`- **CPU / RAM:** ${p.cpu} / ${p.memoryGB} GB`);
        if (p.additionalDiskGB) lines.push(`- **Extra disk:** ${p.additionalDiskGB} GB`);
        if (p.environment) lines.push(`- **Network:** ${p.environment}`);
        if (formatLifetimeLabel(p)) lines.push(`- **Lifetime:** ${formatLifetimeLabel(p)}`);
        if (p.packages?.length) lines.push(`- **Packages:** ${p.packages.join(", ")}`);
        if (p.cost?.total != null) {
          lines.push(`- **Est. cost:** ${formatMoney(p.cost.total, p.cost.currency)}/mo`);
        }
        if (p.rationale) lines.push("", p.rationale, "");
        lines.push("");
      }
      if (m.resources?.length) {
        lines.push("### Resources", "");
        for (const r of m.resources) {
          lines.push(`- ${r.hostname || "host"} (VMID ${r.vmid})${r.ip ? ` — ${r.ip}` : ""}`);
        }
        lines.push("");
      }
    }
    const blob = new Blob([lines.join("\n")], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${String(title).replace(/[^\w\-]+/g, "_").slice(0, 48) || "forge-chat"}.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const applyTtlChipToLatestProposal = (chip) => {
    const patch = TTL_CHIP_VALUES[chip];
    if (!patch) return false;
    let applied = false;
    setMessages((m) => {
      const copy = [...m];
      for (let i = copy.length - 1; i >= 0; i -= 1) {
        if (copy[i].proposal) {
          copy[i] = {
            ...copy[i],
            proposal: { ...copy[i].proposal, ...patch },
            suggestedReplies: (copy[i].suggestedReplies || []).filter((c) => !TTL_CHIP_VALUES[c]),
          };
          applied = true;
          break;
        }
      }
      if (applied) {
        copy.push({
          role: "assistant",
          text: patch.permanent
            ? "Updated the plan to run permanently (no auto-decommission)."
            : `Updated the plan lifetime to ${formatLifetimeLabel(patch)}.`,
        });
      }
      return copy;
    });
    return applied;
  };

  const extendReadyResources = async () => {
    const lastWithResources = [...messages].reverse().find((m) => m.resources?.length);
    const resources = lastWithResources?.resources || [];
    if (!resources.length) {
      setMessages((m) => [
        ...m,
        { role: "user", text: "Extend lifetime by 7 days" },
        { role: "assistant", text: "I couldn't find a ready resource in this chat to extend. Open Deployments or ask me to list your resources." },
      ]);
      return;
    }
    setMessages((m) => [...m, { role: "user", text: "Extend lifetime by 7 days" }]);
    setSending(true);
    try {
      const results = await Promise.allSettled(
        resources.map((r) => extendResource(r.type || "vm", r.vmid, 7))
      );
      const ok = results.filter((r) => r.status === "fulfilled").length;
      const failed = results.length - ok;
      setMessages((m) => [
        ...m,
        {
          role: "assistant",
          text: failed
            ? `Extended lifetime by 7 days for ${ok} resource(s); ${failed} failed. Check Deployments if something looks wrong.`
            : `Extended lifetime by 7 days for ${ok} resource(s).`,
        },
      ]);
    } catch (err) {
      setMessages((m) => [
        ...m,
        { role: "assistant", text: `Could not extend lifetime: ${err.message}` },
      ]);
    } finally {
      setSending(false);
    }
  };

  const sendSuggested = (chip) => {
    if (!chip || sending) return;
    if (TTL_CHIP_VALUES[chip] && applyTtlChipToLatestProposal(chip)) return;
    if (chip === "Extend lifetime by 7 days") {
      extendReadyResources();
      return;
    }
    send(chip);
  };

  const runQuickAction = (action) => {
    if (!action || sending) return;
    send(action.text);
  };

  const renewFromChat = async (item) => {
    if (!item || sending) return;
    setMessages((m) => [...m, { role: "user", text: `Renew ${item.name || item.vmid}` }]);
    setSending(true);
    try {
      await renewExpiringItem(item, 7);
      setMessages((m) => [
        ...m,
        { role: "assistant", text: `Extended **${item.name || `VMID ${item.vmid}`}** by 7 days.`, offline: true },
      ]);
    } catch (err) {
      setMessages((m) => [
        ...m,
        {
          role: "assistant",
          text: `Could not renew: ${err.response?.data?.error || err.message}`,
          isError: true,
        },
      ]);
    } finally {
      setSending(false);
    }
  };

  const rebootFromChat = async (r) => {
    if (!r || sending) return;
    setMessages((m) => [...m, { role: "user", text: `Reboot ${r.name || r.vmid}` }]);
    setSending(true);
    try {
      await resourceAction(r.type || "vm", r.vmid, "reboot");
      setMessages((m) => [
        ...m,
        { role: "assistant", text: `Reboot started for **${r.name || `VMID ${r.vmid}`}**.`, offline: true },
      ]);
    } catch (err) {
      setMessages((m) => [
        ...m,
        {
          role: "assistant",
          text: `Reboot failed: ${err.response?.data?.error || err.message}`,
          isError: true,
        },
      ]);
    } finally {
      setSending(false);
    }
  };

  const retryFromChat = async (job) => {
    if (!job?.id || sending) return;
    setMessages((m) => [...m, { role: "user", text: `Retry ${job.id}` }]);
    setSending(true);
    try {
      const res = await retryFailedJob(job.id);
      const newId = res?.job?.id || res?.id;
      setMessages((m) => [
        ...m,
        {
          role: "assistant",
          text: newId
            ? `Retry started — tracking job **${newId}**.`
            : `Retry submitted for **${job.id}**.`,
          offline: true,
        },
      ]);
      if (newId) pollJobInChat(newId);
    } catch (err) {
      setMessages((m) => [
        ...m,
        {
          role: "assistant",
          text: `Retry failed: ${err.response?.data?.error || err.message}`,
          isError: true,
        },
      ]);
    } finally {
      setSending(false);
    }
  };

  const openJobLog = (jobId) => {
    if (!jobId) return;
    closePanel();
    navigate(`/deployments?tab=failed&job=${encodeURIComponent(jobId)}`);
  };

  const handleKeyDown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  // Support page / dashboards can open Copilot with an optional prompt.
  useEffect(() => {
    const onOpen = (e) => {
      dismissWelcome();
      openPanel();
      const prompt = e?.detail?.prompt;
      if (prompt) {
        setInput(String(prompt));
        requestAnimationFrame(() => inputRef.current?.focus());
      }
    };
    window.addEventListener("forge:open-chat", onOpen);
    return () => window.removeEventListener("forge:open-chat", onOpen);
  }, [openPanel]);

  // Ctrl/Cmd+N = new chat; Esc closes History panel.
  useEffect(() => {
    if (!isOpen) return undefined;
    const onKey = (e) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "n" && !e.altKey) {
        e.preventDefault();
        startNewChat();
        return;
      }
      if (e.key === "Escape" && historyOpen) {
        e.preventDefault();
        setHistoryOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isOpen, historyOpen]);

  const openChat = () => {
    dismissWelcome();
    openPanel();
  };

  const lastAssistantIdx = (() => {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (messages[i].role === "assistant" && !messages[i].streaming) return i;
    }
    return -1;
  })();
  const canRegenerate = !sending && lastAssistantIdx > 0 && messages.some((m) => m.role === "user");

  return (
    <>
      {!mounted && showWelcome && welcomeEntered && (
        <div
          className={`chat-welcome-pop${welcomeLeaving ? " chat-welcome-pop-leaving" : ""}`}
          role="status"
          onMouseEnter={pauseWelcomeTimer}
          onMouseLeave={startWelcomeTimer}
        >
          <button
            className="chat-welcome-close"
            onClick={dismissWelcome}
            aria-label="Dismiss welcome message"
          >
            ×
          </button>
          <div className="chat-welcome-title">{greeting}, {firstName || "there"}</div>
          <div className="chat-welcome-text">
            Hi — how may I help you today? I'm Forge Assist. Ask me to provision a VM,
            container, or stack — I'll ask a couple of questions if needed, then recommend a plan to Approve or Modify.
          </div>
          <button className="chat-welcome-cta" onClick={openChat}>
            Start chatting
          </button>
        </div>
      )}

      {!mounted && (
        <button
          className="chat-bubble"
          onClick={openChat}
          aria-label="Open Forge Assist"
          title="Forge Assist"
        >
          <span className="chat-bubble-pulse" aria-hidden="true" />
          <svg
            className="chat-bubble-icon" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
            aria-hidden="true"
          >
            <circle cx="12" cy="3.4" r="1.2" />
            <path d="M12 4.6v3" />
            <rect x="4.5" y="7.6" width="15" height="11.4" rx="3" />
            <path d="M2.4 12.2v3M21.6 12.2v3" />
            <circle cx="9.2" cy="13" r="1.15" fill="currentColor" stroke="none" />
            <circle cx="14.8" cy="13" r="1.15" fill="currentColor" stroke="none" />
            <path d="M9.5 16.4h5" />
          </svg>
          <span className="chat-bubble-live" aria-hidden="true" title="Assistant online" />
          {unreadCount > 0 && <span className="chat-unread-badge">{unreadCount > 9 ? "9+" : unreadCount}</span>}
        </button>
      )}

      {mounted && (
        <div
          ref={panelRef}
          className={`chat-panel ${phase === "leaving" ? "chat-panel-leave" : "chat-panel-enter"}`}
        >
          <div className="chat-panel-header">
            <div className="chat-panel-title">
              <span>Forge Assist</span>
              <span className="chat-panel-session-label">
                {sessions.find((s) => s.id === sessionId)?.title || "New chat"}
              </span>
            </div>
            <div className="chat-panel-actions">
              <button className="chat-clear-btn" onClick={startNewChat} title="New chat (Ctrl/Cmd+N)">New</button>
              <button
                className={`chat-clear-btn ${historyOpen ? "is-active" : ""}`}
                onClick={() => setHistoryOpen((v) => !v)}
                title="Chat history (Esc to close)"
              >
                History
              </button>
              <button
                className="chat-clear-btn"
                onClick={exportSessionMarkdown}
                title="Export this chat as Markdown"
                disabled={!messages.some((m) => m.role === "user")}
              >
                Export
              </button>
              <button className="chat-clear-btn" onClick={clearCurrentChat} title="Delete this chat and start fresh">Clear</button>
              <button
                className="chat-toggle-btn"
                onClick={closePanel}
                title="Minimize to bubble"
                aria-label="Minimize chat to bubble"
              >
                −
              </button>
            </div>
          </div>

          {historyOpen && (
            <div className="chat-history-panel">
              <div className="chat-history-head">
                <span>Recent chats</span>
                <button className="chat-clear-btn" onClick={startNewChat}>New chat</button>
              </div>
              {sessions.length > 0 && (
                <input
                  type="search"
                  className="chat-history-search"
                  placeholder="Search title or preview…"
                  value={historyQuery}
                  onChange={(e) => setHistoryQuery(e.target.value)}
                  aria-label="Search chat history"
                />
              )}
              {sessions.length === 0 ? (
                <div className="chat-history-empty-cta">
                  <p className="chat-history-empty-title">No chats yet</p>
                  <p className="chat-history-empty">
                    Ask Forge Assist to plan a VM, container, or stack. Finished chats appear here so you can reopen or search them later.
                  </p>
                  <button type="button" className="btn btn-primary btn-sm" onClick={startNewChat}>
                    Start a new chat
                  </button>
                </div>
              ) : (
                (() => {
                  const q = historyQuery.trim().toLowerCase();
                  const filtered = q
                    ? sessions.filter((s) => {
                        const hay = `${s.title || ""} ${s.preview || ""}`.toLowerCase();
                        return hay.includes(q);
                      })
                    : sessions;
                  if (!filtered.length) {
                    return <p className="chat-history-empty">No chats match “{historyQuery.trim()}”.</p>;
                  }
                  return (
                    <ul className="chat-history-list">
                      {filtered.map((s) => (
                        <li key={s.id}>
                          <button
                            type="button"
                            className={`chat-history-item ${s.id === sessionId ? "is-active" : ""}`}
                            onClick={() => openSession(s.id)}
                          >
                            <span className="chat-history-item-title">{s.title || "New chat"}</span>
                            <span className="chat-history-item-meta">
                              {formatSessionWhen(s.updatedAt)}
                              {s.preview ? ` · ${s.preview}` : ""}
                            </span>
                          </button>
                          <button
                            type="button"
                            className="chat-history-delete"
                            title="Delete chat"
                            aria-label="Delete chat"
                            onClick={(e) => removeSession(s.id, e)}
                          >
                            ×
                          </button>
                        </li>
                      ))}
                    </ul>
                  );
                })()
              )}
            </div>
          )}

          <div className="chat-panel-body" ref={scrollRef}>
            {messages.map((m, i) => (
              <div key={i} className={`chat-msg chat-msg-${m.role}${m.isError ? " chat-msg-error" : ""}`}>
                {m.role === "assistant" && !m.statusOnly ? (
                  <ChatMarkdown text={m.text} />
                ) : (
                  <div className={m.statusOnly ? "chat-msg-status" : undefined}>{m.text}</div>
                )}
                {m.proposal && (
                  <ProposalCard
                    proposal={m.proposal}
                    catalogs={catalogs}
                    busy={provisioningIndex === i}
                    onApprove={(proposal) => approveProposal(proposal, i)}
                    onModify={(proposal) => setModifyState({ proposal, messageIndex: i })}
                  />
                )}
                {m.resourceList?.length > 0 && (
                  <div className="chat-resource-list">
                    {m.resourceList.map((r) => {
                      const running = (r.status || "").toLowerCase() === "running";
                      return (
                        <div key={r.vmid} className="chat-resource-row">
                          <span className={`chat-resource-dot${running ? " is-running" : ""}`} aria-hidden="true" />
                          <span className="chat-resource-name" title={r.name || ""}>{r.name || "(no name)"}</span>
                          <span className={`chat-resource-type chat-resource-type-${r.type}`}>{r.type === "container" ? "CT" : "VM"}</span>
                          <span className="chat-resource-id">#{r.vmid}</span>
                          <span className={`chat-resource-status${running ? " is-running" : ""}`}>{r.status || "unknown"}</span>
                          {m.listActions && running && (
                            <button
                              type="button"
                              className="btn btn-ghost btn-sm chat-resource-act"
                              disabled={sending}
                              onClick={() => rebootFromChat(r)}
                            >
                              Reboot
                            </button>
                          )}
                          {m.listActions && (r.expiresAt || r.expired) && (
                            <button
                              type="button"
                              className="btn btn-ghost btn-sm chat-resource-act"
                              disabled={sending}
                              onClick={() => renewFromChat(r)}
                            >
                              Renew
                            </button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
                {m.expiringList?.length > 0 && (
                  <div className="chat-assist-list" role="list">
                    {m.expiringList.map((r) => (
                      <div key={`${r.type}-${r.vmid}`} className="chat-assist-row" role="listitem">
                        <div className="chat-assist-main">
                          <strong className="mono">{r.name || `VMID ${r.vmid}`}</strong>
                          <span className="muted">
                            {r.expired ? "Expired" : `${r.daysLeft}d left`}
                            {r.expiresAt ? ` · ${new Date(r.expiresAt).toLocaleDateString()}` : ""}
                          </span>
                        </div>
                        <button
                          type="button"
                          className="btn btn-primary btn-sm"
                          disabled={sending}
                          onClick={() => renewFromChat(r)}
                        >
                          Renew +7d
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                {m.jobList?.length > 0 && (
                  <div className="chat-assist-list" role="list">
                    {m.jobList.map((j) => (
                      <div key={j.id} className="chat-assist-row" role="listitem">
                        <div className="chat-assist-main">
                          <strong className="mono">{j.name || j.id}</strong>
                          <span className="muted">
                            {j.kind} · {j.id}
                            {j.error ? ` — ${String(j.error).slice(0, 80)}` : ""}
                          </span>
                        </div>
                        <div className="chat-assist-acts">
                          <button
                            type="button"
                            className="btn btn-ghost btn-sm"
                            disabled={sending}
                            onClick={() => openJobLog(j.id)}
                          >
                            Open log
                          </button>
                          <button
                            type="button"
                            className="btn btn-primary btn-sm"
                            disabled={sending}
                            onClick={() => retryFromChat(j)}
                          >
                            Retry
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                {m.resources?.length > 0 && (
                  <div className="chat-connect-row">
                    {m.resources.map((r) => (
                      <button
                        key={r.vmid}
                        className="btn btn-primary btn-sm"
                        onClick={() => setConnectTarget({ vmid: r.vmid, ip: r.ip, hostname: r.hostname })}
                      >
                        Connect to {r.hostname}
                      </button>
                    ))}
                  </div>
                )}
                {i === messages.length - 1 && !sending && m.suggestedReplies?.length > 0 && (
                  <div className="chat-suggest-row" role="group" aria-label="Suggested replies">
                    {m.suggestedReplies.map((chip) => (
                      <button
                        key={chip}
                        type="button"
                        className="chat-suggest-chip"
                        onClick={() => sendSuggested(chip)}
                      >
                        {chip}
                      </button>
                    ))}
                  </div>
                )}
                {i === lastAssistantIdx && canRegenerate && !m.offline && (
                  <div className="chat-msg-actions">
                    <button
                      type="button"
                      className="chat-regen-btn"
                      onClick={regenerateLastReply}
                      title="Regenerate this reply from your last message"
                    >
                      Regenerate
                    </button>
                  </div>
                )}
              </div>
            ))}
            {sending && !messages.some((m) => m.streaming) && (
              <div className="chat-msg chat-msg-assistant chat-msg-pending">Thinking...</div>
            )}

            {messages.length <= 2 && !sending && (
              <div className="chat-quick-prompts">
                {QUICK_PROMPTS.map((prompt) => (
                  <button
                    key={prompt}
                    className="chat-quick-btn"
                    onClick={() => {
                      setInput(prompt);
                      inputRef.current?.focus();
                    }}
                  >
                    {prompt}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="chat-quick-actions" role="toolbar" aria-label="Quick actions">
            {QUICK_ACTIONS.map((action) => (
              <button
                key={action.id}
                type="button"
                className="chat-quick-action"
                disabled={sending}
                title={action.text}
                onClick={() => runQuickAction(action)}
              >
                {action.label}
              </button>
            ))}
          </div>

          <div className="chat-panel-input">
            <textarea
              ref={inputRef}
              rows={2}
              placeholder="Try: show my resources · what's expiring · reboot lab05"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
            />
            <button className="btn btn-primary btn-sm" onClick={() => send()} disabled={sending || !input.trim()}>
              Send
            </button>
          </div>
        </div>
      )}

      {modifyState && (
        <div className="provision-modal-backdrop">
          <div className="provision-modal-shell">
            <ProvisionForm
              selected={selectedFromProposal(modifyState.proposal)}
              environments={environmentOptions(catalogs)}
              templateDefaults={catalogs.templateDefaults}
              costRates={catalogs.costRates}
              packageCategories={catalogs.packageCategories}
              lockedPackageIds={[]}
              initialValues={initialValuesFromProposal(modifyState.proposal)}
              initialPackages={modifyState.proposal.packages || []}
              busy={provisioningIndex === modifyState.messageIndex}
              onSubmit={submitModify}
              onClose={() => setModifyState(null)}
            />
          </div>
        </div>
      )}

      {connectTarget && (
        <TerminalModal
          vmid={connectTarget.vmid}
          ip={connectTarget.ip}
          hostname={connectTarget.hostname}
          onClose={() => setConnectTarget(null)}
        />
      )}
    </>
  );
}
