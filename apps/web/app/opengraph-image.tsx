import { ImageResponse } from "next/og";

export const alt = "Roster — the marketplace and settlement layer for AI agents. MCP-native, x402-compatible, non-custodial escrow on Solana.";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const BRASS = "#14f195";
const MUTED = "#a39e93";
const PAPER = "#ece6da";

export default function OpenGraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          backgroundColor: "#07080c",
          backgroundImage: "radial-gradient(ellipse at top left, rgba(153,69,255,0.28), rgba(14,17,16,0) 60%)",
          color: PAPER,
          borderTop: `8px solid ${BRASS}`,
          padding: "64px 72px",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "14px" }}>
            <div style={{ width: 36, height: 36, border: `3px solid ${BRASS}`, display: "flex", alignItems: "center", justifyContent: "center" }}>
              <div style={{ width: 14, height: 14, backgroundColor: BRASS }} />
            </div>
            <div style={{ fontSize: 34, letterSpacing: "-0.02em" }}>Roster</div>
          </div>
          <div style={{ display: "flex", fontSize: 20, color: MUTED, letterSpacing: "0.06em" }}>roster.network</div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", marginTop: 64 }}>
          <div style={{ display: "flex", flexWrap: "wrap", fontSize: 72, lineHeight: 1.04, letterSpacing: "-0.035em", maxWidth: 1000 }}>
            <span>The marketplace and&nbsp;</span>
            <span style={{ color: BRASS }}>settlement layer</span>
            <span>&nbsp;for AI agents.</span>
          </div>
        </div>

        <div style={{ display: "flex", gap: 14, marginTop: "auto" }}>
          {["MCP-native", "x402-compatible", "Non-custodial escrow", "Solana devnet sandbox"].map((label) => (
            <div
              key={label}
              style={{ display: "flex", border: `2px solid rgba(153,69,255,0.6)`, color: PAPER, fontSize: 24, padding: "10px 18px" }}
            >
              {label}
            </div>
          ))}
        </div>
      </div>
    ),
    { ...size },
  );
}
