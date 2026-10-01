export interface PublicSupabaseConfig {
  url: string;
  anonKey: string;
}

/**
 * Browser and server config for Supabase Auth.
 * `NEXT_PUBLIC_*` is what the Next.js bundle can see. The same values as
 * `SUPABASE_URL` and `SUPABASE_ANON_KEY` are accepted when this runs on the server.
 * The service role key is never read here.
 */
export function readPublicSupabaseEnv(env: { [key: string]: string | undefined }): PublicSupabaseConfig | null {
  const url = first(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_URL);
  const anonKey = first(env.NEXT_PUBLIC_SUPABASE_ANON_KEY, env.SUPABASE_ANON_KEY);
  if (!url && !anonKey) return null;
  if (!url || !anonKey) {
    throw new Error(
      "Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY together. They are the public SUPABASE_URL and SUPABASE_ANON_KEY.",
    );
  }
  return { url, anonKey };
}

function first(...values: (string | undefined)[]): string {
  for (const value of values) {
    const trimmed = value?.trim() ?? "";
    if (trimmed) return trimmed;
  }
  return "";
}
