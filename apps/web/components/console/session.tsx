"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  clearBrowserSession,
  readBrowserSession,
  writeBrowserSession,
  type SandboxSession,
} from "@/lib/session";
import { beginSupabaseSignOut } from "@/lib/supabase/browser";

interface SessionValue {
  session: SandboxSession | null;
  ready: boolean;
  /** True while a Supabase cookie session is being restored into the sandbox key. */
  linking: boolean;
  save: (session: SandboxSession) => void;
  acknowledge: () => void;
  clear: () => void;
  setLinking: (linking: boolean) => void;
}

const SessionContext = createContext<SessionValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<SandboxSession | null>(null);
  const [ready, setReady] = useState(false);
  const [linking, setLinkingState] = useState(true);

  useEffect(() => {
    setSession(readBrowserSession());
    setReady(true);
  }, []);

  const save = useCallback((next: SandboxSession) => {
    writeBrowserSession(next);
    setSession(next);
  }, []);

  const acknowledge = useCallback(() => {
    setSession((current) => {
      if (!current) return current;
      const next = { ...current, revealed: true };
      writeBrowserSession(next);
      return next;
    });
  }, []);

  const setLinking = useCallback((next: boolean) => {
    setLinkingState(next);
  }, []);

  const clear = useCallback(() => {
    beginSupabaseSignOut();
    clearBrowserSession();
    setLinkingState(true);
    setSession(null);
  }, []);

  const value = useMemo<SessionValue>(
    () => ({
      session,
      ready,
      linking,
      save,
      acknowledge,
      clear,
      setLinking,
    }),
    [acknowledge, clear, linking, ready, save, session, setLinking],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSandboxSession(): SessionValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error("Sandbox session is only available inside the console.");
  return value;
}
