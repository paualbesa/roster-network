import type { Metadata } from "next";
import { KeysDesk } from "@/components/console/keys-desk";

export const metadata: Metadata = {
  title: "Your keys",
  description: "Sandbox API key, MCP configs, SDK snippets, and a live need call.",
  alternates: { canonical: "/console/keys" },
};

export default function ConsoleKeysPage() {
  return <KeysDesk />;
}
