"use client";

import Link from "next/link";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import {
  createRosterClient,
  rosterErrorMessage,
  type AccountSnapshot,
  type ConsoleAgent,
  type TreasurySnapshot,
} from "@/lib/roster-client";
import { isPositiveUsdc } from "@/lib/usdc";
import { ApiKeyPanel } from "./api-key-panel";
import { RequireSession } from "./require-session";
import { useSandboxSession } from "./session";
import { ConsolePage, StatusLine, buttonClass, fieldClass } from "./ui";

export function Dashboard() {
  return (
    <ConsolePage
      eyebrow="Dashboard"
      title="Treasury, then a buyer agent."
      lede="Sandbox mode grants mock USDC to the organization treasury. Move some of it onto a buyer before you hire. Create a second agent if you want to bind a seller on your own listings."
    >
      <RequireSession>
        <DashboardBody />
      </RequireSession>
    </ConsolePage>
  );
}

function DashboardBody() {
  const { session, acknowledge } = useSandboxSession();
  const [account, setAccount] = useState<AccountSnapshot | null>(null);
  const [treasury, setTreasury] = useState<TreasurySnapshot | null>(null);
  const [agents, setAgents] = useState<ConsoleAgent[]>([]);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const reload = useCallback(async () => {
    if (!session) return;
    const client = createRosterClient({ apiKey: session.apiKey });
    const [nextAccount, nextTreasury, nextAgents] = await Promise.all([
      client.account(),
      client.treasury(),
      client.listAgents(),
    ]);
    setAccount(nextAccount);
    setTreasury(nextTreasury);
    setAgents(nextAgents);
  }, [session]);

  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    setLoading(true);
    setError("");
    void reload()
      .catch((cause: unknown) => {
        if (!cancelled) setError(rosterErrorMessage(cause));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [reload, session]);

  async function onCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!session) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    const name = String(data.get("name") ?? "").trim();
    const dailySpendLimitUsdc = String(data.get("dailySpendLimitUsdc") ?? "").trim();
    const fundAmount = String(data.get("fundAmount") ?? "").trim();
    if (!name) {
      setError("Name the agent.");
      return;
    }
    if (!isPositiveUsdc(dailySpendLimitUsdc)) {
      setError("Daily spend limit must be a positive USDC amount.");
      return;
    }
    if (fundAmount && !isPositiveUsdc(fundAmount)) {
      setError("Fund amount must be a positive USDC amount, or leave it blank.");
      return;
    }
    setPending(true);
    setError("");
    setNotice("");
    const client = createRosterClient({ apiKey: session.apiKey });
    try {
      const agent = await client.createAgent({ name, dailySpendLimitUsdc });
      if (fundAmount) {
        try {
          await client.fundAgent(agent.id, fundAmount);
        } catch (cause) {
          setNotice(`${rosterErrorMessage(cause)} The agent was still created.`);
          await reload();
          return;
        }
      }
      form.reset();
      setNotice(`${agent.name} is ready${fundAmount ? " and funded from treasury" : ""}.`);
      await reload();
    } catch (cause) {
      setError(rosterErrorMessage(cause));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
      <div className="flex flex-col gap-8">
        {session && !session.revealed ? <ApiKeyPanel apiKey={session.apiKey} onHide={acknowledge} /> : null}
        <section className="border border-line/10 bg-panel" aria-labelledby="treasury-title">
          <div className="border-b border-line/10 px-5 py-4">
            <p id="treasury-title" className="font-mono text-[11px] tracking-[0.18em] text-muted uppercase">
              Treasury
            </p>
            <p className="mt-3 font-serif text-4xl tracking-[-0.03em] text-paper">
              {loading ? "…" : treasury ? `${treasury.balanceUsdc} USDC` : "—"}
            </p>
            <p className="mt-2 text-sm leading-6 text-muted">
              {account ? `${account.displayName} · ${account.email}` : "Sandbox organization"}
            </p>
            {treasury?.address ? (
              <p className="mt-2 font-mono text-xs break-all text-muted">{treasury.address}</p>
            ) : null}
          </div>
          <p className="px-5 py-4 text-sm leading-6 text-muted">
            Mock USDC only. Funding an agent moves balance inside the sandbox ledger. It does not touch a bank or a chain.
          </p>
        </section>

        <section aria-labelledby="agents-title">
          <h2 id="agents-title" className="font-serif text-3xl tracking-[-0.03em]">
            Agents
          </h2>
          {loading ? <p className="mt-4 text-sm text-muted">Loading agents…</p> : null}
          {!loading && agents.length === 0 ? (
            <p className="mt-4 text-sm leading-6 text-muted">No agents yet. Create a buyer, fund it, then open the marketplace.</p>
          ) : null}
          {agents.length > 0 ? (
            <ul className="mt-4 divide-y divide-line/10 border-y border-line/10">
              {agents.map((agent) => (
                <li key={agent.id} className="grid gap-2 py-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-baseline">
                  <div>
                    <p className="text-paper">
                      {agent.name}{" "}
                      <span className="font-mono text-xs text-muted">{agent.status}</span>
                    </p>
                    <p className="mt-1 font-mono text-xs break-all text-muted">{agent.id}</p>
                  </div>
                  <p className="font-mono text-sm text-brass">{agent.balanceUsdc} USDC</p>
                </li>
              ))}
            </ul>
          ) : null}
          {error ? (
            <div className="mt-4">
              <StatusLine tone="error">{error}</StatusLine>
            </div>
          ) : null}
          {notice ? (
            <div className="mt-4">
              <StatusLine tone="ok">{notice}</StatusLine>
            </div>
          ) : null}
        </section>
      </div>

      <form onSubmit={onCreate} className="flex h-fit flex-col gap-4 border border-line/10 bg-panel p-6">
        <h2 className="font-serif text-3xl tracking-[-0.03em]">Create an agent</h2>
        <div className="flex flex-col gap-2">
          <label htmlFor="agent-name" className="text-sm text-paper">
            Name
          </label>
          <input id="agent-name" name="name" required maxLength={80} placeholder="buyer" className={fieldClass} />
        </div>
        <div className="flex flex-col gap-2">
          <label htmlFor="daily-limit" className="text-sm text-paper">
            Daily spend limit (USDC)
          </label>
          <input
            id="daily-limit"
            name="dailySpendLimitUsdc"
            required
            inputMode="decimal"
            defaultValue="10.00"
            className={fieldClass}
          />
        </div>
        <div className="flex flex-col gap-2">
          <label htmlFor="fund-amount" className="text-sm text-paper">
            Fund from treasury <span className="text-muted">(optional)</span>
          </label>
          <input id="fund-amount" name="fundAmount" inputMode="decimal" placeholder="5.00" className={fieldClass} />
        </div>
        <button type="submit" className={buttonClass} disabled={pending || !session}>
          {pending ? "Saving…" : "Create agent"}
        </button>
        <p className="text-xs leading-5 text-muted">
          Next:{" "}
          <Link href="/console/marketplace" className="text-brass underline decoration-brass/40 underline-offset-4">
            search the marketplace
          </Link>
          .
        </p>
      </form>
    </div>
  );
}
