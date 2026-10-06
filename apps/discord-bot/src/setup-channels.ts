import {
  ChannelType,
  Client,
  GatewayIntentBits,
  PermissionFlagsBits,
} from "discord.js";
import { CATEGORY_ID, GUILD_ID, requireToken } from "./config.js";

const WANTED: { key: string; name: string; topic: string }[] = [
  { key: "ROSTY_CH_ANNOUNCE", name: "📢-anuncis", topic: "Roster announcements" },
  { key: "ROSTY_CH_LISTINGS", name: "🆕-nous-listings", topic: "New listings and data products" },
  { key: "ROSTY_CH_TX", name: "💸-transaccions", topic: "Released sandbox jobs (honest, throttled)" },
  { key: "ROSTY_CH_DEMAND", name: "📈-demanda", topic: "Daily unmet needs" },
  { key: "ROSTY_CH_LEADERBOARD", name: "🏆-leaderboard", topic: "Weekly top sellers" },
  { key: "ROSTY_CH_STATUS", name: "🔧-status", topic: "API health and deploys" },
];

export async function setupChannels(): Promise<Record<string, string>> {
  const token = requireToken();
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  await client.login(token);
  await new Promise<void>((resolve) => client.once("ready", () => resolve()));

  const guild = await client.guilds.fetch(GUILD_ID);
  const me = guild.members.me ?? (await guild.members.fetchMe());
  if (!me.permissions.has(PermissionFlagsBits.ManageChannels)) {
    console.error("Bot lacks Manage Channels — using general channel for all feeds.");
    await client.destroy();
    return {};
  }

  const existing = await guild.channels.fetch();
  const ids: Record<string, string> = {};
  for (const want of WANTED) {
    const found = existing.find((ch) => ch?.name === want.name && ch.parentId === CATEGORY_ID);
    if (found) {
      ids[want.key] = found.id;
      console.log(`${want.key}=${found.id} (exists ${want.name})`);
      continue;
    }
    const created = await guild.channels.create({
      name: want.name,
      type: ChannelType.GuildText,
      parent: CATEGORY_ID,
      topic: want.topic,
      reason: "Rosty setup-channels",
    });
    ids[want.key] = created.id;
    console.log(`${want.key}=${created.id} (created ${want.name})`);
  }
  await client.destroy();
  return ids;
}
