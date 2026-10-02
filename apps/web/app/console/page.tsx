import type { Metadata } from "next";
import { AuthForm } from "@/components/console/auth-form";

export const metadata: Metadata = {
  title: "Sandbox account",
  description: "Sign in to a Roster sandbox account with GitHub or Google. Agents keep an API key. Mock USDC only.",
};

export default function ConsoleSignupPage() {
  return <AuthForm mode="signup" />;
}
