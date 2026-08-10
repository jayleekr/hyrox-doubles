// Aggregations over parsed day records. Pure; no I/O.

import type { DayRecord, PlayerId } from "./grid.ts";
import { parsePaceTarget } from "./cells.ts";
import { LAST_ROW, FIRST_ROW, weekForDate } from "./season.ts";

export type Summary = {
  planned: number; // trainable (non-rest) days in range
  done: number;
  completion: number; // 0..1, 0 when planned === 0
  weightFirst: number | null;
  weightLast: number | null;
  weightDelta: number | null;
  avgPaceSecPerKm: number | null;
  bestPaceSecPerKm: number | null;
  avgRpe: number | null;
  totalMinutes: number;
};

export type WeekSummary = Summary & { week: number; from: string; to: string };

function mean(xs: number[]): number | null {
  if (xs.length === 0) return null;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

export function summarize(records: DayRecord[], player: PlayerId): Summary {
  const trainable = records.filter((r) => !r.isRest);
  const done = trainable.filter((r) => r[player].done).length;

  const weights = records.map((r) => r[player].weightKg).filter((w): w is number => w !== null);
  const paces = records.map((r) => r[player].paceSecPerKm).filter((p): p is number => p !== null);
  const rpes = records.map((r) => r[player].rpe).filter((v): v is number => v !== null);
  const minutes = records.map((r) => r[player].durationMin).filter((v): v is number => v !== null);

  const weightFirst = weights.length ? weights[0] : null;
  const weightLast = weights.length ? weights[weights.length - 1] : null;
  const avgPace = mean(paces);
  const avgRpe = mean(rpes);

  return {
    planned: trainable.length,
    done,
    completion: trainable.length === 0 ? 0 : done / trainable.length,
    weightFirst,
    weightLast,
    weightDelta:
      weightFirst !== null && weightLast !== null ? Math.round((weightLast - weightFirst) * 10) / 10 : null,
    avgPaceSecPerKm: avgPace === null ? null : Math.round(avgPace),
    bestPaceSecPerKm: paces.length ? Math.min(...paces) : null,
    avgRpe: avgRpe === null ? null : Math.round(avgRpe * 10) / 10,
    totalMinutes: minutes.reduce((a, b) => a + b, 0),
  };
}

export function weekSummaries(records: DayRecord[], player: PlayerId): WeekSummary[] {
  const totalWeeks = Math.ceil((LAST_ROW - FIRST_ROW + 1) / 7);
  const out: WeekSummary[] = [];
  for (let w = 1; w <= totalWeeks; w++) {
    const inWeek = records.filter((r) => r.week === w);
    if (inWeek.length === 0) continue;
    out.push({
      week: w,
      from: inWeek[0].date,
      to: inWeek[inWeek.length - 1].date,
      ...summarize(inWeek, player),
    });
  }
  return out;
}

/**
 * Consecutive completed trainable days ending at `upto` (inclusive), walking backwards.
 * Rest days are transparent: they neither extend nor break the streak.
 * A trainable day in the future (after `upto`) is ignored.
 */
export function streak(records: DayRecord[], player: PlayerId, upto: string): number {
  let count = 0;
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i];
    if (r.date > upto) continue;
    if (r.isRest) continue;
    if (r[player].done) count++;
    else break;
  }
  return count;
}

/** Records the player has not completed, between `from` and `upto` inclusive, most recent first. */
export function missedDays(
  records: DayRecord[],
  player: PlayerId,
  from: string,
  upto: string,
): DayRecord[] {
  return records
    .filter((r) => !r.isRest && r.date >= from && r.date <= upto && !r[player].done)
    .reverse();
}

/**
 * The team's numbers, computed the way the race scores them.
 *
 * HYROX Doubles is a conjunctive task: the pair runs all 8km together, so the team is bounded
 * by whoever is slower or less prepared — not by their average. Reporting two separate
 * completion rates hides exactly that, and it is also the condition under which a partner's
 * effort is known to rise: their contribution has to be visibly indispensable.
 *
 * So every field here is a minimum or a joint count, never a mean of the two.
 */
export type TeamSummary = {
  planned: number;
  /** Days BOTH completed. This is the team's real completion. */
  bothDone: number;
  completion: number;
  /** Days exactly one of them trained. The session happened; the team got nothing. */
  soloDays: number;
  /** Neither trained. */
  missedDays: number;
  /** The slower of the two average paces — the pace the pair would actually run. */
  teamPaceSecPerKm: number | null;
  /** Whoever has completed fewer sessions, or null when they are level. */
  behind: PlayerId | null;
  /** Consecutive trainable days both completed, ending at the last record. */
  bothStreak: number;
};

export function summarizeTeam(records: DayRecord[]): TeamSummary {
  const trainable = records.filter((r) => !r.isRest);

  let bothDone = 0;
  let soloDays = 0;
  let missed = 0;
  for (const r of trainable) {
    const n = (r.A.done ? 1 : 0) + (r.B.done ? 1 : 0);
    if (n === 2) bothDone++;
    else if (n === 1) soloDays++;
    else missed++;
  }

  const a = summarize(records, "A");
  const b = summarize(records, "B");

  // The pair can only run as fast as its slower half, so a missing pace is not "fast" — it
  // is unknown, and an unknown half means no team pace at all.
  const teamPace =
    a.avgPaceSecPerKm !== null && b.avgPaceSecPerKm !== null
      ? Math.max(a.avgPaceSecPerKm, b.avgPaceSecPerKm)
      : null;

  let bothStreak = 0;
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i];
    if (r.isRest) continue;
    if (r.A.done && r.B.done) bothStreak++;
    else break;
  }

  return {
    planned: trainable.length,
    bothDone,
    completion: trainable.length === 0 ? 0 : bothDone / trainable.length,
    soloDays,
    missedDays: missed,
    teamPaceSecPerKm: teamPace,
    behind: a.done === b.done ? null : a.done < b.done ? "A" : "B",
    bothStreak,
  };
}

export function findByDate(records: DayRecord[], date: string): DayRecord | null {
  return records.find((r) => r.date === date) ?? null;
}

export function recordsForWeek(records: DayRecord[], date: string): DayRecord[] {
  const w = weekForDate(date);
  if (w === null) return [];
  return records.filter((r) => r.week === w);
}

// ---------------------------------------------------------------- computed, not re-derived
//
// Everything below was being worked out by hand from --json on every conversation. A number
// recomputed each time is a number that can be wrong differently each time, and no test ever
// sees it. These are the same figures, computed once and covered.

export type Adherence = {
  /** Trainable days completed. */
  done: number;
  /** Of those, the ones done as prescribed — no substitute recorded. */
  asPrescribed: number;
  /** Of those, the ones where something else was done instead. */
  substituted: number;
  /** asPrescribed / done, or 0 when nothing has been done at all. */
  rate: number;
};

/**
 * Whether the programme is being followed, as opposed to merely trained around.
 *
 * A completed day and a completed *session* are different facts and live in different
 * columns: `done` says they trained, `altWorkout` says they did something other than the
 * session prescribed for that day. A run of ✅ every one of which carries a substitute means
 * the 15-week plan is not being followed at all — invisible in a completion percentage, and
 * the single most useful thing to notice early.
 *
 * Not a judgement. A substituted session is a trained day; it is the plan that has stopped
 * describing reality.
 */
export function adherence(records: DayRecord[], player: PlayerId): Adherence {
  const done = records.filter((r) => !r.isRest && r[player].done);
  const substituted = done.filter((r) => r[player].altWorkout !== "").length;
  return {
    done: done.length,
    asPrescribed: done.length - substituted,
    substituted,
    rate: done.length === 0 ? 0 : (done.length - substituted) / done.length,
  };
}

export type PaceGap = {
  /** Mean logged pace over the range, or null when nothing was measured. */
  actualSecPerKm: number | null;
  /** The slower (easier) end of what the programme asked for on those days. */
  targetSecPerKm: number | null;
  /** Positive = slower than asked. Null when either side is unknown. */
  behindSec: number | null;
  /** Days in range that prescribed a pace at all. Recovery and rest days do not. */
  daysWithTarget: number;
};

/**
 * How far off the prescribed pace they are, in seconds.
 *
 * Measured against the *slower* end of each day's range: the range is what the programme will
 * accept, so being at 4:30 on a "4:15~4:30" day is on target, not 15 seconds late. Days
 * prescribed by effort ("RPE 7~8") or not at all ("Rest") carry no pace target and are
 * excluded rather than treated as a target of zero.
 */
export function paceGap(records: DayRecord[], player: PlayerId): PaceGap {
  const withTarget = records
    .map((r) => ({ record: r, target: parsePaceTarget(r.paceTarget) }))
    .filter((x): x is { record: DayRecord; target: { fastSec: number; slowSec: number } } => x.target !== null);

  const paces = records.map((r) => r[player].paceSecPerKm).filter((p): p is number => p !== null);
  const actual = mean(paces);
  const target = mean(withTarget.map((x) => x.target.slowSec));

  return {
    actualSecPerKm: actual === null ? null : Math.round(actual),
    targetSecPerKm: target === null ? null : Math.round(target),
    behindSec: actual === null || target === null ? null : Math.round(actual - target),
    daysWithTarget: withTarget.length,
  };
}

export type Trend = {
  windowDays: number;
  recentAvg: number | null;
  priorAvg: number | null;
  /** recent − prior. Negative is faster/lighter; null when either window has no data. */
  delta: number | null;
};

/**
 * Compare the last `windowDays` against the `windowDays` before them.
 *
 * "체중이 2주째 정체" and "페이스가 3주간 12초 빨라졌다" are the observations worth making, and
 * neither is answerable from a season average. Both windows must have data — a first window
 * with nothing to compare against is not "no change", it is not yet known.
 */
export function trend(
  records: DayRecord[],
  player: PlayerId,
  field: "weightKg" | "paceSecPerKm" | "rpe",
  upto: string,
  windowDays = 14,
): Trend {
  const cutoff = (offset: number): string => {
    const d = new Date(`${upto}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - offset);
    return d.toISOString().slice(0, 10);
  };
  const recentFrom = cutoff(windowDays - 1);
  const priorFrom = cutoff(windowDays * 2 - 1);

  const valuesIn = (from: string, to: string): number[] =>
    records
      .filter((r) => r.date >= from && r.date <= to)
      .map((r) => r[player][field])
      .filter((v): v is number => v !== null);

  const recent = mean(valuesIn(recentFrom, upto));
  const prior = mean(valuesIn(priorFrom, cutoff(windowDays)));
  const round = (v: number | null) => (v === null ? null : Math.round(v * 10) / 10);

  return {
    windowDays,
    recentAvg: round(recent),
    priorAvg: round(prior),
    delta: recent === null || prior === null ? null : round(recent - prior),
  };
}
