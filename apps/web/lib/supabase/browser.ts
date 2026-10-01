import { createBrowserClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import { readPublicSupabaseEnv } from "./config";

let signOutTask: Promise<void> = Promise.resolve();

/** Null when the site was built without the public Supabase variables. */
export function createConsoleSupabase(): SupabaseClient | null {
  const config = readPublicSupabaseEnv({
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  });
  if (!config) return null;
  return createBrowserClient(config.url, config.anonKey);
}

export function beginSupabaseSignOut(): void {
  const supabase = createConsoleSupabase();
  if (!supabase) return;
  signOutTask = supabase.auth.signOut().then(
    () => undefined,
    () => undefined,
  );
}

export function waitForSupabaseSignOut(): Promise<void> {
  return signOutTask;
}
