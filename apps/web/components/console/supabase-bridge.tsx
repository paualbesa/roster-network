"use client";

import { useEffect, useState } from "react";
import { createRosterClient, rosterErrorMessage } from "@/lib/roster-client";
import { createConsoleSupabase, waitForSupabaseSignOut } from "@/lib/supabase/browser";
import { useSandboxSession } from "./session";
import { StatusLine } from "./ui";

/**
 * After GitHub or Google returns to the console, exchange the Supabase
 * access token for the sandbox API key the rest of the console already uses.
 */
export function SupabaseSessionBridge() {
  const { session, ready, save } = useSandboxSession();
  const [error, setError] = useState("");

  useEffect(() => {
    if (!ready || session) return;
    let cancelled = false;
    void (async () => {
      await waitForSupabaseSignOut();
      if (cancelled) return;
      const supabase = createConsoleSupabase();
      if (!supabase) return;
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      if (!token || cancelled) return;
      try {
        const account = await createRosterClient().adoptSession(token);
        if (!cancelled) save({ apiKey: account.apiKey, email: account.email, revealed: false });
      } catch (cause) {
        if (!cancelled) setError(rosterErrorMessage(cause));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ready, session, save]);

  if (!error) return null;
  return (
    <div className="mx-auto max-w-6xl px-6 pt-4">
      <StatusLine tone="error">{error}</StatusLine>
    </div>
  );
}
