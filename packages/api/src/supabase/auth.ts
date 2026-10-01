import type { SupabaseClient } from "@supabase/supabase-js";

export interface SupabaseIdentity {
  id: string;
  email: string;
  /** Label only. Not used for authorization. user_metadata is user-editable. */
  displayName: string | null;
}

/**
 * Validates a Supabase access token.
 * `user.id` and `user.email` come from Auth. The display name is a label
 * taken from user_metadata and is never used in RLS or as an authorization claim.
 */
export async function verifySupabaseAccessToken(
  client: SupabaseClient,
  accessToken: string,
): Promise<SupabaseIdentity | null> {
  const { data, error } = await client.auth.getUser(accessToken);
  if (error || !data.user) return null;
  return {
    id: data.user.id,
    email: data.user.email ?? "",
    displayName: readDisplayName(data.user.user_metadata),
  };
}

function readDisplayName(metadata: unknown): string | null {
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) return null;
  const record = metadata as Record<string, unknown>;
  const fullName = record.full_name;
  if (typeof fullName === "string" && fullName.trim() !== "") return fullName.trim();
  const name = record.name;
  if (typeof name === "string" && name.trim() !== "") return name.trim();
  return null;
}
