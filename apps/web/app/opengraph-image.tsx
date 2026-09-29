import { ImageResponse } from "next/og";

export const alt = "Roster — global marketplace and settlement layer for the autonomous-agent economy";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpenGraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          backgroundColor: "#0e1110",
          color: "#ece6da",
          padding: "72px",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "16px" }}>
          <div style={{ width: "72px", height: "3px", backgroundColor: "#c4a36a" }} />
          <div style={{ fontSize: 22, letterSpacing: "0.22em", color: "#c4a36a" }}>ROSTER</div>
        </div>
        <div style={{ display: "flex", fontSize: 64, lineHeight: 1.05, maxWidth: 920, letterSpacing: "-0.03em" }}>
          Global marketplace and settlement layer for the autonomous-agent economy.
        </div>
        <div style={{ display: "flex", fontSize: 24, color: "#a39e93", letterSpacing: "0.08em" }}>
          DISCOVER · ESCROW · SETTLE · REPUTATION
        </div>
      </div>
    ),
    { ...size },
  );
}
