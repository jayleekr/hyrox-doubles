// The scheduled briefs, as text.
//
// Nothing here sends anything. Delivery and scheduling belong to OpenClaw; this module
// only answers "what should be said about this date". That keeps every brief a pure
// function of the sheet, so all of them are testable without a network.

import { playerNames, otherPlayer } from "./config.ts";
import type { PlayerId } from "./grid.ts";
import { addDays, weekdayKo } from "./season.ts";
import {
  clampMessage,
  morningMessage,
  nudgeMessage,
  savedConfirmation,
  weeklyFacts,
  weeklySummaryText,
  type Names,
} from "./messages.ts";
import type { DayRecord } from "./grid.ts";
import type { Season } from "./store.ts";

/**
 * Morning brief. Returns one block, or two on Sunday: weeks run Saturday→Friday, so by
 * Sunday the previous week has closed and is worth reviewing.
 */
export function morningBrief(season: Season, date: string, names: Names = playerNames()): string[] {
  const out = [morningMessage(season, date, names)];
  if (weekdayKo(date) === "일요일") {
    const review = weeklyBrief(season, addDays(date, -2), names);
    if (review) out.push(review);
  }
  return out.map((t) => clampMessage(t));
}

/** Evening nudge, or null when there is nothing to nudge about. */
export function nudgeBrief(season: Season, date: string, names: Names = playerNames()): string | null {
  const text = nudgeMessage(season, date, names);
  return text === null ? null : clampMessage(text);
}

/** Review of the week containing `anchor`, or null if that week has no data. */
export function weeklyBrief(season: Season, anchor: string | null, names: Names = playerNames()): string | null {
  if (!anchor) return null;
  const facts = weeklyFacts(season, anchor, names);
  if (!facts) return null;
  return clampMessage(weeklySummaryText(facts));
}

/**
 * Korean topic particle: 은 after a final consonant, 는 after a vowel.
 * "정재빈은", not "정재빈는".
 */
export function topicParticle(name: string): "은" | "는" {
  const last = name.trim().at(-1);
  if (!last) return "는";
  const code = last.charCodeAt(0);
  if (code >= 0xac00 && code <= 0xd7a3) {
    return (code - 0xac00) % 28 === 0 ? "는" : "은";
  }
  // Non-Hangul (Latin names, emoji): 는 reads acceptably and never looks broken.
  return "는";
}

/** What to say back after writing a log: what was stored, and where the partner stands. */
export function savedBrief(record: DayRecord, player: PlayerId, names: Names = playerNames()): string {
  const partner = otherPlayer(player);
  const partnerLine = record[partner].done
    ? `${names[partner]}${topicParticle(names[partner])} 이미 완료 ✅`
    : `${names[partner]}${topicParticle(names[partner])} 아직 미기록 ⬜️`;
  return clampMessage([savedConfirmation(names[player], record, player), partnerLine].join("\n"));
}
