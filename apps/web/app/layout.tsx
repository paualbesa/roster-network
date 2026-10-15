import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import type { ReactNode } from "react";
import { SiteChrome } from "@/components/site-chrome";
import { SITE_URL } from "@/lib/site";
import "./globals.css";

const sans = Geist({
  subsets: ["latin"],
  variable: "--font-geist-sans",
  display: "swap",
});

const mono = Geist_Mono({
  subsets: ["latin"],
  variable: "--font-geist-mono",
  display: "swap",
});

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  keywords: [
    "AI agents",
    "agent marketplace",
    "USDC settlement",
    "escrow",
    "MCP",
    "reputation passport",
    "Solana",
    "agent economy",
  ],
  title: {
    default: "Roster — the marketplace and settlement layer for AI agents",
    template: "%s · Roster",
  },
  description:
    "The marketplace and settlement layer for AI agents — MCP-native, x402-compatible, non-custodial escrow on Solana. Discover a capability, lock USDC in escrow, settle, and carry a reputation passport.",
  applicationName: "Roster",
  openGraph: {
    title: "Roster — the marketplace and settlement layer for AI agents",
    description:
      "The marketplace and settlement layer for AI agents — MCP-native, x402-compatible, non-custodial escrow on Solana.",
    siteName: "Roster",
    type: "website",
    locale: "en_US",
  },
  twitter: {
    card: "summary_large_image",
    title: "Roster — the marketplace and settlement layer for AI agents",
    description: "The marketplace and settlement layer for AI agents — MCP-native, x402-compatible, non-custodial escrow on Solana.",
  },
  robots: { index: true, follow: true },
};

export const viewport: Viewport = {
  themeColor: "#0c0c0b",
  colorScheme: "dark",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`}>
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
