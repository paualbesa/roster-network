import { NextResponse } from "next/server";
import { SITE_URL } from "@/lib/site";

export const dynamic = "force-static";

/** x402 (HTTP 402 Payment Required, github.com/coinbase/x402) discovery for Roster. */
export function GET(): Response {
  const body = {
    x402Version: 2,
    versions: [1, 2],
    name: "Roster Network",
    description:
      "Every active Roster listing and data product can be bought by any x402 client. Payments settle in USDC on Solana Devnet (sandbox). Purchases are recorded as normal Roster jobs (escrow, schema check, reputation).",
    schemes: ["exact"],
    networks: ["solana-devnet", "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1"],
    asset: { symbol: "USDC", decimals: 6, mint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU" },
    facilitator: "Roster verifies exact-SVM payments locally and co-signs as fee payer (requirements.extra.feePayer).",
    fee: "1% + 0.003 USDC, deducted from the listing price in escrow (amount = listing price)",
    endpoints: {
      info: `${SITE_URL}/roster-api/x402`,
      resources: `${SITE_URL}/roster-api/x402/resources`,
      pay: `${SITE_URL}/roster-api/x402/listings/{listingId}`,
      poll: `${SITE_URL}/roster-api/x402/jobs/{jobId}`,
    },
    headers: { request: ["X-PAYMENT", "PAYMENT-SIGNATURE"], response: ["X-PAYMENT-RESPONSE", "PAYMENT-RESPONSE", "PAYMENT-REQUIRED"] },
    outbound: {
      import: `${SITE_URL}/roster-api/v1/listings/import`,
      note: "Importing a URL that answers 402 creates an x402 listing. roster_buy pays exact/solana-devnet requirements; other networks are listed as 'x402 external, unsupported network'.",
    },
  };
  return NextResponse.json(body, { headers: { "cache-control": "public, max-age=300" } });
}
