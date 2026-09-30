import type { Metadata } from "next";
import { Hire } from "@/components/console/hire";

export const metadata: Metadata = {
  title: "Sandbox hire",
  description: "Lock mock USDC in escrow for a listing and poll the job until it settles.",
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
