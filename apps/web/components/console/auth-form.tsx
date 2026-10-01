"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { createRosterClient, rosterErrorMessage } from "@/lib/roster-client";
import { createConsoleSupabase } from "@/lib/supabase/browser";
import { readPublicSupabaseEnv } from "@/lib/supabase/config";
import { ApiKeyPanel } from "./api-key-panel";
import { useSandboxSession } from "./session";
import { ConsolePage, StatusLine, buttonClass, fieldClass, ghostClass } from "./ui";

export function AuthForm({ mode }: { mode: "signup" | "login" }) {
  const { session, save, acknowledge } = useSandboxSession();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [freshKey, setFreshKey] = useState<string | null>(null);
  const signup = mode === "signup";
  const supabaseConfigured = readPublicSupabaseEnv({
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  }) !== null;

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const email = String(data.get("email") ?? "");
    const password = String(data.get("password") ?? "");
    const name = String(data.get("name") ?? "");
    setPending(true);
    setError("");
    setNote("");
    try {
      if (supabaseConfigured) {
        const supabase = createConsoleSupabase();
        if (!supabase) throw new Error("Supabase Auth is not configured in this build.");
        if (signup) {
          const { data, error: authError } = await supabase.auth.signUp({
            email: email.trim(),
            password,
            options: {
              ...(name.trim() ? { data: { full_name: name.trim() } } : {}),
              emailRedirectTo: oauthRedirect(),
            },
          });
          if (authError) throw authError;
          if (!data.session) {
            setNote("Check your email to confirm the account, then log in.");
            return;
          }
          const account = await createRosterClient().adoptSession(data.session.access_token);
          save({ apiKey: account.apiKey, email: account.email, revealed: false });
          setFreshKey(account.apiKey);
          return;
        }
        const { data, error: authError } = await supabase.auth.signInWithPassword({
          email: email.trim(),
          password,
        });
        if (authError) throw authError;
        if (!data.session) throw new Error("Supabase did not return a session.");
        const account = await createRosterClient().adoptSession(data.session.access_token);
        save({ apiKey: account.apiKey, email: account.email, revealed: false });
        setFreshKey(account.apiKey);
        return;
      }
      const client = createRosterClient();
      const account = signup
        ? await client.signup({ email, password, ...(name.trim() ? { name } : {}) })
        : await client.login({ email, password });
      save({ apiKey: account.apiKey, email: account.email, revealed: false });
      setFreshKey(account.apiKey);
    } catch (cause) {
      setError(readableAuthError(cause));
    } finally {
      setPending(false);
    }
  }

  async function onOAuth(provider: "github" | "google") {
    setPending(true);
    setError("");
    setNote("");
    try {
      const supabase = createConsoleSupabase();
      if (!supabase) throw new Error("Supabase Auth is not configured in this build.");
      const { error: authError } = await supabase.auth.signInWithOAuth({
        provider,
        options: { redirectTo: oauthRedirect() },
      });
      if (authError) throw authError;
    } catch (cause) {
      setError(readableAuthError(cause));
      setPending(false);
    }
  }

  const key = freshKey ?? (session && !session.revealed ? session.apiKey : null);

  return (
    <ConsolePage
      eyebrow={signup ? "Signup" : "Login"}
      title={signup ? "Open a sandbox account." : "Return to your sandbox account."}
      lede={
        signup
          ? "Creates an organization and a treasury funded with mock USDC. The API key is shown once and kept in this browser."
          : "Checks the password and issues a new sandbox API key for the same account. Older keys keep working."
      }
    >
      <div className="grid gap-10 lg:grid-cols-[minmax(0,28rem)_minmax(0,1fr)]">
        {key ? (
          <div className="flex flex-col gap-6">
            <ApiKeyPanel
              apiKey={key}
              onHide={() => {
                acknowledge();
                setFreshKey(null);
              }}
            />
            <Link href="/console/dashboard" className={buttonClass}>
              Continue to dashboard
            </Link>
          </div>
        ) : (
          <form
            method="post"
            action={signup ? "/console" : "/console/login"}
            onSubmit={onSubmit}
            className="flex flex-col gap-4 border border-line/10 bg-panel p-6"
          >
            {supabaseConfigured ? (
              <div className="flex flex-col gap-3">
                <button type="button" className={ghostClass} disabled={pending} onClick={() => void onOAuth("github")}>
                  Continue with GitHub
                </button>
                <button type="button" className={ghostClass} disabled={pending} onClick={() => void onOAuth("google")}>
                  Continue with Google
                </button>
                <p className="text-xs leading-5 text-muted">Email and password stay available as a fallback.</p>
              </div>
            ) : (
              <p className="text-xs leading-5 text-muted">
                GitHub and Google are off until this site is built with NEXT_PUBLIC_SUPABASE_URL and
                NEXT_PUBLIC_SUPABASE_ANON_KEY. Email and password still open a sandbox account.
              </p>
            )}
            <div className="flex flex-col gap-2">
              <label htmlFor="email" className="text-sm text-paper">
                Email
              </label>
              <input
                id="email"
                name="email"
                type="email"
                autoComplete="email"
                required
                maxLength={254}
                placeholder="ada@example.com"
                className={fieldClass}
              />
            </div>
            {signup ? (
              <div className="flex flex-col gap-2">
                <label htmlFor="name" className="text-sm text-paper">
                  Display name <span className="text-muted">(optional)</span>
                </label>
                <input
                  id="name"
                  name="name"
                  type="text"
                  autoComplete="name"
                  maxLength={80}
                  placeholder="Ada"
                  className={fieldClass}
                />
              </div>
            ) : null}
            <div className="flex flex-col gap-2">
              <label htmlFor="password" className="text-sm text-paper">
                Password
              </label>
              <input
                id="password"
                name="password"
                type="password"
                autoComplete={signup ? "new-password" : "current-password"}
                required
                minLength={8}
                maxLength={128}
                className={fieldClass}
              />
            </div>
            <button type="submit" className={buttonClass} disabled={pending}>
              {pending ? "Contacting sandbox…" : signup ? "Create sandbox account" : "Log in"}
            </button>
            <p className="text-xs leading-5 text-muted">
              {supabaseConfigured
                ? "Sandbox only. Mock USDC. Email and password go to Supabase Auth. Agents keep using API keys."
                : "Sandbox only. Mock USDC. The password is sent to the Roster API and stored as a hash. This form does not take a card."}
            </p>
            {note ? <StatusLine tone="ok">{note}</StatusLine> : null}
            {error ? <StatusLine tone="error">{error}</StatusLine> : null}
            <p className="text-sm text-muted">
              {signup ? (
                <>
                  Already have an account?{" "}
                  <Link href="/console/login" className="text-brass underline decoration-brass/40 underline-offset-4">
                    Log in
                  </Link>
                </>
              ) : (
                <>
                  New here?{" "}
                  <Link href="/console" className="text-brass underline decoration-brass/40 underline-offset-4">
                    Create an account
                  </Link>
                </>
              )}
            </p>
          </form>
        )}
        <aside className="text-sm leading-6 text-muted">
          <p>
            After signup, fund a buyer from the treasury, publish the sample catalog, bind a seller agent, then hire from the marketplace.
          </p>
          <p className="mt-4">
            <Link href="/console/guide" className="text-brass underline decoration-brass/40 underline-offset-4">
              MCP and OpenAPI tips
            </Link>
          </p>
        </aside>
      </div>
    </ConsolePage>
  );
}

function oauthRedirect(): string {
  return `${window.location.origin}/auth/callback?next=/console`;
}

function readableAuthError(cause: unknown): string {
  if (cause instanceof Error && cause.message.trim()) return cause.message;
  return rosterErrorMessage(cause);
}
