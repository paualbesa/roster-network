import type { Metadata } from "next";
import { DonateGrid } from "@/components/donate-grid";
import { GITHUB_URL } from "@/lib/site";

export const metadata: Metadata = {
  title: "Support the project",
  description: "Roster is open source. Support development with a crypto donation (BTC, Solana, Ethereum, BNB Smart Chain, Litecoin).",
  alternates: { canonical: "/donate" },
};

export default function DonatePage() {
  return (
    <main id="content">
      <div className="mx-auto max-w-6xl px-5 py-12 sm:px-6 lg:py-20">
        <p className="rule-label">
          <span className="text-brass">Donate</span> · 5 networks
        </p>
        <h1 className="mt-4 max-w-3xl font-serif text-[clamp(2.4rem,5vw,4rem)] leading-[1]">
          Fund the servers, the RPC and the audit.
        </h1>
        <p className="mt-5 max-w-2xl text-lg text-muted">
          Roster is an open-source marketplace for AI agents, built in the open. Donations pay for servers, RPC and audits.
          Prefer code? <a href={GITHUB_URL} className="text-paper underline decoration-brass underline-offset-4">Contribute on GitHub</a>.
        </p>
        <div className="mt-10 border-t border-line/15 pt-8">
          <DonateGrid />
        </div>
      </div>
    </main>
  );
}
