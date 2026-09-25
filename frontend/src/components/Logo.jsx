// Forge brand mark — anvil + spark (private cloud builder).

export function ForgeMark({ size = 32, className = "" }) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      role="img"
      aria-label="Forge"
    >
      <rect width="32" height="32" rx="8" fill="url(#forge-bg)" />
      <path d="M7 20h18l-2.2 4.5H9.2L7 20z" fill="#57534e" />
      <path d="M9.5 20l3.2-8.5h6.6l3.2 8.5" fill="#a8a29e" />
      <path d="M12.5 11.5h7v2.2h-7v-2.2z" fill="#e7e5e4" />
      <circle cx="23.5" cy="9.5" r="3" fill="#f59e0b" />
      <path
        d="M23.5 6.2v1.6M23.5 10.2v1.6M21.1 9.5h1.6M25.9 9.5h1.6"
        stroke="#fde68a"
        strokeWidth="1"
        strokeLinecap="round"
      />
      <defs>
        <linearGradient id="forge-bg" x1="4" y1="4" x2="28" y2="28" gradientUnits="userSpaceOnUse">
          <stop stopColor="#292524" />
          <stop offset="1" stopColor="#1c1917" />
        </linearGradient>
      </defs>
    </svg>
  );
}

export default function Logo({ size = 32, className = "" }) {
  return <ForgeMark size={size} className={className} />;
}

export function LogoMark(props) {
  return <ForgeMark {...props} />;
}
