import {
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type Client,
} from "discord.js";
import { fetchHealth, fetchOverviewStats, postNeed } from "./api.js";
import type { RostyChannels } from "./config.js";
import { announceEmbed, needMatchEmbed, statusEmbed } from "./embeds.js";

export const rosterCommand = new SlashCommandBuilder()
  .setName("roster")
  .setDescription("Roster network helpers")
  .addSubcommand((sub) =>
    sub
      .setName("need")
      .setDescription("Match a need against the registry")
      .addStringOption((opt) => opt.setName("text").setDescription("What you need").setRequired(true)),
  )
  .addSubcommand((sub) => sub.setName("status").setDescription("API health"))
  .addSubcommand((sub) => sub.setName("stats").setDescription("Sandbox stats snapshot"))
  .addSubcommand((sub) =>
    sub
      .setName("announce")
      .setDescription("Post an announcement (operators)")
      .addStringOption((opt) => opt.setName("message").setDescription("Announcement text").setRequired(true)),
  );

export async function handleRosterCommand(
  interaction: ChatInputCommandInteraction,
  channels: RostyChannels,
  client: Client,
): Promise<void> {
  const sub = interaction.options.getSubcommand();
  if (sub === "need") {
    const text = interaction.options.getString("text", true);
    await interaction.deferReply();
    try {
      const body = await postNeed(text);
      const raw = body.matches ?? body.hits ?? [];
      const matches = raw.map((row) => {
        const listing = "listing" in row && row.listing ? row.listing : null;
        return {
          id: listing?.id ?? "unknown",
          name: listing?.name ?? "listing",
          score: row.score,
          priceUsdc: listing?.pricing?.amountUsdc,
        };
      });
      await interaction.editReply({ embeds: [needMatchEmbed(text, matches)] });
    } catch (error) {
      await interaction.editReply(error instanceof Error ? error.message : "need failed");
    }
    return;
  }
  if (sub === "status") {
    await interaction.deferReply();
    try {
      const health = await fetchHealth();
      await interaction.editReply({
        embeds: [statusEmbed({ ok: health.ok, version: health.version ?? null })],
      });
    } catch (error) {
      await interaction.editReply({
        embeds: [statusEmbed({ ok: false, detail: error instanceof Error ? error.message : "down" })],
      });
    }
    return;
  }
  if (sub === "stats") {
    await interaction.deferReply();
    try {
      const stats = await fetchOverviewStats();
      const lines = [
        `version: \`${stats.health?.version ?? "—"}\``,
        `listings: ${stats.counts?.listings ?? "—"}`,
        `released jobs: ${stats.counts?.jobs?.released ?? "—"}`,
        `GMV released: ${stats.gmv?.releasedUsdc ?? "—"} USDC`,
        `accounts: ${stats.counts?.accounts ?? "—"}`,
      ];
      await interaction.editReply(lines.join("\n"));
    } catch (error) {
      await interaction.editReply(error instanceof Error ? error.message : "stats failed");
    }
    return;
  }
  if (sub === "announce") {
    const message = interaction.options.getString("message", true);
    await interaction.deferReply({ ephemeral: true });
    try {
      const ch =
        client.channels.cache.get(channels.announce) ?? (await client.channels.fetch(channels.announce));
      if (!ch || !ch.isTextBased() || !("send" in ch)) {
        await interaction.editReply("Announce channel unavailable.");
        return;
      }
      await ch.send({
        embeds: [announceEmbed(message, interaction.user.displayName)],
      });
      await interaction.editReply("Posted.");
    } catch (error) {
      await interaction.editReply(error instanceof Error ? error.message : "announce failed");
    }
  }
}
