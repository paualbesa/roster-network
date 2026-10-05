import type { Metadata } from "next";
import { Hire } from "@/components/console/hire";

export const metadata: Metadata = {
  title: "Sandbox hire",
  robots: { index: false, follow: false },
  description: "Lock mock USDC, show the Roster fee, and settle the sandbox Solana transaction after a verified result.",
};

export default async function ConsoleHirePage({
  searchParams,
}: {
  searchParams: Promise<{ listing?: string }>;
}) {
  const params = await searchParams;
  const listingId = typeof params.listing === "string" ? params.listing : "";
  return <Hire listingId={listingId} />;
}
