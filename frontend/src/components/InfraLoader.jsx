// Responsive SVG loading animation for AI-infrastructure UIs.
//
// Six line-art components — CPU, RAM, monitor, database, network cable, cloud —
// are laid out horizontally inside a single responsive SVG (viewBox scales to
// any width). A staggered CSS keyframe lights each one with a cyan glow for a
// ~400ms slot while the rest stay dim, so the row reads as infrastructure being
// assembled piece by piece. Pure SVG + CSS, transparent background, no deps.
//
// Usage:  <InfraLoader />              // fills its container up to maxWidth
//         <InfraLoader size={320} />   // cap the width (px)
//         <InfraLoader label="Provisioning your VM…" />

const NODE_COUNT = 6;
const SLOT_MS = 400; // time each component stays lit
const CYCLE_S = (NODE_COUNT * SLOT_MS) / 1000; // full sweep = 2.4s

// Each node draws around a local origin (0,0); the parent <g> translates it into
// its horizontal slot. Children inherit fill/stroke from the animated group.
const NODES = [
  {
    id: "cpu",
    content: (
      <>
        <rect x="-19" y="-19" width="38" height="38" rx="5" />
        <rect x="-9" y="-9" width="18" height="18" rx="3" />
        <path d="M-9 -19v-7 M0 -19v-7 M9 -19v-7 M-9 19v7 M0 19v7 M9 19v7 M-19 -9h-7 M-19 0h-7 M-19 9h-7 M19 -9h7 M19 0h7 M19 9h7" />
      </>
    ),
  },
  {
    id: "ram",
    content: (
      <>
        <rect x="-30" y="-13" width="60" height="26" rx="3" />
        <rect x="-23" y="-6" width="8" height="11" rx="1" />
        <rect x="-11" y="-6" width="8" height="11" rx="1" />
        <rect x="1" y="-6" width="8" height="11" rx="1" />
        <rect x="13" y="-6" width="8" height="11" rx="1" />
        <path d="M-24 13v5 M-16 13v5 M-8 13v5 M0 13v5 M8 13v5 M16 13v5 M24 13v5" />
      </>
    ),
  },
  {
    id: "monitor",
    content: (
      <>
        <rect x="-26" y="-21" width="52" height="34" rx="3" />
        <path d="M0 13v7 M-12 20h24" />
      </>
    ),
  },
  {
    id: "database",
    content: (
      <>
        <ellipse cx="0" cy="-16" rx="21" ry="7" />
        <path d="M-21 -16v32a21 7 0 0 0 42 0v-32" />
        <path d="M-21 -3a21 7 0 0 0 42 0" />
        <path d="M-21 9a21 7 0 0 0 42 0" />
      </>
    ),
  },
  {
    id: "network",
    content: (
      <>
        <rect x="-15" y="-22" width="30" height="26" rx="3" />
        <path d="M-9 -22v5 M-3 -22v5 M3 -22v5 M9 -22v5" />
        <path d="M-6 4v6h12v-6" />
        <path d="M0 10v15" />
      </>
    ),
  },
  {
    id: "cloud",
    content: (
      <path d="M-16 11 C-27 11 -27 -3 -15 -4 C-14 -15 6 -17 8 -6 C19 -9 23 7 12 11 Z" />
    ),
  },
];

// Evenly space the slots across the viewBox width.
const SLOT_W = 110;
const VB_W = NODE_COUNT * SLOT_W; // 660
const VB_H = 120;
const CY = 58; // vertical center of the icon row

export default function InfraLoader({ size = 520, className = "", label = "Loading infrastructure" }) {
  return (
    <svg
      className={`infra-loader ${className}`.trim()}
      style={{ maxWidth: size }}
      viewBox={`0 0 ${VB_W} ${VB_H}`}
      role="img"
      aria-label={label}
      xmlns="http://www.w3.org/2000/svg"
    >
      <title>{label}</title>
      <style>{`
        .infra-loader { width: 100%; height: auto; display: block; overflow: visible; }
        .infra-loader .infra-rail {
          stroke: #2f3d52; stroke-width: 2; stroke-dasharray: 2 10;
          stroke-linecap: round; opacity: 0.35;
        }
        .infra-loader .infra-node {
          fill: none; stroke: #33475e; stroke-width: 2.4;
          stroke-linecap: round; stroke-linejoin: round; opacity: 0.38;
          transform-box: fill-box; transform-origin: center;
          animation: infra-glow ${CYCLE_S}s ease-in-out infinite;
        }
        @keyframes infra-glow {
          0%, 20%, 100% {
            stroke: #33475e; opacity: 0.38; transform: scale(1); filter: none;
          }
          5%, 13% {
            stroke: #22d3ee; opacity: 1; transform: scale(1.12);
            filter: drop-shadow(0 0 3px #22d3ee) drop-shadow(0 0 7px rgba(34, 211, 238, 0.55));
          }
        }
        @media (prefers-reduced-motion: reduce) {
          .infra-loader .infra-node { animation: none; opacity: 0.7; stroke: #22d3ee; }
        }
      `}</style>

      <line className="infra-rail" x1={SLOT_W / 2} y1={CY + 46} x2={VB_W - SLOT_W / 2} y2={CY + 46} />

      {NODES.map((node, i) => (
        <g key={node.id} transform={`translate(${SLOT_W / 2 + i * SLOT_W} ${CY})`}>
          <g className="infra-node" style={{ animationDelay: `${(i * SLOT_MS) / 1000}s` }}>
            {node.content}
          </g>
        </g>
      ))}
    </svg>
  );
}
