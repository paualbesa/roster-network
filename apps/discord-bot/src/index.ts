import { Client, Events, GatewayIntentBits, ActivityType, REST, Routes } from "discord.js";
import { APP_ID, GUILD_ID, GENERAL_CHANNEL_ID, resolveChannels, requireToken, STATE_FILE } from "./config.js";
import { handleRosterCommand, rosterCommand } from "./commands.js";
import { announceEmbed } from "./embeds.js";
import { createPollers } from "./pollers.js";
import { setupChannels } from "./setup-channels.js";

async function main(): Promise<void> {
  if (process.argv.includes("--setup-channels")) {
    const ids = await setupChannels();
    if (Object.keys(ids).length === 0) {
      console.log(`Fallback general channel: ${GENERAL_CHANNEL_ID}`);
    }
    return;
  }

  const token = requireToken();
  const channels = resolveChannels();
  const client = new Client({
    intents: [GatewayIntentBits.Guilds],
  });

  const rest = new REST({ version: "10" }).setToken(token);
  await rest.put(Routes.applicationGuildCommands(APP_ID, GUILD_ID), {
    body: [rosterCommand.toJSON()],
  });

  client.once(Events.ClientReady, async (ready) => {
    console.log(`Rosty online as ${ready.user.tag}`);
    await ready.user.setPresence({
      status: "online",
      activities: [{ name: "roster.network", type: ActivityType.Watching }],
    });
    const pollers = createPollers(ready, channels, STATE_FILE);
    await pollers.start();

    try {
      const ch =
        ready.channels.cache.get(channels.announce) ?? (await ready.channels.fetch(channels.announce));
      if (ch && ch.isTextBased() && "send" in ch) {
        await ch.send({
          embeds: [
            announceEmbed(
              "Rosty is online — watching roster.network. Feeds: listings, transactions, demand, leaderboard, status.",
              "Rosty",
            ),
          ],
        });
      }
    } catch (error) {
      console.warn("hello post failed", error);
    }
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName !== "roster") return;
    await handleRosterCommand(interaction, channels, client);
  });

  await client.login(token);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
