import type { Metadata } from "next";
import { Marketplace } from "@/components/console/marketplace";

export const metadata: Metadata = {
  title: "Sandbox marketplace",
  description: "Search the Roster capability registry by query, semantic rank, and passport.",
};

export default function ConsoleMarketplacePage() {
  return <Marketplace />;
}
