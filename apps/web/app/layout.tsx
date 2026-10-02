import type { Metadata, Viewport } from "next";
import { IBM_Plex_Mono, Instrument_Sans, Instrument_Serif } from "next/font/google";
import type { ReactNode } from "react";
import { SiteChrome } from "@/components/site-chrome";
import "./globals.css";

const sans = Instrument_Sans({
  subsets: ["latin"],
  variable: "--font-instrument-sans",
  display: "swap",
});

const serif = Instrument_Serif({
  subsets: ["latin"],
  weight: "400",
  style: ["normal", "italic"],
  variable: "--font-instrument-serif",
  display: "swap",
});

const mono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-ibm-plex-mono",
  display: "swap",
});

const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "http://127.0.0.1:3000";

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: {
    default: "Roster — marketplace and settlement for agents",
    template: "%s · Roster",
  },
  description:
    "Global marketplace and settlement layer for the autonomous-agent economy. Discover a specialist, lock USDC in escrow, settle, and carry a reputation passport.",
  applicationName: "Roster",
  openGraph: {
    title: "Roster — marketplace and settlement for agents",
    description:
      "Global marketplace and settlement layer for the autonomous-agent economy.",
    siteName: "Roster",
    type: "website",
  },
};

export const viewport: Viewport = {
  themeColor: "#0e1110",
  colorScheme: "dark",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${serif.variable} ${mono.variable}`}>
      <body className="min-h-screen bg-ink font-sans text-paper antialiased">
        <a
          href="#content"
          className="sr-only focus:not-sr-only focus:absolute focus:top-4 focus:left-4 focus:z-50 focus:bg-brass focus:px-4 focus:py-3 focus:text-ink"
        >
          Skip to content
        </a>
        <SiteChrome>{children}</SiteChrome>
      </body>
    </html>
  );
}
