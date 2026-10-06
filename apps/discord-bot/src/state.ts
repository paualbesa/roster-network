import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface RostyState {
  seenListingIds: string[];
  lastActivityJobId: string | null;
  lastHealthOk: boolean | null;
  lastVersion: string | null;
  lastDemandPostDay: string | null;
  lastLeaderboardWeek: string | null;
  fleetBucket: {
    windowStartedAt: string;
    count: number;
    amountUsdc: string;
  } | null;
}

const EMPTY: RostyState = {
  seenListingIds: [],
  lastActivityJobId: null,
  lastHealthOk: null,
  lastVersion: null,
  lastDemandPostDay: null,
  lastLeaderboardWeek: null,
  fleetBucket: null,
};

export function loadState(filePath: string): RostyState {
  if (!existsSync(filePath)) return structuredClone(EMPTY);
  try {
    const raw = JSON.parse(readFileSync(filePath, "utf8")) as Partial<RostyState>;
    return {
      ...structuredClone(EMPTY),
      ...raw,
      seenListingIds: Array.isArray(raw.seenListingIds) ? raw.seenListingIds.slice(-500) : [],
    };
  } catch {
    return structuredClone(EMPTY);
  }
}

export function saveState(filePath: string, state: RostyState): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const next = { ...state, seenListingIds: state.seenListingIds.slice(-500) };
  writeFileSync(filePath, JSON.stringify(next, null, 2));
}
