"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { createRosterClient, rosterErrorMessage } from "@/lib/roster-client";
import { createConsoleSupabase } from "@/lib/supabase/browser";
import { readPublicSupabaseEnv } from "@/lib/supabase/config";
import { describeSignedInAccount, humanOAuthSignIn, oauthRedirectTo, readHumanAuthProvider } from "@/lib/supabase/oauth";
import { useSandboxSession } from "./session";
import { ConsolePage, StatusLine, buttonClass, fieldClass, ghostClass } from "./ui";

export function AuthForm({ mode }: { mode: "signup" | "login" }) {
  const router = useRouter();
  const { session, ready, linking, save, clear } = useSandboxSession();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [tab, setTab] = useState<"instant" | "email">(mode === "login" ? "email" : "instant");
  const signup = mode === "signup";
  const supabaseConfigured =
    readPublicSupabaseEnv({
      NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
      NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    }) !== null;

  async function finish(apiKey: string, email: string, provider: "email" | "github" | "google" | "anonymous") {
    save({ apiKey, email, revealed: false, provider });
    router.push("/console/keys");
  }

  async function onInstant() {
    setPending(true);
    setError("");
    setNote("");
    try {
      const account = await createRosterClient().anonymous();
      await finish(account.apiKey, "", "anonymous");
    } catch (cause) {
      setError(readableAuthError(cause));
    } finally {
      setPending(false);
    }
  }

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
          const { data: signedUp, error: authError } = await supabase.auth.signUp({
            email: email.trim(),
            password,
            options: {
              ...(name.trim() ? { data: { full_name: name.trim() } } : {}),
              emailRedirectTo: oauthRedirectTo(window.location.origin),
            },
          });
          if (authError) throw authError;
          if (!signedUp.session) {
            setNote("Check your email to confirm the account, then sign in.");
            return;
          }
          const account = await createRosterClient().adoptSession(signedUp.session.access_token);
          const provider = readHumanAuthProvider(signedUp.session.user) ?? "email";
          await finish(account.apiKey, account.email, provider === "anonymous" ? "email" : provider);
          return;
        }
        const { data: signedIn, error: authError } = await supabase.auth.signInWithPassword({
          email: email.trim(),
          password,
        });
        if (authError) throw authError;
        if (!signedIn.session) throw new Error("Supabase did not return a session.");
        const account = await createRosterClient().adoptSession(signedIn.session.access_token);
        const provider = readHumanAuthProvider(signedIn.session.user) ?? "email";
        await finish(account.apiKey, account.email, provider === "anonymous" ? "email" : provider);
        return;
      }
      const client = createRosterClient();
      const account = signup
        ? await client.signup({ email, password, ...(name.trim() ? { name } : {}) })
        : await client.login({ email, password });
      await finish(account.apiKey, account.email, "email");
    } catch (cause) {
      setError(readableAuthError(cause));
    } finally {
      setPending(false);
    }
  }

  async function onMagicLink(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const email = String(data.get("magic-email") ?? "").trim();
    if (!email) {
      setError("Enter an email for the magic link.");
      return;
    }
    setPending(true);
    setError("");
    setNote("");
    try {
      const supabase = createConsoleSupabase();
      if (!supabase) throw new Error("Magic link needs Supabase Auth on this site.");
      const { error: authError } = await supabase.auth.signInWithOtp({
        email,
        options: { emailRedirectTo: oauthRedirectTo(window.location.origin) },
      });
      if (authError) throw authError;
      setNote("Check your inbox for the sign-in link.");
    } catch (cause) {
      setError(readableAuthError(cause));
    } finally {
      setPending(false);
    }
  }

  async function onOAuth(provider: "github" | "google") {
    if (!supabaseConfigured) return;
    setPending(true);
    setError("");
    setNote("");
    try {
      const supabase = createConsoleSupabase();
      if (!supabase) throw new Error("Supabase Auth is not configured in this build.");
      const request = humanOAuthSignIn(provider, window.location.origin);
      const { error: authError } = await supabase.auth.signInWithOAuth(request);
      if (authError) throw authError;
    } catch (cause) {
      setError(readableAuthError(cause));
      setPending(false);
    }
  }

  if (!ready || (linking && !session)) {
    return (
      <ConsolePage
        eyebrow="Account"
        title="Restoring your session."
        lede="Checking this browser for an existing sandbox key or OAuth session."
      >
        <StatusLine tone="muted">Restoring your session…</StatusLine>
      </ConsolePage>
    );
  }

  if (session) {
    const account = describeSignedInAccount(session);
    return (
      <ConsolePage eyebrow="Account" title="You are signed in." lede={account.headline}>
        <div className="flex flex-col gap-4 sm:flex-row">
          <Link href="/console/keys" className={buttonClass}>
            Your keys
          </Link>
          <Link href="/console/dashboard" className={ghostClass}>
            Dashboard
          </Link>
          <button type="button" className={ghostClass} onClick={clear}>
            Sign out
          </button>
        </div>
      </ConsolePage>
    );
  }

  return (
    <ConsolePage
      eyebrow="Console"
      title={signup ? "Start in one click." : "Welcome back."}
      lede="Get a sandbox API key for agents, or sign in as a human. Mock USDC only. Keys are hashed on the server and shown in full only once."
    >
      <div className="grid gap-10 lg:grid-cols-[minmax(0,32rem)_minmax(0,1fr)]">
        <div className="flex flex-col gap-6 border border-line/10 bg-panel p-6">
          {signup ? (
            <div className="flex gap-2 border-b border-line/10 pb-3">
              <button
                type="button"
                className={tab === "instant" ? "text-sm text-brass" : "text-sm text-muted hover:text-paper"}
                onClick={() => setTab("instant")}
              >
                Instant key
              </button>
              <button
                type="button"
                className={tab === "email" ? "text-sm text-brass" : "text-sm text-muted hover:text-paper"}
                onClick={() => setTab("email")}
              >
                Email
              </button>
            </div>
          ) : null}

          {signup && tab === "instant" ? (
            <div className="flex flex-col gap-4">
              <p className="text-sm leading-6 text-muted">
                For agents and developers who want to call the API without creating an account. You can add an email later
                from <span className="text-paper">Your keys</span>.
              </p>
              <button type="button" className={buttonClass} disabled={pending} onClick={() => void onInstant()}>
                {pending ? "Creating key…" : "Get an API key instantly"}
              </button>
            </div>
          ) : (
            <>
              <div className="flex flex-col gap-3">
                <OAuthButton
                  label="Continue with GitHub"
                  disabled={pending || !supabaseConfigured}
                  {...(!supabaseConfigured
                    ? {
                        title:
                          "GitHub sign-in needs Supabase OAuth on this deployment (Site URL + GitHub provider).",
                      }
                    : {})}
                  onClick={() => void onOAuth("github")}
                />
                <OAuthButton
                  label="Continue with Google"
                  disabled={pending || !supabaseConfigured}
                  {...(!supabaseConfigured
                    ? {
                        title:
                          "Google sign-in needs Supabase OAuth on this deployment (Site URL + Google provider).",
                      }
                    : {})}
                  onClick={() => void onOAuth("google")}
                />
                {!supabaseConfigured ? (
                  <p className="text-xs leading-5 text-muted">
                    GitHub and Google stay available in the UI but are disabled until OAuth is configured. Email and
                    password still work against the Roster API.
                  </p>
                ) : null}
              </div>

              {supabaseConfigured ? (
                <form onSubmit={onMagicLink} className="flex flex-col gap-3 border-t border-line/10 pt-4">
                  <label htmlFor="magic-email" className="text-sm text-paper">
                    Magic link
                  </label>
                  <input
                    id="magic-email"
                    name="magic-email"
                    type="email"
                    autoComplete="email"
                    maxLength={254}
                    placeholder="ada@example.com"
                    className={fieldClass}
                  />
                  <button type="submit" className={ghostClass} disabled={pending}>
                    {pending ? "Sending…" : "Email me a sign-in link"}
                  </button>
                </form>
              ) : null}

              <form method="post" onSubmit={onSubmit} className="flex flex-col gap-4 border-t border-line/10 pt-4">
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
                  {pending ? "Contacting sandbox…" : signup ? "Create account" : "Sign in with email"}
                </button>
              </form>
            </>
          )}

          {note ? <StatusLine tone="ok">{note}</StatusLine> : null}
          {error ? <StatusLine tone="error">{error}</StatusLine> : null}

          <p className="text-sm text-muted">
            {signup ? (
              <>
                Already have an account?{" "}
                <Link href="/console/login" className="text-brass underline decoration-brass/40 underline-offset-4">
                  Sign in
                </Link>
              </>
            ) : (
              <>
                New here?{" "}
                <Link href="/console" className="text-brass underline decoration-brass/40 underline-offset-4">
                  Get a key
                </Link>
              </>
            )}
          </p>
        </div>
        <aside className="text-sm leading-6 text-muted">
          <p>After you have a key, open Your keys for MCP configs, SDK snippets, and a live <code className="text-paper">need</code> call.</p>
          <p className="mt-4">
            <Link href="/console/guide" className="text-brass underline decoration-brass/40 underline-offset-4">
              Console guide
            </Link>
          </p>
        </aside>
      </div>
    </ConsolePage>
  );
}

function OAuthButton({
  label,
  disabled,
  title,
  onClick,
}: {
  label: string;
  disabled: boolean;
  title?: string | undefined;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={disabled && title ? `${ghostClass} cursor-not-allowed opacity-60` : buttonClass}
      disabled={disabled}
      {...(title ? { title } : {})}
      aria-disabled={disabled}
      onClick={onClick}
    >
      {label}
      {disabled && title ? <span className="sr-only">. {title}</span> : null}
    </button>
  );
}

function readableAuthError(cause: unknown): string {
  if (cause instanceof Error && cause.message.trim()) return cause.message;
  return rosterErrorMessage(cause);
}
