"use client";

import { useEffect, useState } from "react";
import { createRosterClient, rosterErrorMessage } from "@/lib/roster-client";
import type { SandboxSession } from "@/lib/session";
import { createConsoleSupabase, waitForSupabaseSignOut } from "@/lib/supabase/browser";
import { readHumanAuthProvider, type HumanAuthProvider } from "@/lib/supabase/oauth";
import { useSandboxSession } from "./session";
import { StatusLine } from "./ui";

/**
 * Restores a GitHub or Google session after `/auth/callback`.
 * The access token is exchanged for the sandbox API key the rest of the console uses.
 * An existing key is left in place; only a missing provider label is filled in.
 */
export function SupabaseSessionBridge() {
  const { session, ready, save, setLinking } = useSandboxSession();
  const [error, setError] = useState("");

  useEffect(() => {
    if (!ready) return;
    if (session?.provider) {
      setLinking(false);
      return;
    }
    let cancelled = false;
    setLinking(true);
    setError("");
    void (async () => {
      await waitForSupabaseSignOut();
      if (cancelled) return;
      const supabase = createConsoleSupabase();
      if (!supabase) {
        if (!cancelled) setLinking(false);
        return;
      }
      const { data } = await supabase.auth.getSession();
      if (cancelled) return;
      const token = data.session?.access_token;
      const provider = readHumanAuthProvider(data.session?.user);
      if (session) {
        if (provider) save(withProvider(session, provider));
        if (!cancelled) setLinking(false);
        return;
      }
      if (!token) {
        if (!cancelled) setLinking(false);
        return;
      }
      try {
        const account = await createRosterClient().adoptSession(token);
        if (cancelled) return;
        save({
          apiKey: account.apiKey,
          email: account.email,
          revealed: false,
          ...(provider ? { provider } : {}),
        });
      } catch (cause) {
        if (!cancelled) setError(rosterErrorMessage(cause));
      } finally {
        if (!cancelled) setLinking(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ready, save, session, setLinking]);

  if (!error) return null;
  return (
    <div className="mx-auto max-w-6xl px-6 pt-4">
      <StatusLine tone="error">{error}</StatusLine>
    </div>
  );
}

function withProvider(session: SandboxSession, provider: HumanAuthProvider): SandboxSession {
  return { ...session, provider };
}
