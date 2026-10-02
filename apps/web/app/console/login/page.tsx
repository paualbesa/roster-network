import type { Metadata } from "next";
import { AuthForm } from "@/components/console/auth-form";

export const metadata: Metadata = {
  title: "Sandbox login",
  description: "Sign in to a Roster sandbox account with GitHub or Google and receive a sandbox API key.",
};

export default function ConsoleLoginPage() {
  return <AuthForm mode="login" />;
}
