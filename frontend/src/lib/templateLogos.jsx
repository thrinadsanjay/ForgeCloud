/**
 * Official-brand template marks for the provision catalog.
 * resolveTemplateLogo() matches by name/id so future templates pick up logos automatically.
 */

function SvgShell({ children, viewBox = "0 0 64 64", ...props }) {
  return (
    <svg viewBox={viewBox} width="100%" height="100%" aria-hidden="true" {...props}>
      {children}
    </svg>
  );
}

export function LogoRedHat() {
  return (
    <SvgShell viewBox="0 0 64 64">
      <circle cx="32" cy="32" r="30" fill="#EE0000" />
      <path
        fill="#fff"
        d="M18 38c2.5-8 8-14 16.5-16.5 1.2-.4 2.4.5 2.2 1.8-.6 3.2-1 5.6-.6 7.4 4.8-1.2 8.8.2 11.2 3.6 1.6 2.2 1.2 5.2-.8 6.8-3.2 2.6-9.2 3.4-15.6 2.2-6.8-1.2-12-4.2-13-5.3z"
      />
      <ellipse cx="34" cy="28" rx="6.5" ry="4.2" fill="#EE0000" opacity="0.35" />
    </SvgShell>
  );
}

export function LogoUbuntu() {
  return (
    <SvgShell viewBox="0 0 64 64">
      <circle cx="32" cy="32" r="30" fill="#E95420" />
      <circle cx="32" cy="32" r="10" fill="none" stroke="#fff" strokeWidth="5" />
      <circle cx="32" cy="14" r="5" fill="#fff" />
      <circle cx="16.5" cy="41" r="5" fill="#fff" />
      <circle cx="47.5" cy="41" r="5" fill="#fff" />
      <path d="M32 19v6M21 38.5l5.2-3M43 38.5l-5.2-3" stroke="#E95420" strokeWidth="3" strokeLinecap="round" />
    </SvgShell>
  );
}

export function LogoRocky() {
  return (
    <SvgShell viewBox="0 0 64 64">
      <rect width="64" height="64" rx="14" fill="#10B981" />
      <path fill="#fff" d="M10 42 L24 18 L36 34 L42 24 L54 42 Z" />
      <path fill="#059669" d="M24 42 L36 28 L42 36 L48 28 L54 42 Z" opacity="0.9" />
    </SvgShell>
  );
}

export function LogoWindows() {
  return (
    <SvgShell viewBox="0 0 64 64">
      <rect width="64" height="64" rx="12" fill="#0078D4" />
      <path fill="#fff" d="M14 14h16.5v16.5H14zm19.5 0H50v16.5H33.5zM14 33.5H30.5V50H14zm19.5 0H50V50H33.5z" />
    </SvgShell>
  );
}

export function LogoDebian() {
  return (
    <SvgShell viewBox="0 0 64 64">
      <circle cx="32" cy="32" r="30" fill="#A80030" />
      <path
        fill="none"
        stroke="#fff"
        strokeWidth="3.2"
        strokeLinecap="round"
        d="M38 16c-8-2-16 2-18 10-2 8 4 16 12 18 6 1.5 12-1 14-6"
      />
      <circle cx="40" cy="22" r="2.5" fill="#fff" />
    </SvgShell>
  );
}

export function LogoCentos() {
  return (
    <SvgShell viewBox="0 0 64 64">
      <rect width="64" height="64" rx="14" fill="#262577" />
      <path fill="#fff" d="M32 10l6 10H26l6-10zm0 44l-6-10h12l-6 10zM10 32l10-6v12l-10-6zm44 0l-10 6V26l10 6z" />
      <circle cx="32" cy="32" r="7" fill="none" stroke="#fff" strokeWidth="3" />
    </SvgShell>
  );
}

export function LogoAlma() {
  return (
    <SvgShell viewBox="0 0 64 64">
      <rect width="64" height="64" rx="14" fill="#0F6CBD" />
      <path fill="#fff" d="M14 46 L32 14 L50 46 H40 L32 30 L24 46 Z" />
    </SvgShell>
  );
}

export function LogoSuse() {
  return (
    <SvgShell viewBox="0 0 64 64">
      <rect width="64" height="64" rx="14" fill="#30BA78" />
      <circle cx="24" cy="30" r="5" fill="#fff" />
      <circle cx="40" cy="30" r="5" fill="#fff" />
      <path fill="none" stroke="#fff" strokeWidth="3.5" strokeLinecap="round" d="M18 40c6 6 22 6 28 0" />
      <path fill="#173F4F" d="M28 22h8v4h-8z" opacity="0.35" />
    </SvgShell>
  );
}

export function LogoFedora() {
  return (
    <SvgShell viewBox="0 0 64 64">
      <circle cx="32" cy="32" r="30" fill="#51A2DA" />
      <path
        fill="#fff"
        d="M20 34c0-8 6-14 14-14h10v6H34c-4.5 0-8 3-8 8s3.5 8 8 8h4v6h-4c-8 0-14-6-14-14zm14-4h12v6H34v-6z"
      />
    </SvgShell>
  );
}

export function LogoAmazonLinux() {
  return (
    <SvgShell viewBox="0 0 64 64">
      <rect width="64" height="64" rx="14" fill="#232F3E" />
      <path fill="#FF9900" d="M14 38c8 6 28 6 36 0l-3 5c-9 5-25 5-33 0l0-5z" />
      <path fill="#fff" d="M22 22h6l6 14 6-14h6l-10 22h-4L22 22z" />
    </SvgShell>
  );
}

export function LogoOracle() {
  return (
    <SvgShell viewBox="0 0 64 64">
      <rect width="64" height="64" rx="14" fill="#C74634" />
      <ellipse cx="32" cy="32" rx="18" ry="12" fill="none" stroke="#fff" strokeWidth="5" />
    </SvgShell>
  );
}

export function LogoKubernetes() {
  return (
    <SvgShell viewBox="0 0 64 64">
      <circle cx="32" cy="32" r="30" fill="#326CE5" />
      <path fill="#fff" d="M32 12l16 9v18l-16 9-16-9V21z" opacity="0.95" />
      <circle cx="32" cy="32" r="6" fill="#326CE5" />
    </SvgShell>
  );
}

export function LogoDocker() {
  return (
    <SvgShell viewBox="0 0 64 64">
      <rect width="64" height="64" rx="14" fill="#2496ED" />
      <path fill="#fff" d="M10 34h6v6h-6zm8 0h6v6h-6zm8 0h6v6h-6zm8 0h6v6h-6zm-16-8h6v6h-6zm8 0h6v6h-6zm8 0h6v6h-6zm8-8h6v6h-6z" />
      <path fill="#fff" d="M10 42c2 6 12 8 22 8s18-2 22-8H10z" opacity="0.85" />
    </SvgShell>
  );
}

export function LogoVmGeneric({ accent = "#7C3AED" }) {
  return (
    <SvgShell viewBox="0 0 64 64">
      <rect width="64" height="64" rx="14" fill={accent} />
      <rect x="14" y="16" width="36" height="24" rx="3" fill="#fff" opacity="0.95" />
      <rect x="22" y="42" width="20" height="3" rx="1.5" fill="#fff" />
      <rect x="28" y="40" width="8" height="3" fill="#fff" />
    </SvgShell>
  );
}

export function LogoStackGeneric({ accent = "#0D9488" }) {
  return (
    <SvgShell viewBox="0 0 64 64">
      <rect width="64" height="64" rx="14" fill={accent} />
      <rect x="16" y="16" width="32" height="8" rx="2" fill="#fff" />
      <rect x="16" y="28" width="32" height="8" rx="2" fill="#fff" opacity="0.85" />
      <rect x="16" y="40" width="32" height="8" rx="2" fill="#fff" opacity="0.7" />
    </SvgShell>
  );
}

const RULES = [
  { test: /rhel|red\s*hat|redhat/i, id: "rhel", label: "Red Hat", Logo: LogoRedHat, accent: "#EE0000", tone: "red" },
  { test: /ubuntu/i, id: "ubuntu", label: "Ubuntu", Logo: LogoUbuntu, accent: "#E95420", tone: "orange" },
  { test: /rocky/i, id: "rocky", label: "Rocky Linux", Logo: LogoRocky, accent: "#10B981", tone: "green" },
  { test: /windows|win\s*server|win20|win2k/i, id: "windows", label: "Windows", Logo: LogoWindows, accent: "#0078D4", tone: "blue" },
  { test: /debian/i, id: "debian", label: "Debian", Logo: LogoDebian, accent: "#A80030", tone: "crimson" },
  { test: /centos/i, id: "centos", label: "CentOS", Logo: LogoCentos, accent: "#262577", tone: "indigo" },
  { test: /alma/i, id: "alma", label: "AlmaLinux", Logo: LogoAlma, accent: "#0F6CBD", tone: "blue" },
  { test: /suse|sles|opensuse/i, id: "suse", label: "SUSE", Logo: LogoSuse, accent: "#30BA78", tone: "green" },
  { test: /fedora/i, id: "fedora", label: "Fedora", Logo: LogoFedora, accent: "#51A2DA", tone: "sky" },
  { test: /amazon\s*linux|amzn|al2023|\bal2\b/i, id: "amazon", label: "Amazon Linux", Logo: LogoAmazonLinux, accent: "#FF9900", tone: "amber" },
  { test: /oracle/i, id: "oracle", label: "Oracle Linux", Logo: LogoOracle, accent: "#C74634", tone: "red" },
  { test: /k3s|kubernetes|\bk8s\b/i, id: "k8s", label: "Kubernetes", Logo: LogoKubernetes, accent: "#326CE5", tone: "blue" },
  { test: /docker/i, id: "docker", label: "Docker", Logo: LogoDocker, accent: "#2496ED", tone: "sky" },
];

const TONE_ACCENTS = {
  purple: "#7C3AED",
  blue: "#2563EB",
  green: "#059669",
  orange: "#E67E22",
  red: "#DC2626",
  crimson: "#A80030",
  indigo: "#3730A3",
  sky: "#0EA5E9",
  amber: "#D97706",
  teal: "#0D9488",
};

/**
 * Resolve an official (or best-effort) logo for a catalog template.
 * Matches name + id so newly mapped templates inherit logos without UI changes.
 */
export function resolveTemplateLogo({ name = "", id = "", kind = "vm" } = {}) {
  const hay = `${name} ${id}`.trim();
  for (const rule of RULES) {
    if (rule.test.test(hay)) {
      return {
        id: rule.id,
        label: rule.label,
        Logo: rule.Logo,
        accent: rule.accent,
        tone: rule.tone,
      };
    }
  }
  if (kind === "stack" || /\bstack\b/i.test(hay)) {
    return {
      id: "stack",
      label: "Stack",
      Logo: LogoStackGeneric,
      accent: TONE_ACCENTS.teal,
      tone: "teal",
    };
  }
  // Stable accent from id/name so future unknown templates still look distinct.
  const tones = Object.keys(TONE_ACCENTS);
  let hash = 0;
  for (let i = 0; i < hay.length; i += 1) hash = (hash + hay.charCodeAt(i) * (i + 1)) % 997;
  const tone = tones[hash % tones.length];
  return {
    id: "generic",
    label: kind === "container" ? "Container" : "Virtual Machine",
    Logo: (props) => <LogoVmGeneric accent={TONE_ACCENTS[tone]} {...props} />,
    accent: TONE_ACCENTS[tone],
    tone,
  };
}

export function TemplateLogoMark({ name, id, kind, className = "" }) {
  const meta = resolveTemplateLogo({ name, id, kind });
  const Logo = meta.Logo;
  return (
    <span className={`tpl-logo-mark tpl-logo-${meta.tone} ${className}`} style={{ "--tpl-accent": meta.accent }}>
      <Logo />
    </span>
  );
}
