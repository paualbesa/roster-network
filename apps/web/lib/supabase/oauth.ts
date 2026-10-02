/** GitHub and Google are the human console providers. Agents stay on API keys. */
export const HUMAN_OAUTH_PROVIDERS = ["github", "google"] as const;

export type HumanOAuthProvider = (typeof HUMAN_OAUTH_PROVIDERS)[number];

/** Stored only as a label on the sandbox session. Not an authorization claim. */
export type HumanAuthProvider = HumanOAuthProvider | "email";

export interface AuthUserLike {
  app_metadata?: { provider?: unknown } | null;
  identities?: { provider?: string | null }[] | null;
}

export interface OAuthSignInRequest {
  provider: HumanOAuthProvider;
  options: { redirectTo: string };
}

export interface SignedInAccount {
  email: string;
  provider: HumanAuthProvider | null;
  providerLabel: string | null;
  headline: string;
}

const CONSOLE_NEXT = "/console";

/**
 * `redirectTo` for `signInWithOAuth`. The callback exchanges the code and
 * returns the browser to `/console`.
 */
export function oauthRedirectTo(origin: string): string {
  const trimmed = origin.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error("OAuth redirect needs an http(s) site origin.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("OAuth redirect needs an http(s) site origin.");
  }
  if (url.username !== "" || url.password !== "") {
    throw new Error("OAuth redirect origin cannot include credentials.");
  }
  return `${url.origin}/auth/callback?next=${encodeURIComponent(CONSOLE_NEXT)}`;
}

/** Arguments for `supabase.auth.signInWithOAuth`. Email is not an OAuth provider here. */
export function humanOAuthSignIn(provider: string, origin: string): OAuthSignInRequest {
  if (!isHumanOAuthProvider(provider)) {
    throw new Error("Humans sign in with GitHub or Google. Agents use an API key.");
  }
  return {
    provider,
    options: { redirectTo: oauthRedirectTo(origin) },
  };
}

export function isHumanOAuthProvider(value: string): value is HumanOAuthProvider {
  return value === "github" || value === "google";
}

/**
 * Provider label from Auth. `app_metadata.provider` is set by Supabase, not the user.
 * `user_metadata` is ignored because the user can edit it.
 */
export function readHumanAuthProvider(user: AuthUserLike | null | undefined): HumanAuthProvider | null {
  if (!user) return null;
  const fromApp = user.app_metadata?.provider;
  if (isHumanAuthProvider(fromApp)) return fromApp;
  const identity = user.identities?.find((item) => isHumanAuthProvider(item.provider));
  return identity && isHumanAuthProvider(identity.provider) ? identity.provider : null;
}

export function readStoredAuthProvider(value: unknown): HumanAuthProvider | undefined {
  return isHumanAuthProvider(value) ? value : undefined;
}

/** Keeps the OAuth `next` query on this site's console. */
export function safeConsoleNextPath(value: string | null): string {
  if (!value || !value.startsWith("/console")) return CONSOLE_NEXT;
  if (value.startsWith("//") || value.startsWith("/\\") || value.includes("\\")) return CONSOLE_NEXT;
  if (value.includes("\n") || value.includes("\r") || value.includes("\0")) return CONSOLE_NEXT;
  return value;
}

export function describeSignedInAccount(session: { email: string; provider?: string | null }): SignedInAccount {
  const email = session.email.trim();
  const provider = isHumanAuthProvider(session.provider) ? session.provider : null;
  const providerLabel = provider === null ? null : providerLabelFor(provider);
  const who = email || "this browser";
  const headline =
    provider === "github" || provider === "google" ? `Signed in as ${who} with ${providerLabel}` : `Signed in as ${who}`;
  return { email, provider, providerLabel, headline };
}

function providerLabelFor(provider: HumanAuthProvider): string {
  if (provider === "github") return "GitHub";
  if (provider === "google") return "Google";
  return "Email";
}

function isHumanAuthProvider(value: unknown): value is HumanAuthProvider {
  return value === "github" || value === "google" || value === "email";
}
