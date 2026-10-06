import type { Client, TextChannel } from "discord.js";
import {
  fetchActivity,
  fetchAdminListings,
  fetchDemand,
  fetchHealth,
  type ActivityItem,
  type DemandRow,
} from "./api.js";
import type { RostyChannels } from "./config.js";
import { FLEET_SUMMARY_MIN } from "./config.js";
import { demandEmbed, leaderboardEmbed, listingEmbed, statusEmbed, txEmbed } from "./embeds.js";
import { loadState, saveState, type RostyState } from "./state.js";
import { addUsdc, isFleetBuyer, isoDay, isoWeek, shouldFlushFleet } from "./throttle.js";

async function channel(client: Client, id: string): Promise<TextChannel | null> {
  try {
    const ch = client.channels.cache.get(id) ?? (await client.channels.fetch(id));
    if (ch && ch.isTextBased() && "send" in ch) return ch as TextChannel;
  } catch (error) {
    console.warn("channel fetch failed", id, error);
  }
  return null;
}

function demandRows(body: Awaited<ReturnType<typeof fetchDemand>>): { need: string; count: number; estimateUsdc?: string }[] {
  const raw: DemandRow[] = body.top ?? body.clusters ?? body.items ?? [];
  return raw.map((row) => ({
    need: row.need ?? row.label ?? "—",
    count: row.count ?? row.requests ?? 1,
    estimateUsdc: row.estimateUsdc ?? row.estimatedEarningsUsdc,
  }));
}

export function createPollers(client: Client, channels: RostyChannels, stateFile: string) {
  const state: RostyState = loadState(stateFile);
  let listingSeeded = state.seenListingIds.length > 0;

  const persist = () => saveState(stateFile, state);

  async function pollHealth(): Promise<void> {
    const ch = await channel(client, channels.status);
    if (!ch) return;
    try {
      const health = await fetchHealth();
      const ok = health.ok === true;
      const version = health.version ?? null;
      if (state.lastHealthOk === null) {
        state.lastHealthOk = ok;
        state.lastVersion = version;
        persist();
        return;
      }
      if (state.lastHealthOk !== ok) {
        await ch.send({ embeds: [statusEmbed({ ok, version, previousVersion: state.lastVersion })] });
        state.lastHealthOk = ok;
      }
      if (version && state.lastVersion && version !== state.lastVersion) {
        await ch.send({
          embeds: [
            statusEmbed({
              ok: true,
              version,
              previousVersion: state.lastVersion,
              detail: `Deploy detected: \`${state.lastVersion}\` → \`${version}\``,
            }),
          ],
        });
        state.lastVersion = version;
      } else if (version && !state.lastVersion) {
        state.lastVersion = version;
      }
      persist();
    } catch (error) {
      if (state.lastHealthOk !== false) {
        await ch.send({
          embeds: [statusEmbed({ ok: false, detail: error instanceof Error ? error.message : "health poll failed" })],
        });
        state.lastHealthOk = false;
        persist();
      }
    }
  }

  async function pollListings(): Promise<void> {
    const ch = await channel(client, channels.listings);
    if (!ch) return;
    try {
      const listings = await fetchAdminListings();
      if (listings.length === 0) return;
      const seen = new Set(state.seenListingIds);
      if (!listingSeeded) {
        state.seenListingIds = listings.map((row) => row.id);
        listingSeeded = true;
        persist();
        return;
      }
      const fresh = listings.filter((row) => !seen.has(row.id)).reverse();
      for (const row of fresh) {
        await ch.send({
          embeds: [
            listingEmbed({
              name: row.name,
              kind: row.party === "first_party" ? "data/service" : "listing",
              priceUsdc: row.priceUsdc ?? "—",
              seller: row.organizationName ?? "—",
              id: row.id,
            }),
          ],
        });
        state.seenListingIds.push(row.id);
      }
      if (fresh.length) persist();
    } catch (error) {
      console.warn("listings poll", error);
    }
  }

  async function flushFleet(ch: TextChannel, now: Date): Promise<void> {
    const bucket = state.fleetBucket;
    if (!bucket || bucket.count === 0) return;
    if (!shouldFlushFleet(bucket.windowStartedAt, now, FLEET_SUMMARY_MIN) && bucket.count < 50) return;
    await ch.send({
      embeds: [
        txEmbed({
          product: "Roster Fleet buyer loop",
          amountUsdc: bucket.amountUsdc,
          seller: "various",
          latencyMs: null,
          sandbox: true,
          summary: true,
          fleetCount: bucket.count,
        }),
      ],
    });
    state.fleetBucket = null;
    persist();
  }

  async function handleTxItem(ch: TextChannel, item: ActivityItem, now: Date): Promise<void> {
    if (item.status && item.status !== "released") return;
    const fleet = isFleetBuyer(item.buyer, item.buyerKind);
    // Devnet (and any job with an explorer link) posts individually so TX has real sigs.
    // Mock fleet buys stay aggregated to avoid spam.
    if (fleet && !item.explorerUrl) {
      if (!state.fleetBucket) {
        state.fleetBucket = { windowStartedAt: now.toISOString(), count: 0, amountUsdc: "0.000000" };
      }
      state.fleetBucket.count += 1;
      state.fleetBucket.amountUsdc = addUsdc(state.fleetBucket.amountUsdc, item.amountUsdc ?? "0");
      await flushFleet(ch, now);
      persist();
      return;
    }
    await ch.send({
      embeds: [
        txEmbed({
          product: item.product ?? item.listingId ?? "job",
          amountUsdc: item.amountUsdc ?? "0",
          seller: item.seller ?? "—",
          latencyMs: item.latencyMs ?? null,
          sandbox: item.sandbox !== false,
          explorerUrl: item.explorerUrl,
          railLabel: item.railLabel,
          chain: item.chain,
        }),
      ],
    });
  }

  async function pollActivity(): Promise<void> {
    const ch = await channel(client, channels.tx);
    if (!ch) return;
    const now = new Date();
    try {
      await flushFleet(ch, now);
      const activity = await fetchActivity(40);
      const items = activity.items ?? [];
      if (!state.lastActivityJobId) {
        state.lastActivityJobId = items[0]?.id ?? null;
        persist();
        return;
      }
      const fresh: ActivityItem[] = [];
      for (const item of items) {
        if (item.id === state.lastActivityJobId) break;
        fresh.push(item);
      }
      for (const item of fresh.reverse()) {
        await handleTxItem(ch, item, now);
      }
      if (items[0]?.id) {
        state.lastActivityJobId = items[0].id;
        persist();
      }
      if (activity.leaderboard) {
        // stored for weekly post
        (state as RostyState & { _lb?: typeof activity.leaderboard })._lb = activity.leaderboard;
      }
    } catch (error) {
      console.warn("activity poll", error);
    }
  }

  async function pollDemandDaily(): Promise<void> {
    const ch = await channel(client, channels.demand);
    if (!ch) return;
    const day = isoDay(new Date());
    if (state.lastDemandPostDay === day) return;
    try {
      const body = await fetchDemand();
      await ch.send({ embeds: [demandEmbed(demandRows(body))] });
      state.lastDemandPostDay = day;
      persist();
    } catch (error) {
      console.warn("demand poll", error);
    }
  }

  async function pollLeaderboardWeekly(): Promise<void> {
    const ch = await channel(client, channels.leaderboard);
    if (!ch) return;
    const week = isoWeek(new Date());
    if (state.lastLeaderboardWeek === week) return;
    try {
      const activity = await fetchActivity(100);
      const rows = (activity.leaderboard ?? []).map((row) => ({
        seller: row.seller,
        amountUsdc: row.amountUsdc,
        jobs: row.jobs,
      }));
      await ch.send({ embeds: [leaderboardEmbed(rows)] });
      state.lastLeaderboardWeek = week;
      persist();
    } catch (error) {
      console.warn("leaderboard poll", error);
    }
  }

  return {
    pollHealth,
    pollListings,
    pollActivity,
    pollDemandDaily,
    pollLeaderboardWeekly,
    async start(): Promise<void> {
      const tick = async () => {
        await pollHealth();
        await pollListings();
        await pollActivity();
        await pollDemandDaily();
        await pollLeaderboardWeekly();
      };
      await tick();
      setInterval(() => {
        void tick();
      }, 60_000);
    },
  };
}
