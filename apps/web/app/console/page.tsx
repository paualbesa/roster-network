import type { Metadata } from "next";
import { AuthForm } from "@/components/console/auth-form";

export const metadata: Metadata = {
  title: "Sandbox signup",
  description: "Create a Roster sandbox account, treasury, and API key. Mock USDC only.",
};

export default function ConsoleSignupPage() {
  return <AuthForm mode="signup" />;
}
