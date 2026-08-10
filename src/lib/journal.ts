// An append-only local record of what this CLI did, and of the agent being alive.
//
// Everything that has gone wrong in production so far failed *silently*: group messages
// dropped by a policy, a bot kicked from the chat, a workspace path alias, four consecutive
// evenings where the scheduled nudge never fired. In each case the CLI was fine, the sheet was
// fine, and nobody found out until a human said "it isn't answering".
//
// `doctor` cannot see the inbound path — if a message never arrives, no command runs to notice.
// But the *absence* of activity is observable, and that is what this file makes observable: the
// agent records that it acted, and a later check can say "nothing has happened in five hours".
// Silence becomes a number.
//
// Deliberately a local file, not a sheet tab. It is operational telemetry, it churns, and it
// must stay writable when the sheet is exactly what is broken.

import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { LogPatch, PlayerId } from "./grid.ts";
import type { DietPatch } from "./diet.ts";

export type WriteTarget = "log" | "goal" | "meal";

export type JournalEvent =
  | { at: string; kind: "pulse"; note?: string }
  | { at: string; kind: "brief"; brief: string; date: string; emitted: boolean }
  | {
      at: string;
      kind: "write";
      target: WriteTarget;
      date: string;
      player: PlayerId;
      /** Enough to put it back: the fields as they were before this write. */
      undo: LogPatch | DietPatch | Record<string, unknown>;
      /** What was asked for, so a human reading the journal can see the intent. */
      patch: LogPatch | DietPatch | Record<string, unknown>;
      cells: number;
    };

/**
 * Entries kept before the file is trimmed.
 *
 * Bounded because nothing else prunes it and an unbounded local log eventually becomes the
 * problem it was meant to detect. Generous enough to hold a season of writes.
 */
export const MAX_ENTRIES = 5000;

export function journalPath(): string {
  const override = process.env.HYROX_JOURNAL;
  if (override) return override;
  // Resolved from this module, not from cwd: the agent's working directory is its own
  // workspace, and the same journal has to be found from anywhere.
  return decodeURIComponent(new URL("../../agent/.hyrox-journal.jsonl", import.meta.url).pathname);
}

/**
 * Append one event. Never throws.
 *
 * A journal that can break the command it is recording would be worse than no journal: a full
 * disk or a read-only directory would start refusing training logs. Recording is best-effort
 * by design, and `doctor` reports a journal it cannot read rather than the CLI failing.
 */
export async function record(event: JournalEvent): Promise<void> {
  try {
    const path = journalPath();
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, JSON.stringify(event) + "\n", "utf8");
  } catch {
    // Intentionally silent. See above.
  }
}

export async function readJournal(): Promise<JournalEvent[]> {
  let text: string;
  try {
    text = await readFile(journalPath(), "utf8");
  } catch {
    return [];
  }
  const out: JournalEvent[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      // A half-written final line is normal after a crash mid-append; skip it rather than
      // throwing away every event before it.
      if (parsed && typeof parsed.at === "string" && typeof parsed.kind === "string") out.push(parsed);
    } catch {
      continue;
    }
  }
  return out;
}

/** Rewrite the file with only the newest `MAX_ENTRIES`. Best-effort, like `record`. */
export async function trimJournal(max = MAX_ENTRIES): Promise<void> {
  try {
    const events = await readJournal();
    if (events.length <= max) return;
    const keep = events.slice(-max);
    await writeFile(journalPath(), keep.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
  } catch {
    // Intentionally silent.
  }
}

export function lastOf<K extends JournalEvent["kind"]>(
  events: JournalEvent[],
  kind: K,
): Extract<JournalEvent, { kind: K }> | null {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].kind === kind) return events[i] as Extract<JournalEvent, { kind: K }>;
  }
  return null;
}

/** Hours since an ISO timestamp, or null when it is absent or unparseable. */
export function hoursSince(at: string | null | undefined, now: Date): number | null {
  if (!at) return null;
  const t = Date.parse(at);
  if (Number.isNaN(t)) return null;
  return (now.getTime() - t) / 3_600_000;
}

export type BriefRun = { brief: string; date: string; at: string; emitted: boolean };

/** Scheduled briefs that ran, most recent first. */
export function briefRuns(events: JournalEvent[]): BriefRun[] {
  return events
    .filter((e): e is Extract<JournalEvent, { kind: "brief" }> => e.kind === "brief")
    .map((e) => ({ brief: e.brief, date: e.date, at: e.at, emitted: e.emitted }))
    .reverse();
}

/**
 * Season days in [from, to] on which `brief` was never recorded as having run.
 *
 * This is the check that would have caught four silent evenings: the morning push kept
 * working, so nothing looked broken, while the 21:00 job failed every night for four days.
 * A run is counted whether or not it had anything to say — "nothing to nudge about" is a
 * successful run, and treating it as a miss would cry wolf on every rest day.
 */
export function missedBriefDays(events: JournalEvent[], brief: string, from: string, to: string): string[] {
  const ran = new Set(
    events
      .filter((e): e is Extract<JournalEvent, { kind: "brief" }> => e.kind === "brief" && e.brief === brief)
      .map((e) => e.date),
  );
  const out: string[] = [];
  for (let d = from; d <= to; d = nextDay(d)) {
    if (!ran.has(d)) out.push(d);
  }
  return out;
}

function nextDay(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** The most recent write, for `undo`. */
export function lastWrite(events: JournalEvent[]): Extract<JournalEvent, { kind: "write" }> | null {
  return lastOf(events, "write");
}
