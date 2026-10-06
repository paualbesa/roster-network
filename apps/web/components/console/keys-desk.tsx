"use client";

import Link from "next/link";
import { useMemo, useState, type FormEvent } from "react";
import {
  mcpConfigJson,
  mcpPlainBlock,
  mcpRemoteCard,
  sdkSnippetCurl,
  sdkSnippetPython,
  sdkSnippetTs,
  type McpHost,
} from "@/lib/mcp-snippets";
import { createRosterClient, rosterErrorMessage } from "@/lib/roster-client";
import { RequireSession } from "./require-session";
import { useSandboxSession } from "./session";
import { ConsolePage, StatusLine, buttonClass, fieldClass, ghostClass } from "./ui";

export function KeysDesk() {
  return (
    <RequireSession>
      <KeysDeskInner />
    </RequireSession>
  );
}

function KeysDeskInner() {
  const { session, save, acknowledge, clear } = useSandboxSession();
  const apiKey = session?.apiKey ?? "";
  const [freshKey, setFreshKey] = useState<string | null>(session?.revealed === false ? apiKey : null);
  const [copied, setCopied] = useState("");
  const [host, setHost] = useState<McpHost>("cursor");
  const [showJson, setShowJson] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [pending, setPending] = useState(false);
  const [needQuery, setNeedQuery] = useState("EUR to USD exchange rate history");
  const [needResult, setNeedResult] = useState("");
  const [claimEmail, setClaimEmail] = useState("");
  const [claimPassword, setClaimPassword] = useState("");

  const displayKey = freshKey ?? apiKey;
  const card = useMemo(() => mcpRemoteCard(displayKey), [displayKey]);
  const plain = useMemo(() => mcpPlainBlock(displayKey), [displayKey]);
  const mcpJson = useMemo(() => mcpConfigJson(displayKey, host), [displayKey, host]);

  async function copy(label: string, value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(label);
    } catch {
      setCopied("");
    }
  }

  async function rotate() {
    if (!session) return;
    setPending(true);
    setError("");
    setNote("");
    try {
      const { apiKey: next } = await createRosterClient({ apiKey: session.apiKey }).rotateKey();
      save({ ...session, apiKey: next, revealed: false });
      setFreshKey(next);
      setNote("New key issued. Update your MCP Authorization header. The previous key no longer works.");
    } catch (cause) {
      setError(rosterErrorMessage(cause));
    } finally {
      setPending(false);
    }
  }

  async function revoke() {
    if (!session) return;
    setPending(true);
    setError("");
    try {
      await createRosterClient({ apiKey: session.apiKey }).revokeKey();
      clear();
    } catch (cause) {
      setError(rosterErrorMessage(cause));
      setPending(false);
    }
  }

  async function claim(event: FormEvent) {
    event.preventDefault();
    if (!session) return;
    setPending(true);
    setError("");
    setNote("");
    try {
      const claimed = await createRosterClient({ apiKey: session.apiKey }).claim({
        email: claimEmail,
        password: claimPassword,
      });
      save({ apiKey: claimed.apiKey, email: claimed.email, revealed: false, provider: "email" });
      setFreshKey(claimed.apiKey);
      setNote("Email attached. A new key was issued — copy the MCP block again.");
    } catch (cause) {
      setError(rosterErrorMessage(cause));
    } finally {
      setPending(false);
    }
  }

  async function runNeed() {
    if (!session) return;
    setPending(true);
    setError("");
    setNeedResult("");
    try {
      const result = await createRosterClient({ apiKey: session.apiKey }).need({ need: needQuery.trim() });
      const top = result.matches[0];
      setNeedResult(
        top
          ? `${top.name} (${top.priceUsdc} USDC)`
          : result.unmetMessage
            ? result.unmetMessage
            : "No matches.",
      );
    } catch (cause) {
      setError(rosterErrorMessage(cause));
    } finally {
      setPending(false);
    }
  }

  const isAnonymous = !session?.email || session.provider === "anonymous";

  return (
    <ConsolePage
      eyebrow="Connect"
      title="Your remote MCP."
      lede="Paste this into Claude Desktop, Cursor, or any MCP client. Roster authenticates with your sandbox bearer key."
    >
      <section className="border border-brass/40 bg-brass/10 p-6 md:p-8" aria-labelledby="mcp-heading">
        <h2 id="mcp-heading" className="font-mono text-[11px] tracking-[0.18em] text-brass uppercase">
          MCP
        </h2>
        <dl className="mt-5 space-y-4 font-mono text-sm text-paper">
          <div>
            <dt className="text-muted">URL</dt>
            <dd className="mt-1 break-all">{card.url}</dd>
          </div>
          <div>
            <dt className="text-muted">Header</dt>
            <dd className="mt-1">{card.header}</dd>
          </div>
          <div>
            <dt className="text-muted">Value</dt>
            <dd className="mt-1 break-all">{card.value}</dd>
          </div>
        </dl>
        <div className="mt-6 flex flex-wrap gap-3">
          <button type="button" className={buttonClass} onClick={() => void copy("plain", plain)}>
            {copied === "plain" ? "Copied" : "Copy MCP block"}
          </button>
          <button type="button" className={ghostClass} onClick={() => void copy("value", card.value)}>
            {copied === "value" ? "Copied" : "Copy Authorization value"}
          </button>
          {freshKey ? (
            <button
              type="button"
              className={ghostClass}
              onClick={() => {
                acknowledge();
                setFreshKey(null);
              }}
            >
              Done
            </button>
          ) : null}
        </div>
        {freshKey ? (
          <p className="mt-4 text-xs leading-5 text-muted">
            New key — copy the block now. The server only stores a hash.
          </p>
        ) : null}
      </section>

      <div className="mt-6">
        <button type="button" className="text-sm text-brass hover:underline" onClick={() => setShowJson((v) => !v)}>
          {showJson ? "Hide" : "Show"} Claude Desktop / Cursor JSON
        </button>
        {showJson ? (
          <div className="mt-4 border border-line/10 bg-panel p-5">
            <div className="flex flex-wrap gap-2">
              {(
                [
                  ["cursor", "Cursor"],
                  ["claude-desktop", "Claude Desktop"],
                  ["generic", "Generic"],
                ] as const
              ).map(([id, label]) => (
                <button key={id} type="button" className={host === id ? buttonClass : ghostClass} onClick={() => setHost(id)}>
                  {label}
                </button>
              ))}
            </div>
            <pre className="mt-4 max-h-64 overflow-auto border border-line/10 bg-ink p-3 font-mono text-xs leading-5 text-paper whitespace-pre-wrap">
              {mcpJson}
            </pre>
            <button type="button" className={`${ghostClass} mt-3`} onClick={() => void copy("json", mcpJson)}>
              {copied === "json" ? "Copied" : "Copy JSON"}
            </button>
          </div>
        ) : null}
      </div>

      <div className="mt-8 border border-line/10 bg-panel p-6">
        <p className="font-mono text-[11px] tracking-[0.18em] text-brass uppercase">Try it</p>
        <p className="mt-3 text-sm text-muted">Runs a live <code className="text-paper">need</code> against the sandbox.</p>
        <div className="mt-4 flex flex-col gap-3 sm:flex-row">
          <input className={fieldClass} value={needQuery} onChange={(e) => setNeedQuery(e.target.value)} aria-label="Need query" />
          <button type="button" className={buttonClass} disabled={pending || !needQuery.trim()} onClick={() => void runNeed()}>
            {pending ? "Calling…" : "Make your first call"}
          </button>
        </div>
        {needResult ? <div className="mt-3"><StatusLine tone="ok">{needResult}</StatusLine></div> : null}
      </div>

      {isAnonymous ? (
        <form onSubmit={claim} className="mt-8 flex flex-col gap-3 border border-line/10 bg-panel p-6">
          <p className="text-sm text-paper">Optional: claim with email</p>
          <input type="email" required maxLength={254} placeholder="ada@example.com" className={fieldClass} value={claimEmail} onChange={(e) => setClaimEmail(e.target.value)} />
          <input type="password" required minLength={8} maxLength={128} placeholder="Password" className={fieldClass} value={claimPassword} onChange={(e) => setClaimPassword(e.target.value)} />
          <button type="submit" className={ghostClass} disabled={pending}>Claim account</button>
        </form>
      ) : null}

      <div className="mt-8">
        <button type="button" className="text-sm text-muted hover:text-brass" onClick={() => setAdvanced((v) => !v)}>
          {advanced ? "Hide advanced" : "Advanced (API key, SDK, rotate)"}
        </button>
        {advanced ? (
          <div className="mt-4 space-y-4 border border-line/10 bg-panel p-6">
            <div>
              <p className="text-sm text-paper">Raw API key</p>
              <input readOnly value={displayKey} className="mt-2 min-h-12 w-full border border-line/15 bg-ink px-3 font-mono text-xs text-paper" onFocus={(e) => e.currentTarget.select()} />
              <div className="mt-3 flex flex-wrap gap-3">
                <button type="button" className={ghostClass} onClick={() => void copy("key", displayKey)}>
                  {copied === "key" ? "Copied" : "Copy key"}
                </button>
                <button type="button" className={ghostClass} disabled={pending} onClick={() => void rotate()}>
                  Rotate
                </button>
                <button type="button" className={ghostClass} disabled={pending} onClick={() => void revoke()}>
                  Revoke
                </button>
              </div>
            </div>
            <pre className="max-h-40 overflow-auto border border-line/10 bg-ink p-3 font-mono text-[11px] text-paper whitespace-pre-wrap">{sdkSnippetTs(displayKey)}</pre>
            <pre className="max-h-32 overflow-auto border border-line/10 bg-ink p-3 font-mono text-[11px] text-paper whitespace-pre-wrap">{sdkSnippetCurl(displayKey)}</pre>
            <pre className="max-h-32 overflow-auto border border-line/10 bg-ink p-3 font-mono text-[11px] text-paper whitespace-pre-wrap">{sdkSnippetPython(displayKey)}</pre>
            <p className="text-sm text-muted">
              <Link href="/console/dashboard" className="text-brass underline decoration-brass/40 underline-offset-4">Dashboard</Link>
              {" · "}
              <Link href="/console/marketplace" className="text-brass underline decoration-brass/40 underline-offset-4">Marketplace</Link>
            </p>
          </div>
        ) : null}
      </div>

      {note ? <div className="mt-6"><StatusLine tone="ok">{note}</StatusLine></div> : null}
      {error ? <div className="mt-6"><StatusLine tone="error">{error}</StatusLine></div> : null}
    </ConsolePage>
  );
}
