import { EmbedBuilder } from "discord.js";
import { ROSTER_PUBLIC_BASE } from "./config.js";

/** Roster dark / brass palette. */
export const ROSTER_BRASS = 0xc4a36a;
export const ROSTER_INK = 0x0e1110;
export const ROSTER_SAGE = 0x9db5a4;
export const ROSTER_ALERT = 0xb85c38;

export function listingEmbed(input: {
  name: string;
  kind: string;
  priceUsdc: string;
  seller: string;
  id: string;
}): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(ROSTER_BRASS)
    .setTitle(input.name)
    .setURL(`${ROSTER_PUBLIC_BASE}/listings/${input.id}`)
    .setDescription(`New ${input.kind} on Roster`)
    .addFields(
      { name: "Price", value: `${input.priceUsdc} USDC`, inline: true },
      { name: "Seller", value: input.seller || "—", inline: true },
      { name: "Kind", value: input.kind, inline: true },
    )
    .setFooter({ text: "roster.network · #nous-listings" })
    .setTimestamp(new Date());
}

export function txEmbed(input: {
  product: string;
  amountUsdc: string;
  seller: string;
  latencyMs: number | null;
  sandbox: boolean;
  summary?: boolean;
  fleetCount?: number;
  explorerUrl?: string | null;
  vaultExplorerUrl?: string | null;
  programExplorerUrl?: string | null;
  railLabel?: string | null;
  chain?: string | null;
}): EmbedBuilder {
  const title = input.summary
    ? `Fleet loop · ${input.fleetCount ?? 0} jobs`
    : input.product;
  const isDevnet = input.chain === "solana-devnet" || (input.railLabel ?? "").includes("devnet");
  const rail = input.railLabel ?? (isDevnet ? "solana-devnet · test SPL" : input.sandbox ? "sandbox · mock USDC" : "live");
  const embed = new EmbedBuilder()
    .setColor(ROSTER_SAGE)
    .setTitle(title.slice(0, 256))
    .addFields(
      { name: "Amount", value: `${input.amountUsdc} USDC`, inline: true },
      { name: "Seller", value: input.seller || "—", inline: true },
      {
        name: "Latency",
        value: input.latencyMs != null ? `${input.latencyMs} ms` : "—",
        inline: true,
      },
    )
    .setFooter({ text: `${rail} · #transaccions` })
    .setTimestamp(new Date());
  const lines: string[] = [];
  if (isDevnet) lines.push("**devnet** settlement");
  else if (input.sandbox) lines.push("sandbox");
  if (input.explorerUrl) lines.push(`[TX on Solana Explorer (devnet)](${input.explorerUrl})`);
  if (input.vaultExplorerUrl) lines.push(`[Vault PDA (devnet)](${input.vaultExplorerUrl})`);
  if (input.programExplorerUrl) lines.push(`[Escrow program (devnet)](${input.programExplorerUrl})`);
  if (lines.length) embed.setDescription(lines.join("\n"));
  return embed;
}

export function demandEmbed(rows: { need: string; count: number; estimateUsdc?: string }[]): EmbedBuilder {
  const lines =
    rows.length === 0
      ? "_No unmet needs right now._"
      : rows
          .slice(0, 10)
          .map((row, i) => {
            const est = row.estimateUsdc ? ` · ~${row.estimateUsdc} USDC` : "";
            return `**${i + 1}.** ${row.need.slice(0, 120)} _(×${row.count}${est})_`;
          })
          .join("\n");
  return new EmbedBuilder()
    .setColor(ROSTER_BRASS)
    .setTitle("Top unmet demand")
    .setDescription(`${lines}\n\n[Publish on /sell](${ROSTER_PUBLIC_BASE}/sell)`)
    .setFooter({ text: "roster.network · #demanda" })
    .setTimestamp(new Date());
}

export function leaderboardEmbed(rows: { seller: string; amountUsdc: string; jobs: number }[]): EmbedBuilder {
  const lines =
    rows.length === 0
      ? "_No released jobs this week._"
      : rows
          .slice(0, 10)
          .map((row, i) => `**${i + 1}.** ${row.seller} — ${row.amountUsdc} USDC (${row.jobs} jobs)`)
          .join("\n");
  return new EmbedBuilder()
    .setColor(ROSTER_BRASS)
    .setTitle("Weekly top sellers")
    .setDescription(lines)
    .setFooter({ text: "roster.network · #leaderboard" })
    .setTimestamp(new Date());
}

export function statusEmbed(input: {
  ok: boolean;
  version?: string | null;
  previousVersion?: string | null;
  detail?: string;
}): EmbedBuilder {
  const up = input.ok;
  const embed = new EmbedBuilder()
    .setColor(up ? ROSTER_SAGE : ROSTER_ALERT)
    .setTitle(up ? "API up" : "API down")
    .setFooter({ text: "roster.network · #status" })
    .setTimestamp(new Date());
  if (input.version) embed.addFields({ name: "Version", value: input.version, inline: true });
  if (input.previousVersion && input.previousVersion !== input.version) {
    embed.addFields({ name: "Previous", value: input.previousVersion, inline: true });
  }
  if (input.detail) embed.setDescription(input.detail);
  return embed;
}

export function announceEmbed(text: string, author?: string): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(ROSTER_BRASS)
    .setTitle("Announcement")
    .setDescription(text.slice(0, 4000))
    .setFooter({ text: author ? `— ${author}` : "roster.network · #anuncis" })
    .setTimestamp(new Date());
}

export function needMatchEmbed(
  need: string,
  matches: { id: string; name: string; score?: number; priceUsdc?: string }[],
): EmbedBuilder {
  const lines =
    matches.length === 0
      ? "_No strong matches. Try publishing on /sell._"
      : matches
          .slice(0, 5)
          .map((m) => {
            const price = m.priceUsdc ? ` · ${m.priceUsdc} USDC` : "";
            const score = m.score != null ? ` · score ${m.score.toFixed(2)}` : "";
            return `• [${m.name}](${ROSTER_PUBLIC_BASE}/listings/${m.id})${price}${score}`;
          })
          .join("\n");
  return new EmbedBuilder()
    .setColor(ROSTER_BRASS)
    .setTitle("Need matches")
    .setDescription(`**${need.slice(0, 200)}**\n\n${lines}`)
    .setFooter({ text: "roster.network · /roster need" })
    .setTimestamp(new Date());
}
