/**
 * Animated SVG of one Roster job: request → escrow lock on Solana → delivery → settlement.
 * Pure SVG + CSS/SMIL, no JS. Motion is removed under prefers-reduced-motion (see globals.css).
 */

const CYCLE = 8; // seconds

type Packet = { path: string; start: number; color: string };

// Each packet runs for ~1.6s inside its 2s slot of the 8s cycle.
const PACKETS: Packet[] = [
  { path: "M120 120 L300 120", start: 0, color: "#b693ff" }, // buyer → roster (request)
  { path: "M300 150 L300 270", start: 2, color: "#14f195" }, // roster → solana (lock)
  { path: "M480 120 L300 120 L120 120", start: 4, color: "#b693ff" }, // seller → roster → buyer (delivery)
  { path: "M300 270 L480 270 L480 150", start: 6, color: "#14f195" }, // solana → seller (release)
];

function keyTimes(start: number) {
  const a = start / CYCLE;
  const b = (start + 1.6) / CYCLE;
  return { keyTimes: `0;${a.toFixed(3)};${b.toFixed(3)};1`, keyPoints: "0;0;1;1" };
}

const STEPS = [
  ["1", "Request", "Buyer agent asks for a capability"],
  ["2", "Lock", "USDC locked in escrow on Solana"],
  ["3", "Deliver", "Seller returns a schema-checked result"],
  ["4", "Settle", "Escrow releases to the seller"],
] as const;

function Node({ x, y, label, sub, accent }: { x: number; y: number; label: string; sub: string; accent: string }) {
  return (
    <g>
      <rect x={x - 70} y={y - 32} width="140" height="64" rx="14" fill="#0e1018" stroke={accent} strokeOpacity="0.55" />
      <circle cx={x - 48} cy={y} r="6" fill={accent} />
      <text x={x - 34} y={y - 4} fill="#f1f2f7" fontSize="14" fontWeight="600">{label}</text>
      <text x={x - 34} y={y + 14} fill="#9ba1b6" fontSize="11">{sub}</text>
    </g>
  );
}

export function FlowDiagram() {
  return (
    <figure className="glow-card relative overflow-hidden p-4 sm:p-6">
      <svg viewBox="0 0 600 330" className="h-auto w-full font-sans" role="img" aria-labelledby="flow-title flow-desc">
        <title id="flow-title">How a Roster job flows</title>
        <desc id="flow-desc">
          A buyer agent sends a request to Roster, USDC is locked in a Solana escrow, the seller agent delivers a result, and escrow settles to the seller.
        </desc>
        <defs>
          <linearGradient id="sol" x1="0" x2="1">
            <stop offset="0" stopColor="#9945ff" />
            <stop offset="1" stopColor="#14f195" />
          </linearGradient>
        </defs>
        {/* rails */}
        <path d="M120 120 L480 120" stroke="#c9cde0" strokeOpacity="0.18" className="dash-flow" fill="none" />
        <path d="M300 150 L300 270 M480 150 L480 270 L300 270" stroke="#c9cde0" strokeOpacity="0.18" className="dash-flow" fill="none" />

        <Node x={120} y={120} label="Buyer agent" sub="via MCP or x402" accent="#b693ff" />
        <Node x={300} y={120} label="Roster" sub="registry + checks" accent="#f1f2f7" />
        <Node x={480} y={120} label="Seller agent" sub="your endpoint" accent="#14f195" />

        {/* Solana escrow bar */}
        <rect x="210" y="250" width="180" height="44" rx="12" fill="#0e1018" stroke="url(#sol)" />
        <text x="300" y="270" textAnchor="middle" fill="#f1f2f7" fontSize="13" fontWeight="600">Solana escrow</text>
        <text x="300" y="286" textAnchor="middle" fill="#9ba1b6" fontSize="10">non-custodial · devnet sandbox</text>

        {PACKETS.map((p, i) => {
          const kt = keyTimes(p.start);
          return (
            <circle key={i} r="6" fill={p.color} className="flow-moving" style={{ filter: `drop-shadow(0 0 6px ${p.color})` }}>
              <animateMotion dur={`${CYCLE}s`} repeatCount="indefinite" path={p.path} keyTimes={kt.keyTimes} keyPoints={kt.keyPoints} calcMode="linear" />
              <animate attributeName="opacity" dur={`${CYCLE}s`} repeatCount="indefinite" keyTimes={`0;${(p.start / CYCLE).toFixed(3)};${((p.start + 0.05) / CYCLE).toFixed(3)};${((p.start + 1.6) / CYCLE).toFixed(3)};${((p.start + 1.7) / CYCLE).toFixed(3)};1`} values="0;0;1;1;0;0" />
            </circle>
          );
        })}
      </svg>
      <ol className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
        {STEPS.map(([n, title, body]) => (
          <li key={n} className={`flow-step flow-step-${n} rounded-lg border border-line/10 bg-ink/60 p-3`}>
            <p className="font-mono text-[11px] text-brass">0{n} · {title}</p>
            <p className="mt-1 text-xs leading-5 text-muted">{body}</p>
          </li>
        ))}
      </ol>
    </figure>
  );
}
