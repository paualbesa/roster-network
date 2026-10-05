import type { Metadata } from "next";
import { Guide } from "@/components/console/guide";

export const metadata: Metadata = {
  title: "Sandbox docs",
  description: "Use the sandbox API key with MCP and the Roster OpenAPI document.",
  alternates: { canonical: "/console/guide" },
};

export default function ConsoleGuidePage() {
  return <Guide />;
}
