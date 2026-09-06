import { invoke } from "@tauri-apps/api/core";

/** Mirrors src-tauri/src/token_stats.rs's `TokenStats` (camelCase on the wire). */
export interface TokenStats {
  todayOutput: number;
  todayInput: number;
  todayCacheRead: number;
  totalOutput: number;
  totalInput: number;
  sessionCount: number;
}

export const EMPTY_TOKEN_STATS: TokenStats = {
  todayOutput: 0,
  todayInput: 0,
  todayCacheRead: 0,
  totalOutput: 0,
  totalInput: 0,
  sessionCount: 0,
};

export function fetchTokenStats(): Promise<TokenStats> {
  return invoke<TokenStats>("token_stats");
}
