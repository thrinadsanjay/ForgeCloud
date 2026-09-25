import { Link } from "react-router-dom";
import { useAuth } from "../context/AuthContext.jsx";
import { firstName } from "./dash/shared.jsx";
import "./dash/fdash.css";

function openChat(prompt) {
  window.dispatchEvent(new CustomEvent("forge:open-chat", { detail: { prompt } }));
}

export default function Support() {
  const { user } = useAuth();

  return (
    <div className="fdash fdash-support page">
      <header className="fdash-hero fdash-hero-user">
        <div>
          <p className="fdash-eyebrow">Support</p>
          <h1>How can we help, {firstName(user)}?</h1>
          <p className="fdash-sub">
            Get answers from Forge Copilot, open a ticket with your platform team, or jump to common tasks.
          </p>
        </div>
      </header>

      <div className="fdash-row fdash-row-3">
        <article className="fdash-card fdash-support-card">
          <span className="fdash-kpi-icon" style={{ color: "var(--brand)", background: "var(--brand-tint)" }}>🤖</span>
          <h2>AI Copilot</h2>
          <p className="muted">Ask about provisioning, sizing, failures, or how to manage your VMs.</p>
          <button type="button" className="btn btn-primary" onClick={() => openChat("I need help with Forge")}>
            Start chat
          </button>
        </article>
        <article className="fdash-card fdash-support-card">
          <span className="fdash-kpi-icon" style={{ color: "#3b82f6", background: "color-mix(in srgb, #3b82f6 14%, transparent)" }}>🎫</span>
          <h2>Create a ticket</h2>
          <p className="muted">Describe an incident or request — we&apos;ll draft it with Copilot for your ops team.</p>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => openChat("Please help me create a support ticket for: ")}
          >
            Draft ticket
          </button>
        </article>
        <article className="fdash-card fdash-support-card">
          <span className="fdash-kpi-icon" style={{ color: "#16a34a", background: "var(--ok-tint)" }}>📚</span>
          <h2>Self-service</h2>
          <p className="muted">Provision a VM, check deployments, or manage resources without waiting.</p>
          <div className="fdash-support-links">
            <Link to="/provision">Provision →</Link>
            <Link to="/deployments">Deployments →</Link>
            <Link to="/resources">My resources →</Link>
          </div>
        </article>
      </div>
    </div>
  );
}
