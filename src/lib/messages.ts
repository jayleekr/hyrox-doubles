// Deterministic message builders. Pure, so every string the agent can emit is covered
// by tests.
//
// Output is plain text with no markup. These strings are read by the OpenClaw agent,
// which composes the message it actually sends — markup here would either be rendered
// literally or have to be stripped again on the way out.

import { formatPace } from "./cells.ts";
import type { DayRecord, PlayerId } from "./grid.ts";
import { PLAYER_IDS } from "./grid.ts";
import { phaseForWeek, type Phase } from "./phases.ts";
import { addDays, daysToRace, weekdayKo } from "./season.ts";
import { findByDate, missedDays, recordsForWeek, streak, summarize, summarizeTeam, type TeamSummary } from "./stats.ts";
import type { Season } from "./store.ts";

export type Names = Record<PlayerId, string>;

/**
 * An upper bound on any single block of text we emit. Memos and alternate-workout notes
 * are free text typed by the athletes, so a brief is not otherwise length-bounded.
 */
export const MAX_MESSAGE_CHARS = 4096;

export function clampMessage(text: string, max: number = MAX_MESSAGE_CHARS): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + "…";
}

export function formatDday(date: string): string {
  const n = daysToRace(date);
  if (n === null) return "";
  if (n === 0) return "D-DAY";
  return n > 0 ? `D-${n}` : `D+${-n}`;
}

function phaseLine(phases: Phase[], week: number): string {
  const p = phaseForWeek(phases, week);
  if (!p) return "";
  return `${p.name} · 목표 페이스 ${p.paceTarget}`;
}

function statusIcon(done: boolean): string {
  return done ? "✅" : "⬜️";
}

/** Morning push: today's session, plus how yesterday went for both of us. */
export function morningMessage(season: Season, date: string, names: Names): string {
  const today = findByDate(season.records, date);
  if (!today) {
    return `오늘(${date})은 15주 프로그램 기간이 아니야. 8/1 ~ 11/13 사이에만 세션이 있어.`;
  }

  const lines: string[] = [];
  lines.push(`${formatDday(date)} · ${date} (${weekdayKo(date)}) · W${today.week}`);
  const phase = phaseLine(season.phases, today.week);
  if (phase) lines.push(phase);
  lines.push("");

  if (today.isRaceDay) {
    lines.push(`🚨 ${today.area}`);
    lines.push(today.plan);
    return lines.join("\n");
  }

  lines.push(`오늘: ${today.area}`);
  if (today.plan) lines.push(today.plan);
  if (today.paceTarget) lines.push(`🎯 ${today.paceTarget}`);

  const yesterday = season.records.filter((r) => r.date < date).at(-1);
  if (yesterday && !yesterday.isRest) {
    lines.push("");
    lines.push(`어제 (${yesterday.date} · ${yesterday.area})`);
    for (const p of PLAYER_IDS) {
      const log = yesterday[p];
      const extra = [
        log.weightKg !== null ? `${log.weightKg}kg` : null,
        log.paceSecPerKm !== null ? `${formatPace(log.paceSecPerKm)}/km` : null,
        log.rpe !== null ? `RPE ${log.rpe}` : null,
      ].filter(Boolean);
      lines.push(`${statusIcon(log.done)} ${names[p]}${extra.length ? ` — ${extra.join(" · ")}` : ""}`);
    }
  }

  // The team's own number, not two individual ones. Doubles is scored by the pair, and a
  // line that only ever moves when *both* of them train is the point of showing it.
  const upto = season.records.filter((r) => r.date <= date);
  const team = summarizeTeam(upto);
  if (team.planned > 0) {
    lines.push("");
    lines.push(teamLine(team, names));
  }

  lines.push("");
  // Asking for a time and a place, and asking for it now, is the part that changes what
  // happens: a stated when/where is what the evening message is measured against.
  const stated = PLAYER_IDS.filter((p) => today[p].commitment);
  if (stated.length === PLAYER_IDS.length) {
    lines.push(`오늘 약속 — ${PLAYER_IDS.map((p) => `${names[p]} ${today[p].commitment}`).join(" / ")}`);
  } else {
    const asking = PLAYER_IDS.filter((p) => !today[p].commitment).map((p) => names[p]);
    lines.push(`${asking.join(", ")} — 오늘 몇 시에, 어디서 할 거야? 정해서 말해줘.`);
    for (const p of stated) lines.push(`${names[p]}는 ${today[p].commitment} 라고 했어.`);
  }
  lines.push("끝나면 편하게 말해줘. 예: 오늘 다 했어, 82.4kg, 페이스 4:20, RPE 7");
  return lines.join("\n");
}

/** One line of the team's conjunctive numbers. */
function teamLine(team: TeamSummary, names: Names): string {
  const bits = [`팀 ${team.bothDone}/${team.planned} (${Math.round(team.completion * 100)}%)`];
  // The days one of them trained alone are the ones worth naming: the work happened and
  // the team still scored nothing.
  if (team.soloDays > 0) bits.push(`혼자 한 날 ${team.soloDays}일`);
  if (team.bothStreak > 0) bits.push(`둘 다 연속 ${team.bothStreak}일`);
  if (team.teamPaceSecPerKm !== null) bits.push(`팀 페이스 ${formatPace(team.teamPaceSecPerKm)}/km`);
  const head = `👥 ${bits.join(" · ")}`;
  return team.behind ? `${head}\n뒤처진 쪽: ${names[team.behind]}` : head;
}

/** Evening nudge, or null when both have already logged today (or it is a rest day). */
export function nudgeMessage(season: Season, date: string, names: Names): string | null {
  const today = findByDate(season.records, date);
  if (!today || today.isRest || today.isRaceDay) return null;

  const pending = PLAYER_IDS.filter((p) => !today[p].done);
  if (pending.length === 0) return null;

  const lines: string[] = [];
  lines.push(`⏰ ${formatDday(date)} · 오늘 ${today.area} 아직 미기록`);
  for (const p of pending) {
    // Measured up to yesterday: today is precisely the day they have not completed, so
    // counting up to today would always return 0 and the line would be dead text.
    const yesterday = addDays(date, -1);
    const s = yesterday ? streak(season.records, p, yesterday) : 0;
    // Quoting this morning's own words back is the whole mechanism: an if-then plan that is
    // never revisited barely moves behaviour, and one that is reinforced does.
    const said = today[p].commitment;
    const tail = [said ? `"${said}" 라고 했어` : null, s > 0 ? `연속 ${s}일 진행 중` : null]
      .filter(Boolean)
      .join(" · ");
    lines.push(`⬜️ ${names[p]}${tail ? ` — ${tail}` : ""}`);
  }
  const doneNow = PLAYER_IDS.filter((p) => today[p].done);
  for (const p of doneNow) {
    lines.push(`✅ ${names[p]} 완료`);
  }
  // Doubles is scored on the pair: one of them finishing leaves the team on nothing.
  if (doneNow.length > 0 && pending.length > 0) {
    lines.push("");
    lines.push(`오늘 팀 기록은 아직 0이야 — ${pending.map((p) => names[p]).join(", ")} 하나 남았어.`);
  }
  return lines.join("\n");
}

export type WeeklyFacts = {
  week: number;
  from: string;
  to: string;
  phase: string;
  phasePaceTarget: string;
  players: {
    id: PlayerId;
    name: string;
    planned: number;
    done: number;
    completionPct: number;
    weightLast: number | null;
    weightDelta: number | null;
    avgPace: string | null;
    avgRpe: number | null;
    streak: number;
    missed: string[];
  }[];
};

/** The numbers the weekly review is built from. */
export function weeklyFacts(season: Season, date: string, names: Names): WeeklyFacts | null {
  const week = recordsForWeek(season.records, date);
  if (week.length === 0) return null;
  const phase = phaseForWeek(season.phases, week[0].week);
  // The cutoff is the week's own last day. Using the caller's anchor instead would make
  // the header and the completion counts cover the whole week while "빠진 세션" and the
  // streak covered only part of it. This function is for weeks that have ended.
  const cutoff = week[week.length - 1].date;

  return {
    week: week[0].week,
    from: week[0].date,
    to: week[week.length - 1].date,
    phase: phase?.name ?? "",
    phasePaceTarget: phase?.paceTarget ?? "",
    players: PLAYER_IDS.map((p) => {
      const s = summarize(week, p);
      return {
        id: p,
        name: names[p],
        planned: s.planned,
        done: s.done,
        completionPct: Math.round(s.completion * 100),
        weightLast: s.weightLast,
        weightDelta: s.weightDelta,
        avgPace: s.avgPaceSecPerKm === null ? null : formatPace(s.avgPaceSecPerKm),
        avgRpe: s.avgRpe,
        streak: streak(season.records, p, cutoff),
        missed: missedDays(week, p, week[0].date, cutoff).map((r) => `${r.date} ${r.area}`),
      };
    }),
  };
}

/** Deterministic weekly summary. */
export function weeklySummaryText(facts: WeeklyFacts): string {
  const lines: string[] = [];
  lines.push(`📊 W${facts.week} 리뷰 (${facts.from} ~ ${facts.to})`);
  if (facts.phase) lines.push(`${facts.phase} · 목표 ${facts.phasePaceTarget}`);
  lines.push("");
  for (const p of facts.players) {
    lines.push(`${p.name} — 완료 ${p.done}/${p.planned} (${p.completionPct}%)`);
    const bits: string[] = [];
    if (p.weightLast !== null) {
      const delta = p.weightDelta === null ? "" : ` (${p.weightDelta > 0 ? "+" : ""}${p.weightDelta})`;
      bits.push(`체중 ${p.weightLast}kg${delta}`);
    }
    if (p.avgPace) bits.push(`평균 ${p.avgPace}/km`);
    if (p.avgRpe !== null) bits.push(`평균 RPE ${p.avgRpe}`);
    if (p.streak > 0) bits.push(`연속 ${p.streak}일`);
    if (bits.length) lines.push(bits.join(" · "));
    if (p.missed.length) lines.push(`빠진 세션: ${p.missed.join(", ")}`);
    lines.push("");
  }
  return lines.join("\n").trim();
}

/** Confirmation echoed after a log is written. */
export function savedConfirmation(name: string, record: DayRecord, player: PlayerId): string {
  const log = record[player];
  const bits: string[] = [];
  bits.push(log.done ? "✅ 완료" : "⬜️ 미완료");
  if (log.weightKg !== null) bits.push(`${log.weightKg}kg`);
  if (log.paceSecPerKm !== null) bits.push(`${formatPace(log.paceSecPerKm)}/km`);
  if (log.durationMin !== null) bits.push(`${log.durationMin}분`);
  if (log.rpe !== null) bits.push(`RPE ${log.rpe}`);
  if (log.altWorkout) bits.push(`대체: ${log.altWorkout}`);
  if (log.memo) bits.push(`메모: ${log.memo}`);
  if (log.commitment) bits.push(`약속: ${log.commitment}`);
  return `${name} · ${record.date} ${record.area}\n${bits.join(" · ")}`;
}
