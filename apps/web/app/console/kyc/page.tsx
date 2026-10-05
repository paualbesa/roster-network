import type { Metadata } from "next";
import { Kyc } from "@/components/console/kyc";

export const metadata: Metadata = {
  title: "Verification (KYC)",
  robots: { index: false, follow: false },
  description: "See your KYC tier and escrow volume cap, and submit Tier 1 verification for manual review.",
};

export default function ConsoleKycPage() {
  return <Kyc />;
}
