import { readStoredAuthProvider, type HumanAuthProvider } from "./supabase/oauth";

export const SANDBOX_SESSION_STORAGE_KEY = "roster.sandbox.session";

/** Sandbox API key kept in localStorage. Not a wallet and not valid for real payments. */
export interface SandboxSession {
  apiKey: string;
  /** Empty string for anonymous (unclaimed) sandbox orgs. */
  email: string;
  /** False until the human dismisses the one-time key panel. */
  revealed: boolean;
  /** How the human signed in. Absent on older browser sessions. Display only. */
  provider?: HumanAuthProvider;
}

export function parseSandboxSession(raw: string | null): SandboxSession | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value) || typeof value.apiKey !== "string" || value.apiKey.trim() === "") return null;
    if (typeof value.email !== "string") return null;
    const provider = readStoredAuthProvider(value.provider);
    return {
      apiKey: value.apiKey.trim(),
      email: value.email,
      revealed: value.revealed === true,
      ...(provider ? { provider } : {}),
    };
  } catch {
    return null;
  }
}

export function serializeSandboxSession(session: SandboxSession): string {
  return JSON.stringify({
    apiKey: session.apiKey.trim(),
    email: session.email,
    revealed: session.revealed,
    ...(session.provider ? { provider: session.provider } : {}),
  });
}

export function readBrowserSession(): SandboxSession | null {
  if (typeof window === "undefined") return null;
  return parseSandboxSession(window.localStorage.getItem(SANDBOX_SESSION_STORAGE_KEY));
}

export function writeBrowserSession(session: SandboxSession): void {
  window.localStorage.setItem(SANDBOX_SESSION_STORAGE_KEY, serializeSandboxSession(session));
}

export function clearBrowserSession(): void {
  window.localStorage.removeItem(SANDBOX_SESSION_STORAGE_KEY);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
