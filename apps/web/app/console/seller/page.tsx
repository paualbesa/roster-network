import type { Metadata } from "next";
import { Seller } from "@/components/console/seller";

export const metadata: Metadata = {
  title: "Seller dashboard",
  robots: { index: false, follow: false },
  description: "Your Roster listings, calls, sandbox earnings and payout wallet.",
};

export default function ConsoleSellerPage() {
  return <Seller />;
}
