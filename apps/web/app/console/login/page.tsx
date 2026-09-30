import type { Metadata } from "next";
import { AuthForm } from "@/components/console/auth-form";

export const metadata: Metadata = {
  title: "Sandbox login",
  description: "Log in to a Roster sandbox account and receive a new API key.",
};

export default function ConsoleLoginPage() {
  return <AuthForm mode="login" />;
}
