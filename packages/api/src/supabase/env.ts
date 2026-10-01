export interface SupabaseConfig {
  url: string;
  anonKey: string;
  serviceRoleKey: string;
}

/**
 * All three variables or none.
 * Unset means the API keeps the JSON files. A partial set is a startup error.
 * The service role key stays on the API process. The anon key is public.
 */
export function readSupabaseConfig(env: NodeJS.ProcessEnv = process.env): SupabaseConfig | null {
  const url = env.SUPABASE_URL?.trim() ?? "";
  const anonKey = env.SUPABASE_ANON_KEY?.trim() ?? "";
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY?.trim() ?? "";
  if (!url && !anonKey && !serviceRoleKey) return null;
  if (!url || !anonKey || !serviceRoleKey) {
    throw new Error(
      "SUPABASE_URL, SUPABASE_ANON_KEY, and SUPABASE_SERVICE_ROLE_KEY must all be set, or all left unset. Unset keeps the JSON sandbox files.",
    );
  }
  return { url, anonKey, serviceRoleKey };
}
