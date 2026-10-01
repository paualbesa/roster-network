import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import WebSocket from "ws";
import type { SupabaseConfig } from "./env.js";

/**
 * Node 20 has no global WebSocket. `createClient` always builds a RealtimeClient,
 * and realtime-js throws unless a transport is supplied. Job-status channels are
 * not subscribed yet; this only keeps roster-api from crashing on boot.
 *
 * `ws` is the constructor realtime-js accepts at runtime. The cast stays here
 * because that option is typed as realtime-js's own WebSocketLike constructor.
 */
type RealtimeTransport = NonNullable<
  NonNullable<NonNullable<Parameters<typeof createClient>[2]>["realtime"]>["transport"]
>;

const realtimeTransport = WebSocket as unknown as RealtimeTransport;

function clientOptions() {
  return {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    realtime: { transport: realtimeTransport },
  };
}

/** Service-role client. Bypasses RLS. Never import this from the web app. */
export function createServiceClient(config: SupabaseConfig): SupabaseClient {
  return createClient(config.url, config.serviceRoleKey, clientOptions());
}

/** Anon client used only to check a caller's access token. */
export function createAnonClient(config: SupabaseConfig): SupabaseClient {
  return createClient(config.url, config.anonKey, clientOptions());
}
