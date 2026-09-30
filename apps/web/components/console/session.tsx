"use client";

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  clearBrowserSession,
  readBrowserSession,
  writeBrowserSession,
  type SandboxSession,
} from "@/lib/session";

interface SessionValue {
  session: SandboxSession | null;
  ready: boolean;
  save: (session: SandboxSession) => void;
  acknowledge: () => void;
  clear: () => void;
}

const SessionContext = createContext<SessionValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<SandboxSession | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setSession(readBrowserSession());
    setReady(true);
  }, []);

  const value = useMemo<SessionValue>(
    () => ({
      session,
      ready,
      save(next) {
        writeBrowserSession(next);
        setSession(next);
      },
      acknowledge() {
        setSession((current) => {
          if (!current) return current;
          const next = { ...current, revealed: true };
          writeBrowserSession(next);
          return next;
        });
      },
      clear() {
        clearBrowserSession();
        setSession(null);
      },
    }),
    [ready, session],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSandboxSession(): SessionValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error("Sandbox session is only available inside the console.");
  return value;
}
