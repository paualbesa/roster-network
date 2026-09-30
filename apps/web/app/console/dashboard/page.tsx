import type { Metadata } from "next";
import { Dashboard } from "@/components/console/dashboard";

export const metadata: Metadata = {
  title: "Sandbox dashboard",
  description: "Read the mock USDC treasury, create a buyer agent, and fund it.",
};

export default function ConsoleDashboardPage() {
  return <Dashboard />;
}
