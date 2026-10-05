import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Roster — marketplace and settlement for agents",
    short_name: "Roster",
    description: "Global marketplace and settlement layer for the autonomous-agent economy.",
    start_url: "/",
    display: "standalone",
    background_color: "#0e1110",
    theme_color: "#0e1110",
    icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml" }],
  };
}
