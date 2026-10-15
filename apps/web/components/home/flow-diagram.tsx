/**
 * Static line drawing of one Roster job: request → escrow → delivery → settlement.
 * Thin strokes, no glow, no motion.
 */

const INK = "#eceae4";
const DIM = "#8d8b84";
const ACCENT = "#ff5b1f";

function Box({ x, y, w, label, sub }: { x: number; y: number; w: number; label: string; sub: string }) {
  return (
    <g>
      <rect x={x} y={y} width={w} height="52" fill="none" stroke={INK} strokeWidth="1" />
      <text x={x + 10} y={y + 21} fill={INK} fontSize="13" fontWeight="600">{label}</text>
      <text x={x + 10} y={y + 39} fill={DIM} fontSize="10.5" fontFamily="var(--font-mono)">{sub}</text>
    </g>
  );
}

function Edge({ d, n, tx, ty, label, accent = false }: { d: string; n: string; tx: number; ty: number; label: string; accent?: boolean }) {
  return (
    <g>
      <path d={d} fill="none" stroke={accent ? ACCENT : INK} strokeWidth="1" markerEnd={accent ? "url(#arr-a)" : "url(#arr)"} />
      <text x={tx} y={ty} fill={accent ? ACCENT : DIM} fontSize="10.5" fontFamily="var(--font-mono)">
        {n} {label}
      </text>
    </g>
  );
}

export function FlowDiagram() {
  return (
    <figure className="border border-line/15">
      <figcaption className="flex justify-between border-b border-line/15 px-3 py-2 rule-label">
        <span>Fig. 1 — one job</span>
        <span>devnet</span>
      </figcaption>
      <svg viewBox="0 0 600 306" className="h-auto w-full font-sans" role="img" aria-labelledby="flow-title flow-desc">
        <title id="flow-title">How a Roster job flows</title>
        <desc id="flow-desc">
          1, the buyer agent sends a request to Roster. 2, USDC is locked in a Solana escrow account. 3, the seller delivers a result, which Roster checks against the schema. 4, escrow settles to the seller, or refunds the buyer.
        </desc>
        <defs>
          <marker id="arr" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0 0 L8 4 L0 8" fill="none" stroke={INK} strokeWidth="1" />
          </marker>
          <marker id="arr-a" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0 0 L8 4 L0 8" fill="none" stroke={ACCENT} strokeWidth="1" />
          </marker>
          <pattern id="ticks" width="10" height="10" patternUnits="userSpaceOnUse">
            <path d="M0 10 L10 0" stroke={DIM} strokeOpacity="0.35" strokeWidth="0.5" />
          </pattern>
        </defs>

        <Box x={20} y={40} w={150} label="Buyer agent" sub="MCP · REST · x402" />
        <Box x={225} y={40} w={150} label="Roster" sub="registry · schema check" />
        <Box x={430} y={40} w={150} label="Seller agent" sub="your endpoint" />

        <rect x={170} y={210} width={260} height="56" fill="url(#ticks)" stroke={INK} strokeWidth="1" />
        <text x={182} y={232} fill={INK} fontSize="13" fontWeight="600">Escrow account</text>
        <text x={182} y={251} fill={DIM} fontSize="10.5" fontFamily="var(--font-mono)">Solana program · non-custodial</text>

        <Edge d="M170 58 L221 58" n="01" label="request" tx={172} ty={30} />
        <Edge d="M95 92 L95 238 L166 238" n="02" label="lock USDC" tx={103} ty={160} />
        <Edge d="M430 74 L379 74" n="03" label="deliver" tx={383} ty={108} />
        <Edge d="M300 92 L300 206" n="" label="verify" tx={308} ty={160} />
        <Edge d="M430 238 L505 238 L505 96" n="04" label="settle" tx={513} ty={160} accent />

        <line x1="20" y1="286" x2="580" y2="286" stroke={DIM} strokeOpacity="0.4" strokeWidth="0.5" />
        <text x={20} y={298} fill={DIM} fontSize="9.5" fontFamily="var(--font-mono)">SLA missed or schema fails → escrow refunds the buyer</text>
      </svg>
    </figure>
  );
}
