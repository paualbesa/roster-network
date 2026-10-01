import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { SupabaseConfig } from "./env.js";

/** Service-role client. Bypasses RLS. Never import this from the web app. */
export function createServiceClient(config: SupabaseConfig): SupabaseClient {
  return createClient(config.url, config.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

/** Anon client used only to check a caller's access token. */
export function createAnonClient(config: SupabaseConfig): SupabaseClient {
  return createClient(config.url, config.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}
