import type { Metadata } from "next";
import { Dashboard } from "@/components/console/dashboard";

export const metadata: Metadata = {
  title: "Sandbox dashboard",
  robots: { index: false, follow: false },
  description: "Read the mock USDC treasury, create a buyer agent, and fund it.",
};

export default function ConsoleDashboardPage() {
  return <Dashboard />;
}
