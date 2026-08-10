// The command surface OpenClaw drives.
//
// Natural language is OpenClaw's job: its agent reads "오늘 다 했어 82.4kg" and turns it
// into `log --who a --done --weight 82.4`. This module's job is the opposite — to be
// rigidly literal, so that a misread sentence fails loudly instead of silently writing
// the wrong number into the season.
//
// Every command is a pure function of (argv, sheet). `runCli` returns the text rather
// than printing it, so the whole surface is testable against a synthetic sheet.

import type { SheetsClient } from "./sheets.ts";
import {
  loadSeason,
  loadDay,
  saveGoalWeight,
  saveLog,
  saveLogTarget,
  savePhaseTarget,
  type Season,
  type TargetSaveResult,
} from "./store.ts";
import { PLAYER_IDS, type GridMismatch, type LogPatch, type PlayerId } from "./grid.ts";
import { cliCommand, playerNames, telegramUsers } from "./config.ts";
import {
  PHASE_COUNT,
  RACE_DATE,
  SEASON_START,
  SHEET_GOAL_TAB,
  SHEET_LOG_TAB,
  SHEET_PHASE_TAB,
  dateForRow,
  todayInSeasonTz,
  weekdayKo,
} from "./season.ts";
import { isPhaseNamed, phaseByNumber, type PhaseNumber } from "./phases.ts";
import { onboardingReport, type Onboarding } from "./goals.ts";
import { MAX_CELL_TEXT, cleanText, formatPace, formatStatusCell, hasAuthoredStatusText } from "./cells.ts";
import { morningBrief, nudgeBrief, savedBrief, weeklyBrief } from "./briefs.ts";
import { findByDate, recordsForWeek, streak, summarize } from "./stats.ts";
import { clampMessage, formatDday } from "./messages.ts";
import { renderDoctor, runDoctor } from "./doctor.ts";

export type CliResult = {
  code: number;
  out: string;
  /**
   * Print to stdout even when the code is non-zero.
   *
   * Everything else follows the rule "errors go to stderr so a caller that pipes stdout gets
   * clean data". `doctor` inverts it: a non-zero code is its *normal* successful outcome —
   * it found something — and its report, especially `--json`, is the data the caller asked
   * for. Without this flag `hyrox doctor --json | jq` would print nothing in exactly the
   * case the caller ran it for.
   */
  stdout?: boolean;
};

const ok = (out: string): CliResult => ({ code: 0, out });
/** Bad input. The agent can fix these by re-reading the message and retrying. */
const usage = (out: string): CliResult => ({ code: 1, out });
/** The sheet said no. Retrying the same command will not help. */
const failure = (out: string): CliResult => ({ code: 2, out });

// ---------------------------------------------------------------- argument parsing

type Args = {
  positional: string[];
  flags: Map<string, string | true>;
  /**
   * Flags supplied more than once, in the order first seen.
   *
   * A Map keeps only the last value, so `--who a --who b` silently resolves to B and files
   * Jay's session under 정재빈 — the same ambiguity `--telegram <B> --who a` already refuses
   * by name, but invisible because the first value is gone before any guard can see it.
   * Nothing in this surface is legitimately repeatable, so a repeat is always a question
   * nobody can answer, and the answer to those here is to write nothing.
   */
  repeated: string[];
};

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  const repeated: string[] = [];

  const set = (name: string, value: string | true) => {
    if (flags.has(name) && !repeated.includes(name)) repeated.push(name);
    flags.set(name, value);
  };

  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (!tok.startsWith("--")) {
      positional.push(tok);
      continue;
    }
    const body = tok.slice(2);
    const eq = body.indexOf("=");
    if (eq !== -1) {
      set(body.slice(0, eq).toLowerCase(), body.slice(eq + 1));
      continue;
    }
    const next = argv[i + 1];
    // A following token that itself looks like a flag means this one is boolean.
    if (next === undefined || next.startsWith("--")) {
      set(body.toLowerCase(), true);
    } else {
      set(body.toLowerCase(), next);
      i++;
    }
  }
  return { positional, flags, repeated };
}

function flagString(args: Args, name: string): string | null {
  const v = args.flags.get(name);
  if (v === undefined) return null;
  if (v === true) return "";
  return v;
}

function flagBool(args: Args, name: string): boolean {
  return args.flags.get(name) !== undefined;
}

/**
 * Flags that carry no value, and are refused outright when one is attached.
 *
 * `flagBool` looks only at presence, and `parseArgs` swallows any following non-`--` token as
 * this flag's value. Together those made `--done false`, `--done no` and `--done 0` all write
 * ✅ 완료 — the sheet's most important boolean, inverted, at exit 0 — and made
 * `--done 109` eat the 109 and save a completion with no weight at all, silently. An unset
 * shell variable produces the same thing as `--done ""`.
 *
 * The rest of this module already refuses exactly this class of ambiguity: a numeric flag
 * with no value (`isMissingValue`), a flag given twice, `--done` with `--not-done`,
 * `--phase` with `--date`. This was the one hole, so it is closed the same way — nothing is
 * written and the message names the form that works. Guessing "false means not done" would
 * be no better: it invites `--done no`, `--done 0`, `--done nope`, each of which has to be
 * guessed at again.
 */
const VALUELESS_FLAGS = ["done", "not-done", "force", "json", "write-probe"] as const;

function valuedBooleanFlag(args: Args): { flag: string; value: string } | null {
  for (const name of VALUELESS_FLAGS) {
    const v = args.flags.get(name);
    if (typeof v === "string") return { flag: name, value: v };
  }
  return null;
}

// ---------------------------------------------------------------- validation
//
// Every bound below rejects values that are physically implausible for this programme.
// The point is not to police the athletes; it is that a mis-parsed sentence usually
// produces an absurd number, and an absurd number is the one case we can catch.

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function validDate(raw: string): string | { error: string } {
  const s = raw.trim();
  if (!DATE_RE.test(s)) return { error: `날짜 형식이 YYYY-MM-DD가 아니야: "${raw}"` };
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) {
    return { error: `그런 날짜는 없어: "${raw}"` };
  }
  if (s < SEASON_START || s > RACE_DATE) {
    return { error: `${s}은 15주 프로그램 밖이야 (${SEASON_START} ~ ${RACE_DATE}).` };
  }
  return s;
}

/** `none`, `null` and `-` clear a stored value; anything else must parse cleanly. */
function isClear(raw: string): boolean {
  const s = raw.trim().toLowerCase();
  return s === "none" || s === "null" || s === "-";
}

/**
 * A flag whose value went missing: a trailing `--weight`, `--weight=`, `--weight ""`, or
 * `--weight --done` (parseArgs reads a following `--…` token as "this flag is boolean").
 *
 * Emphatically *not* a clear instruction. A dropped number is at least as ambiguous as a
 * mistyped one, and grid.ts already settles that case — an unusable value leaves the stored
 * value alone, "because an out-of-range number is a typo, not a request to erase a real
 * measurement". `none` is the one documented way to empty a cell, and the only one.
 */
function isMissingValue(raw: string): boolean {
  return raw.trim() === "";
}

function missingValue(flag: string): { error: string } {
  return {
    error:
      `--${flag} 뒤에 값이 없어. 빠뜨린 건지 비우려는 건지 알 수 없어서 아무것도 쓰지 않을게 — ` +
      `비우려면 --${flag} none.`,
  };
}

function validWeight(raw: string): number | null | { error: string } {
  if (isMissingValue(raw)) return missingValue("weight");
  if (isClear(raw)) return null;
  const n = Number(raw.trim().replace(/kg$/i, ""));
  if (!Number.isFinite(n)) return { error: `체중을 숫자로 못 읽겠어: "${raw}"` };
  if (n < 30 || n > 200) return { error: `체중 ${n}kg은 범위 밖이야 (30~200).` };
  return Math.round(n * 10) / 10;
}

/**
 * Bounds match `cells.ts` exactly, and that is the whole point of the constant below.
 *
 * They used to disagree: this function accepted up to 20:00 while `validPace` in cells.ts
 * caps at 15:00, and `applyPatch` drops anything the cell validator rejects. So every pace
 * between 15:01 and 20:00 was accepted here, silently discarded on the way into the cell,
 * and confirmed to the athlete as saved — exit 0, zero cells written. A CLI bound wider than
 * its cell bound is always that bug, so the cell's own limits are imported rather than
 * restated.
 */
const PACE_MIN_SEC = 120;
const PACE_MAX_SEC = 900;

function validPace(raw: string): number | null | { error: string } {
  if (isMissingValue(raw)) return missingValue("pace");
  if (isClear(raw)) return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(raw.trim());
  if (!m) return { error: `페이스는 M:SS 형식이어야 해: "${raw}"` };
  const seconds = Number(m[2]);
  if (seconds >= 60) return { error: `페이스 초가 60을 넘어: "${raw}"` };
  const total = Number(m[1]) * 60 + seconds;
  if (total < PACE_MIN_SEC || total > PACE_MAX_SEC) {
    return {
      error: `페이스 ${raw}/km은 범위 밖이야 (${formatPace(PACE_MIN_SEC)}~${formatPace(PACE_MAX_SEC)}).`,
    };
  }
  return total;
}

function validDuration(raw: string): number | null | { error: string } {
  if (isMissingValue(raw)) return missingValue("duration");
  if (isClear(raw)) return null;
  const n = Number(raw.trim().replace(/분$/, ""));
  if (!Number.isInteger(n)) return { error: `시간(분)은 정수여야 해: "${raw}"` };
  if (n < 1 || n > 600) return { error: `${n}분은 범위 밖이야 (1~600).` };
  return n;
}

function validRpe(raw: string): number | null | { error: string } {
  if (isMissingValue(raw)) return missingValue("rpe");
  if (isClear(raw)) return null;
  const n = Number(raw.trim().replace(/^rpe\s*/i, ""));
  if (!Number.isInteger(n)) return { error: `RPE는 정수여야 해: "${raw}"` };
  if (n < 1 || n > 10) return { error: `RPE ${n}은 범위 밖이야 (1~10).` };
  return n;
}

function isError(v: unknown): v is { error: string } {
  return typeof v === "object" && v !== null && "error" in v;
}

// ---------------------------------------------------------------- equipment-load guard
//
// A bare range check cannot tell 82kg of athlete from 152kg of sled, so the check is
// relative: to the last thing this athlete measured, and — when there is no such thing —
// to the goal weight they themselves declared.

/** Body weight does not move this far between sessions. */
const WEIGHT_JUMP_KG = 10;

/**
 * How far a *first* recorded weight may sit from the nearest goal weight on the sheet.
 *
 * Deliberately much wider than `WEIGHT_JUMP_KG`: a goal is a plan, and being far from it is
 * the entire reason for having one. This only has to separate "an athlete some way from
 * their target" from "a kettlebell".
 */
const FIRST_RECORD_GAP_KG = 25;

function gapKg(a: number, b: number): number {
  return Math.abs(Math.round((a - b) * 10) / 10);
}

/** Every goal weight this athlete declared — season-long and per phase — nearest first. */
function nearestDeclaredTarget(season: Season, player: PlayerId, to: number): number | null {
  const declared = [
    season.goals.bodyWeightKg[player],
    ...season.phases.map((p) => (player === "A" ? p.targetKgA : p.targetKgB)),
  ].filter((n): n is number => n !== null);
  if (declared.length === 0) return null;
  return declared.reduce((best, n) => (Math.abs(n - to) < Math.abs(best - to) ? n : best));
}

// ---------------------------------------------------------------- identity
//
// Writing a log to the wrong athlete's column is the worst thing this tool can do, and
// it is invisible once done. So identity is resolved by exact match only — never by
// prefix, substring, or best guess.

function resolveTelegram(raw: string): PlayerId | { error: string } {
  const found = telegramUsers()[raw.trim().toLowerCase()];
  if (!found) {
    return { error: `텔레그램 사용자 ${raw}가 누구인지 몰라. .env.local의 TELEGRAM_USER_A / TELEGRAM_USER_B를 확인해.` };
  }
  return found;
}

function resolveWho(raw: string, names: Record<PlayerId, string>): PlayerId | { error: string } {
  const key = raw.trim().toLowerCase();
  if (key === "a" || key === "b") return key.toUpperCase() as PlayerId;
  for (const p of PLAYER_IDS) {
    if (names[p].trim().toLowerCase() === key) return p;
  }
  return { error: `"${raw}"가 누구인지 몰라. --who a (${names.A}) 또는 --who b (${names.B}).` };
}

function resolvePlayer(args: Args): PlayerId | { error: string } {
  const names = playerNames();

  const rawTelegram = flagString(args, "telegram");
  const rawWho = flagString(args, "who");

  // An empty `--telegram` carries no identity at all, so it is treated as absent rather
  // than as a conflict: only one athlete has a known telegram id today, and a wrapper that
  // renders `--telegram "$TG_ID"` for the other one must still be able to fall back to
  // `--who`. An empty `--who`, by contrast, is a value the caller meant to supply.
  let fromTelegram: PlayerId | null = null;
  if (rawTelegram !== null && !isMissingValue(rawTelegram)) {
    const found = resolveTelegram(rawTelegram);
    if (isError(found)) return found;
    fromTelegram = found;
  }

  let fromWho: PlayerId | null = null;
  if (rawWho !== null) {
    const found = resolveWho(rawWho, names);
    if (isError(found)) return found;
    fromWho = found;
  }

  // Two identity flags that disagree are the same ambiguity as `--phase` with `--date`:
  // two different columns and no way to tell which was meant. Picking one files an
  // athlete's number under the other's name — and the sender of a message routinely is not
  // its subject, because onboarding asks one person for both athletes' goals at once.
  if (fromTelegram !== null && fromWho !== null && fromTelegram !== fromWho) {
    return {
      error:
        `--telegram은 ${names[fromTelegram]}, --who는 ${names[fromWho]}를 가리켜. ` +
        `누구 기록인지 알 수 없어서 아무것도 쓰지 않을게 — 맞는 쪽 하나만 줘.`,
    };
  }

  const resolved = fromWho ?? fromTelegram;
  if (resolved === null) {
    return { error: `--who 또는 --telegram이 필요해. --who a (${names.A}) 또는 --who b (${names.B}).` };
  }
  return resolved;
}

/**
 * Identity for a read-only command, where saying who you are is optional.
 *
 * `setup` reports on both athletes either way; knowing the speaker only changes which gaps
 * are called "네 것" and which flag the printed commands use. So an absent identity is a
 * valid call, but a *supplied* one that does not resolve is still an error — silently
 * ignoring a mistyped `--who` would scope the answer to the wrong person.
 */
function resolveOptionalPlayer(args: Args): PlayerId | null | { error: string } {
  const rawTelegram = flagString(args, "telegram");
  const rawWho = flagString(args, "who");
  const hasTelegram = rawTelegram !== null && !isMissingValue(rawTelegram);
  if (rawWho === null && !hasTelegram) return null;
  return resolvePlayer(args);
}

// ---------------------------------------------------------------- rendering

function statusLine(record: { date: string; area: string; isRest: boolean; A: unknown; B: unknown }): string {
  const names = playerNames();
  const r = record as Parameters<typeof describeDay>[0];
  const mark = (p: PlayerId) => (r.isRest ? "·" : r[p].done ? "✅" : "⬜️");
  return `${r.date} ${r.area} — ${names.A} ${mark("A")} / ${names.B} ${mark("B")}`;
}

function describeDay(record: import("./grid.ts").DayRecord): string {
  const names = playerNames();
  const lines: string[] = [];
  lines.push(`${formatDday(record.date)} · ${record.date} (${record.weekday}) · W${record.week}`);
  lines.push(record.isRest ? "휴식일" : record.area);
  if (record.plan) lines.push(record.plan);
  if (record.paceTarget) lines.push(`🎯 ${record.paceTarget}`);
  lines.push("");
  for (const p of PLAYER_IDS) {
    const log = record[p];
    const bits = [
      log.done ? "✅ 완료" : "⬜️ 미기록",
      log.weightKg !== null ? `${log.weightKg}kg` : null,
      // `goal --date` writes this column, so it has to be readable back somewhere. This is
      // the only text surface that shows one day's target, and without it the value is
      // write-only: the tool would confirm "83kg" and then report it as unset forever after.
      log.targetKg !== null ? `목표 ${log.targetKg}kg` : null,
      log.paceSecPerKm !== null ? `${formatPace(log.paceSecPerKm)}/km` : null,
      log.durationMin !== null ? `${log.durationMin}분` : null,
      log.rpe !== null ? `RPE ${log.rpe}` : null,
      log.altWorkout ? `대체: ${log.altWorkout}` : null,
      log.memo ? `메모: ${log.memo}` : null,
      log.commitment ? `약속: ${log.commitment}` : null,
    ].filter(Boolean);
    lines.push(`${names[p]} — ${bits.join(" · ")}`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------- target rendering

function weightText(kg: number | null): string {
  return kg === null ? "미입력" : `${kg}kg`;
}

/**
 * What one structural mismatch actually blocks.
 *
 * The three tabs are gated independently on purpose (store.ts: "a mangled goal tab must not
 * stop the athletes from recording sessions"), and each write path re-checks only its own
 * tab. So a blanket "쓰기를 전부 거부해" is false in both directions, and both cost
 * something: it tells the athletes daily logging is dead when it is fine, or it calls a
 * write blocked in the same session in which that write lands.
 */
function blockedBy(m: GridMismatch): string {
  const tab = m.tab ?? SHEET_LOG_TAB;
  if (tab === SHEET_GOAL_TAB) return "시즌 전체 목표(goal --weight) 쓰기가 거부돼";
  if (tab === SHEET_PHASE_TAB) return "단계별 목표(goal --phase) 쓰기가 거부돼";
  // The log tab's header pins every column, so a header mismatch gates the whole tab. A row
  // anchor gates only that row: loadDay filters the mismatches down to the row being written.
  const date = dateForRow(m.row);
  return date === null
    ? "일지 탭 쓰기(log, goal --date) 전체가 거부돼"
    : `${date} 기록(log, goal --date)이 거부돼`;
}

/**
 * The ⚠️ block: every broken tab, and only what each one really refuses.
 *
 * One line per tab, because a single row shift can misalign all 105 log rows at once. The
 * representative is the lowest row, so a header mismatch — which gates a whole tab — wins
 * over a single displaced row inside it.
 */
function misalignmentLines(problems: GridMismatch[]): string[] {
  if (problems.length === 0) return [];
  const order: string[] = [];
  const worst = new Map<string, GridMismatch>();
  for (const m of problems) {
    const tab = m.tab ?? SHEET_LOG_TAB;
    if (!worst.has(tab)) order.push(tab);
    const kept = worst.get(tab);
    if (!kept || m.row < kept.row) worst.set(tab, m);
  }
  const lines = ["⚠️ 시트 구조가 어긋나 있어. 고치기 전까지 아래만 거부해 (나머지 쓰기는 그대로 동작해):"];
  for (const tab of order) {
    const m = worst.get(tab)!;
    lines.push(`  · ${tab} ${m.column}${m.row} — ${blockedBy(m)}`);
  }
  return lines;
}

function describeGoals(season: Season): string {
  const names = playerNames();
  const g = season.goals;
  const lines: string[] = [];

  lines.push("🎯 목표 몸무게");
  lines.push(...misalignmentLines(season.misalignedRows));
  lines.push("");
  lines.push(`시즌 전체 — ${names.A} ${weightText(g.bodyWeightKg.A)} / ${names.B} ${weightText(g.bodyWeightKg.B)}`);
  lines.push("");
  for (let n = 1; n <= PHASE_COUNT; n++) {
    const phase = phaseByNumber(season.phases, n as PhaseNumber);
    // The slot is an absolute row, so on a shifted tab the phase sitting in slot 2 is
    // named "Phase 1". Printing that name alone is how `goal show` told a reader that
    // Phase 2 was 기초 & 스피드 구축; the slot has to be stated when it disagrees.
    lines.push(
      phase === null
        ? `Phase ${n} (시트에서 못 읽음)`
        : isPhaseNamed(n, phase.name)
          ? phase.name
          : `Phase ${n} 자리에 "${phase.name}"이 있어 (시트가 어긋났어)`,
    );
    lines.push(
      `  ${names.A} ${weightText(phase?.targetKgA ?? null)} / ${names.B} ${weightText(phase?.targetKgB ?? null)}`,
    );
  }
  lines.push("");
  // Authored text, printed verbatim. Nothing here is parsed or written back — "5분대 후반"
  // is a nuance a human wrote, and re-rendering it through a pace parser would erase it.
  lines.push("참고 — 시트에 적힌 그대로 (수정 대상 아님)");
  for (const [label, row] of [
    ["단독 러닝 페이스", g.soloPace],
    ["HYROX 중 1km", g.hyroxPace],
    ["더블 완주 기록", g.finish],
  ] as const) {
    const bits = [
      row.A ? `${names.A} ${row.A}` : "",
      row.B ? `${names.B} ${row.B}` : "",
      row.team ? `팀 ${row.team}` : "",
    ].filter(Boolean);
    if (bits.length) lines.push(`  ${label} — ${bits.join(" · ")}`);
  }
  return lines.join("\n").trim();
}

/**
 * The onboarding checklist, in the three tiers the report distinguishes.
 *
 * Only the first block is a to-do list. The other two are stated as facts and left alone —
 * a phase ladder nobody wants is a finished state, not a red one, and printing eight
 * outstanding commands under the same heading as the two that matter is what taught
 * everybody to skip this output.
 */
function describeSetup(report: Onboarding): string {
  const names = playerNames();
  const lines: string[] = [];

  lines.push("🧭 목표 값 온보딩 체크");
  // Per-tab, because the tabs refuse writes independently: a shifted log row must not be
  // relayed as "목표를 못 쓴다", and a shifted goal tab must not read as "기록을 못 한다".
  lines.push(...misalignmentLines(report.misaligned));
  // A range that could not be read at all produces no mismatch to hang a line off — there is
  // no cell to name. It still refuses every write, so each needs its own ⚠️: `blocked` must
  // always be visible in the text, not only in --json.
  if (report.blockReasons.includes("goal-tab-unreadable")) {
    lines.push(`⚠️ ${SHEET_GOAL_TAB} 탭의 1번 표를 읽지 못했어 — 시즌 전체 목표(goal --weight) 쓰기가 거부돼.`);
  }
  if (report.blockReasons.includes("phase-tab-unreadable")) {
    lines.push(`⚠️ ${SHEET_PHASE_TAB} 탭을 읽지 못했어 — 단계별 목표(goal --phase) 쓰기가 거부돼.`);
  }
  if (report.blockReasons.includes("phase-header-unreadable")) {
    lines.push(`⚠️ ${SHEET_PHASE_TAB} 탭의 헤더(3행)를 읽지 못했어 — 단계별 목표(goal --phase) 쓰기가 거부돼.`);
  }
  // Not a structural break, so it blocks one cell rather than the tier — but the number in
  // it cannot be read, and asking for a replacement is what would destroy what is written.
  for (const c of report.unreadableGoalCells) {
    lines.push(
      `⚠️ ${names[c.player]}의 ${c.cell} 칸에 "${c.text}"가 적혀 있어 — 숫자로 못 읽어서 미입력으로도, 입력으로도 세지 않아. 시트에서 직접 고쳐줘.`,
    );
  }
  lines.push("");

  const req = report.progress.required;
  lines.push(`필수 · 시즌 전체 목표 — ${req.total}칸 중 ${req.filled}칸`);
  lines.push(`  ${names.A} ${weightText(report.goal.A)} / ${names.B} ${weightText(report.goal.B)}`);
  lines.push("");

  const rec = report.progress.recommended;
  lines.push(`선택 · 단계별 목표 — ${rec.total}칸 중 ${rec.filled}칸`);
  for (const p of report.phases) {
    const label = p.name || `Phase ${p.phase} (시트에서 못 읽음)`;
    lines.push(`  ${label} — ${names.A} ${weightText(p.A)} / ${names.B} ${weightText(p.B)}`);
  }
  lines.push("");
  lines.push(
    `선택 · 일별 목표 — ${report.log.days}일 중 ${names.A} ${report.log.filled.A}칸 · ${names.B} ${report.log.filled.B}칸`,
  );
  lines.push("");

  const required = report.missing.filter((m) => m.tier === "required");
  const recommended = report.missing.filter((m) => m.tier === "recommended");

  if (req.blocked) {
    lines.push(
      report.blockReasons.includes("goal-tab-unreadable")
        ? "필수 목표는 탭을 읽지 못해서 지금은 쓸 수 없어. 명령은 생략할게 — 지금 실행하면 거부돼."
        : "필수 목표는 시트 구조를 고치기 전에는 쓸 수 없어. 명령은 생략할게 — 지금 실행하면 거부돼.",
    );
    // A cell with authored text in it is not a gap and not a filled value, so it must not
    // fall through to "다 채워졌어" — that would call onboarding finished on a cell nobody
    // can read, and on a tier that `complete` still (correctly) reports as unfinished.
  } else if (required.length === 0 && report.unreadableGoalCells.length === 0) {
    lines.push("필수 목표는 다 채워졌어. 온보딩은 여기까지야.");
  } else if (required.length === 0) {
    lines.push("남은 필수 칸은 위에 적힌 그대로야 — 숫자를 물어봐도 지금은 쓸 수 없어. 시트를 먼저 고쳐줘.");
  } else {
    // A goal belongs to exactly one person, so the speaker's own gap and the partner's are
    // two different asks: one is answerable in this conversation, the other has to come
    // from the partner. Splitting them is what stops "우리 목표 80kg" being written twice.
    const mine = report.speaker === null ? [] : required.filter((m) => m.player === report.speaker);
    const theirs = required.filter((m) => !mine.includes(m));
    const nameList = (gaps: typeof required) => gaps.map((m) => names[m.player]).join(" · ");

    if (mine.length > 0) {
      lines.push(`아직 ${required.length}칸 비어 있어 — 그 중 네 거 ${mine.length}칸. kg만 채워서 그대로 실행하면 돼:`);
      for (const m of mine) lines.push(`  ${m.command}`);
      if (theirs.length > 0) {
        lines.push("");
        lines.push(`${nameList(theirs)} 것도 비어 있어 — 숫자는 본인한테 직접 들어야 해:`);
        for (const m of theirs) lines.push(`  ${m.command}`);
      }
    } else if (report.speaker !== null) {
      lines.push(`네 건 다 됐어. ${nameList(theirs)} 것만 남았어 — 숫자는 본인한테 직접 들어야 해:`);
      for (const m of theirs) lines.push(`  ${m.command}`);
    } else {
      lines.push(`아직 필수 ${required.length}칸 비어 있어. kg만 채워서 그대로 실행하면 돼:`);
      for (const m of required) lines.push(`  ${m.command}`);
    }
  }

  if (rec.blocked) {
    lines.push("");
    lines.push(
      report.blockReasons.includes("phase-tab-unreadable")
        ? "단계별 목표는 탭을 읽지 못해서 지금은 쓸 수 없어."
        : report.blockReasons.includes("phase-header-unreadable")
          ? "단계별 목표는 헤더(3행)를 읽지 못해서 지금은 쓸 수 없어."
          : "단계별 목표는 시트를 고치기 전에는 쓸 수 없어.",
    );
  } else if (recommended.length > 0) {
    lines.push("");
    lines.push("단계별 목표는 선택이야. 원하면 이걸로, 아니면 비워둬도 끝난 거야:");
    for (const m of recommended) lines.push(`  ${m.command}`);
  }
  return lines.join("\n");
}

function describeTargetSave(result: TargetSaveResult): string {
  const names = playerNames();
  const scope =
    result.where === "goal"
      ? "시즌 전체 목표"
      : result.where === "phase"
        ? `${result.phase!.name} 목표`
        : `${result.date} 목표`;
  const after = result.after === null ? "비움" : `${result.after}kg`;
  const before = result.before === null ? "미입력" : `${result.before}kg`;
  const detail =
    result.written === 0 ? "이미 같은 값이라 그대로 뒀어." : `${before} → ${after} · ${result.range}`;
  return `${names[result.player]} · ${scope} — ${after}\n${detail}`;
}

/**
 * Built per call rather than frozen into a constant, because the first line has to name the
 * path this CLI is actually reachable at. `hyrox` is not on anyone's PATH — the agent execs
 * with `shell: false` and the gateway's PATH — so a help text headed by the bare word taught
 * the one invocation that exits 127.
 */
function helpText(): string {
  const cli = cliCommand();
  return `hyrox — HYROX Doubles 15주 시트 도구

실행 (PATH에 없어 — 절대 경로로 불러야 해)
  ${cli} <command> [options]

  today [--json]                 오늘 세션과 두 사람의 기록
  day <YYYY-MM-DD> [--json]      특정 날짜
  week [<YYYY-MM-DD>] [--json]   그 날짜가 속한 주
  stats --who <a|b> [--json]     시즌 누적
  setup [<대상>] [--json]        목표 값 중 아직 비어 있는 것 (온보딩)
                                 대상을 주면 네 것부터 알려줌 (읽기 전용, 선택)
  diet [<YYYY-MM-DD>] [--json]   그날 두 사람 식단
  meal <대상> --<끼니> <내용>     식단 기록 (끼니: 아침/점심/저녁/간식)
  goal show [--json]             목표 몸무게 전부 보기
  goal <대상> [--phase N|--date D] --weight <kg>
                                 목표 몸무게 저장
  brief <morning|nudge|weekly> [--date <YYYY-MM-DD>]
                                 정해진 시각에 보낼 문구 (nudge/weekly는 없으면 빈 출력)
  log <대상> [값...]              기록 저장
  doctor [--telegram <id>] [--json] [--write-probe]
                                 배선 자가 진단 (설정·신원·시트·기록 신선도)

기록 대상 (하나 필수)
  --who <a|b|이름>               선수 지정
  --telegram <user-id>           텔레그램 사용자 id로 지정 (권장)

기록 값 (원하는 것만)
  --date <YYYY-MM-DD>            기본값은 오늘
  --done / --not-done            완료 여부
  --weight <kg>                  30~200
  --pace <M:SS>                  2:00~15:00
  --duration <분>                1~600
  --rpe <1-10>
  --memo <텍스트>
  --alt <텍스트>                 대체 운동
  --force                        직전 체중과 10kg 넘게 차이나도 저장

  --done / --not-done / --force / --json / --write-probe 는 값을 받지 않아.
  --done false 처럼 뒤에 값을 붙이면 아무것도 쓰지 않고 거부해.

목표 몸무게 (goal)
  --phase <1-4>                  단계별 목표 (15주 단계별 요약 탭)
  --date <YYYY-MM-DD>            그 날 목표 (일지 탭). --phase와 같이 못 씀
  (둘 다 없으면)                  시즌 전체 목표 (목표 및 더블 운영 원칙 탭)
  --force                        칸에 적힌 사람이 쓴 메모를 덮어써도 될 때만

  값 자리에 none 을 주면 그 칸을 비움. 예: --pace none
  같은 옵션을 두 번 주면 아무것도 쓰지 않아. 두 사람 것은 명령을 따로 실행해.`;
}

// ---------------------------------------------------------------- commands

export async function runCli(
  argv: string[],
  client: SheetsClient,
  today: string = todayInSeasonTz(),
): Promise<CliResult> {
  const args = parseArgs(argv);

  // Before anything reads the sheet. "둘 다 목표 82kg으로 하자" is exactly the sentence that
  // makes an agent try to cover both athletes in one command line, and `--who a --who b`
  // used to exit 0 having written only B's cell. Two writes or none — never one of them
  // under the other's name.
  if (args.repeated.length > 0) {
    const named = args.repeated.map((f) => `--${f}`).join(", ");
    return usage(
      `${named}를 두 번 줬어. 어느 쪽을 뜻하는지 알 수 없어서 아무것도 쓰지 않을게 — 하나만 줘. ` +
        `두 사람 것을 다 쓰려면 명령을 따로 실행해.`,
    );
  }

  // Before the sheet is read, for the same reason as the repeated-flag check above: the
  // ambiguity is in the command line, so no amount of sheet state can resolve it.
  const valued = valuedBooleanFlag(args);
  if (valued) {
    const shown = valued.value === "" ? "(빈 값)" : `"${valued.value}"`;
    return usage(
      `--${valued.flag}는 값을 받지 않는 플래그인데 뒤에 ${shown}가 붙었어. ` +
        `값을 무시하면 --${valued.flag} false가 완료로 저장되고, --${valued.flag} 109처럼 붙은 숫자는 소리 없이 사라져 — ` +
        `아무것도 쓰지 않을게. 완료면 --done만, 안 했으면 --not-done만 주고, 숫자는 각자 플래그로 줘 (--weight 109).`,
    );
  }

  const command = (args.positional[0] ?? "help").toLowerCase();
  const json = flagBool(args, "json");

  try {
    switch (command) {
      case "help":
      case "--help":
      case "-h":
        return ok(helpText());

      case "today":
      case "day": {
        const raw = command === "today" ? today : args.positional[1];
        if (!raw) return usage(`날짜가 필요해: ${cliCommand()} day 2026-08-07`);
        const date = validDate(raw);
        if (isError(date)) return usage(date.error);
        const record = await loadDay(client, date);
        if (!record) return usage(`${date}은 15주 프로그램 밖이야 (${SEASON_START} ~ ${RACE_DATE}).`);
        return ok(json ? JSON.stringify(record, null, 2) : describeDay(record));
      }

      case "week": {
        const raw = args.positional[1] ?? today;
        const date = validDate(raw);
        if (isError(date)) return usage(date.error);
        const season = await loadSeason(client);
        const week = recordsForWeek(season.records, date);
        if (week.length === 0) return ok("그 주에는 데이터가 없어.");
        if (json) return ok(JSON.stringify(week, null, 2));
        const head = `W${week[0].week} (${week[0].date} ~ ${week[week.length - 1].date})`;
        return ok([head, ...week.map(statusLine)].join("\n"));
      }

      case "stats": {
        const player = resolvePlayer(args);
        if (isError(player)) return usage(player.error);
        const season = await loadSeason(client);
        const upto = season.records.filter((r) => r.date <= today);
        const s = summarize(upto, player);
        const run = streak(season.records, player, today);
        if (json) return ok(JSON.stringify({ player, ...s, streak: run }, null, 2));
        const names = playerNames();
        return ok(
          [
            `${names[player]} — 시즌 누적`,
            `완료 ${s.done}/${s.planned} (${Math.round(s.completion * 100)}%)`,
            `연속 ${run}일`,
            s.weightLast !== null
              ? `체중 ${s.weightLast}kg (${s.weightDelta !== null && s.weightDelta > 0 ? "+" : ""}${s.weightDelta ?? 0})`
              : "체중 기록 없음",
            s.avgPaceSecPerKm !== null ? `평균 페이스 ${formatPace(s.avgPaceSecPerKm)}/km` : "페이스 기록 없음",
            s.bestPaceSecPerKm !== null ? `최고 페이스 ${formatPace(s.bestPaceSecPerKm)}/km` : "",
          ]
            .filter(Boolean)
            .join("\n"),
        );
      }

      // Read-only, and identity is optional: the report covers both athletes either way.
      // Naming the speaker only decides whose gaps are "네 것" and which flag is printed.
      case "setup": {
        const speaker = resolveOptionalPlayer(args);
        if (isError(speaker)) return usage(speaker.error);
        const rawTelegram = flagString(args, "telegram");
        const season = await loadSeason(client);
        const report = onboardingReport(
          season,
          speaker === null
            ? null
            : {
                player: speaker,
                telegram: rawTelegram !== null && rawTelegram.trim() !== "" ? rawTelegram.trim() : null,
              },
        );
        return ok(json ? JSON.stringify(report, null, 2) : describeSetup(report));
      }

      // The 목표 몸무게 in all three places it is kept. Deliberately separate from `log`:
      // a target is a plan, a log is a measurement, and merging them would let a sentence
      // about one be written as the other.
      case "goal": {
        const sub = (args.positional[1] ?? "").toLowerCase();
        if (sub === "show") {
          const season = await loadSeason(client);
          const shown = {
            season: season.goals.bodyWeightKg,
            phases: season.phases.map((p) => ({ row: p.row, name: p.name, A: p.targetKgA, B: p.targetKgB })),
            reference: { soloPace: season.goals.soloPace, hyroxPace: season.goals.hyroxPace, finish: season.goals.finish },
            misaligned: season.misalignedRows,
          };
          return ok(json ? JSON.stringify(shown, null, 2) : describeGoals(season));
        }
        if (sub) {
          return usage(
            `goal의 하위 명령은 show뿐이야: "${sub}"\n목표를 저장하려면: ${cliCommand()} goal --who a --weight 82`,
          );
        }

        const player = resolvePlayer(args);
        if (isError(player)) return usage(player.error);

        const rawPhase = flagString(args, "phase");
        const rawDate = flagString(args, "date");
        // Two different cells, and no way to tell which was meant. Refuse rather than pick.
        if (rawPhase !== null && rawDate !== null) {
          return usage("--phase와 --date를 같이 줄 수는 없어. 단계별 목표면 --phase, 특정 날짜 목표면 --date 하나만 써.");
        }

        const rawWeight = flagString(args, "weight");
        if (rawWeight === null) {
          return usage(`목표 몸무게가 필요해: ${cliCommand()} goal --who a --weight 82 (비우려면 --weight none)`);
        }
        const kg = validWeight(rawWeight);
        if (isError(kg)) return usage(kg.error);

        // Only overrides the "someone wrote text in this cell" refusal. Every structural
        // anchor stays in force: --force is about content, never about geometry.
        const force = flagBool(args, "force");

        if (rawPhase !== null) {
          const n = Number(rawPhase.trim());
          if (!Number.isInteger(n) || n < 1 || n > PHASE_COUNT) {
            return usage(`--phase는 1~${PHASE_COUNT} 중 하나여야 해: "${rawPhase}"`);
          }
          const result = await savePhaseTarget(client, n as PhaseNumber, player, kg, { force });
          return ok(json ? JSON.stringify(result, null, 2) : describeTargetSave(result));
        }

        if (rawDate !== null) {
          const date = validDate(rawDate);
          if (isError(date)) return usage(date.error);
          const result = await saveLogTarget(client, date, player, kg, { force });
          return ok(json ? JSON.stringify(result, null, 2) : describeTargetSave(result));
        }

        const result = await saveGoalWeight(client, player, kg, { force });
        return ok(json ? JSON.stringify(result, null, 2) : describeTargetSave(result));
      }

      case "brief": {
        const kind = (args.positional[1] ?? "").toLowerCase();
        const raw = flagString(args, "date") ?? today;
        const date = validDate(raw);
        if (isError(date)) return usage(date.error);
        const season = await loadSeason(client);

        if (kind === "morning") return ok(morningBrief(season, date).join("\n\n---\n\n"));
        if (kind === "nudge") return ok(nudgeBrief(season, date) ?? "");
        if (kind === "weekly") {
          // Weeks run Saturday→Friday, so on Sunday the week that just closed is the one
          // two days back. Any other day reviews the week seven days back.
          const anchor = weekdayKo(date) === "일요일" ? addDaysSafe(date, -2) : addDaysSafe(date, -7);
          return ok(weeklyBrief(season, anchor) ?? "");
        }
        return usage("brief는 morning | nudge | weekly 중 하나여야 해.");
      }

      case "meal": {
        const player = resolvePlayer(args);
        if (isError(player)) return usage(player.error);

        const rawDate = flagString(args, "date") ?? today;
        const date = validDate(rawDate);
        if (isError(date)) return usage(date.error);

        const { MEALS, MEAL_KO } = await import("./season.ts");
        const { describeMeals, mealsLogged } = await import("./diet.ts");
        const { loadDietDay, saveMeals } = await import("./store.ts");

        const patch: Record<string, string | null> = {};
        const cleared: string[] = [];
        for (const meal of MEALS) {
          // Both the English key and the Korean word work, because the agent is reading
          // Korean and the athletes say 아침, not breakfast.
          const raw = flagString(args, meal) ?? flagString(args, MEAL_KO[meal]);
          if (raw === null) continue;
          if (isMissingValue(raw)) {
            // Same rule as --memo: a dropped value is ambiguous, and food text is exactly
            // what nobody wants to retype. Announce rather than erase in silence.
            cleared.push(MEAL_KO[meal]);
          }
          patch[meal] = isClear(raw) ? null : raw.trim();
        }

        if (Object.keys(patch).length === 0) {
          const names = playerNames();
          return usage(
            `어떤 끼니인지 알려줘: ${MEALS.map((m) => `--${MEAL_KO[m]} "<먹은 것>"`).join(" / ")}. ` +
              `예: meal --who a --저녁 "닭가슴살 200g + 현미밥"  (${names[player]})`,
          );
        }

        const saved = await saveMeals(client, date, player, patch);
        const after = await loadDietDay(client, date);
        if (!after) return failure(`${date} 식단은 저장했는데 다시 읽지 못했어.`);

        const names = playerNames();
        if (json) return ok(JSON.stringify(after, null, 2));

        const lines = [`${names[player]} · ${date} 식단`, describeMeals(after[player])];
        for (const c of cleared) {
          const had = saved.before[MEALS.find((m) => MEAL_KO[m] === c)!];
          if (had) lines.push(`⚠️ --${c} 뒤에 값이 없어서 지웠어: "${had}" — 비울 생각이 아니었으면 다시 넣어줘.`);
        }
        const other: PlayerId = player === "A" ? "B" : "A";
        lines.push(`${names[other]} — ${mealsLogged(after[other])}/4 끼니 기록됨`);
        return ok(clampMessage(lines.join("\n")));
      }

      case "diet": {
        const rawDate = args.positional[1] ?? flagString(args, "date") ?? today;
        const date = validDate(rawDate);
        if (isError(date)) return usage(date.error);

        const { MEAL_KO } = await import("./season.ts");
        const { describeMeals } = await import("./diet.ts");
        const { loadDietDay } = await import("./store.ts");

        const day = await loadDietDay(client, date);
        if (!day) return usage(`${date}은 15주 프로그램 밖이야 (${SEASON_START} ~ ${RACE_DATE}).`);
        if (json) return ok(JSON.stringify(day, null, 2));

        const names = playerNames();
        const lines = [`🥗 ${date} 식단`];
        for (const p of PLAYER_IDS) lines.push(`${names[p]} — ${describeMeals(day[p])}`);
        void MEAL_KO;
        return ok(clampMessage(lines.join("\n")));
      }

      case "log": {
        const player = resolvePlayer(args);
        if (isError(player)) return usage(player.error);

        const rawDate = flagString(args, "date") ?? today;
        const date = validDate(rawDate);
        if (isError(date)) return usage(date.error);

        const patch: LogPatch = {};

        if (flagBool(args, "done") && flagBool(args, "not-done")) {
          return usage("--done과 --not-done을 같이 줄 수는 없어.");
        }
        if (flagBool(args, "done")) patch.done = true;
        if (flagBool(args, "not-done")) patch.done = false;

        const numeric: [string, (r: string) => number | null | { error: string }, keyof LogPatch][] = [
          ["weight", validWeight, "weightKg"],
          ["pace", validPace, "paceSecPerKm"],
          ["duration", validDuration, "durationMin"],
          ["rpe", validRpe, "rpe"],
        ];
        for (const [flag, check, field] of numeric) {
          const raw = flagString(args, flag);
          if (raw === null) continue;
          const value = check(raw);
          if (isError(value)) return usage(value.error);
          (patch as Record<string, unknown>)[field] = value;
        }

        // Two things are tracked alongside the patch, and both exist because the old code
        // could destroy text and still exit 0.
        //
        // `clearedByOmission` is the `--alt --done` case: parseArgs reads a following `--…`
        // token as "this flag is boolean", so a dropped shell variable becomes an erase
        // instruction. The numeric flags refuse that outright (see `isMissingValue`), but
        // these two cannot — `--memo --done` clearing the memo is documented, tested and
        // relied upon. So the erase still happens and is *announced*, with the old text
        // quoted back so it can be restored from the confirmation message alone. A long WOD
        // is the hardest field to retype and the only one a dropped variable can destroy.
        const clearedByOmission: { flag: string; label: string; field: "memo" | "altWorkout" | "commitment" }[] = [];
        const truncated: string[] = [];

        for (const [flag, field, label] of [
          ["memo", "memo", "메모"],
          ["alt", "altWorkout", "대체 운동"],
          ["commit", "commitment", "오늘 약속"],
        ] as const) {
          const raw = flagString(args, flag);
          if (raw === null) continue;
          if (isMissingValue(raw)) clearedByOmission.push({ flag, label, field });
          if (cleanText(raw).length < cleanText(raw, Number.MAX_SAFE_INTEGER).length) truncated.push(label);
          (patch as Record<string, unknown>)[field] = isClear(raw) ? null : raw.trim();
        }

        if (Object.keys(patch).length === 0) {
          return usage("저장할 내용이 없어. --done, --weight, --pace, --duration, --rpe, --memo, --alt, --commit 중에 줘.");
        }

        // A bare range check cannot tell 82kg of athlete from 152kg of sled — both are
        // plausible weights, and "슬레드 152kg" is exactly the sentence a model misreads.
        // Body weight does not move 10kg between sessions, so compare against what this
        // athlete last recorded: an equipment load shows up as an impossible jump.
        //
        // `<=`, not `<`: the baseline has to include the day being written. A session
        // arrives across several messages — "런 하고 KB 스윙 30개 (16/24kg) … 몸무게 109키로",
        // then the fatigue score, then the pace — and the equipment numbers are in the same
        // burst as the real weight. Comparing only against *previous* days armed the guard
        // against yesterday while leaving it blind to the message thirty seconds ago, which
        // is exactly where a mis-parsed load comes from. The season snapshot is read before
        // the write, so this can never compare a value against itself.
        if (typeof patch.weightKg === "number" && !flagBool(args, "force")) {
          const season = await loadSeason(client);
          const previous = season.records
            .filter((r) => r.date <= date && r[player].weightKg !== null)
            .at(-1);
          const last = previous?.[player].weightKg ?? null;
          if (last !== null) {
            if (Math.abs(patch.weightKg - last) > WEIGHT_JUMP_KG) {
              // Naming it "직전 기록" when `previous.date === date` was a lie about the only
              // fact that lets a reader judge the refusal: it is this athlete's own row for
              // today, usually written seconds ago by the same burst of messages.
              const where =
                previous!.date === date
                  ? `오늘 이미 기록된 값(${last}kg)`
                  : `직전 기록(${previous!.date} ${last}kg)`;
              return usage(
                `체중 ${patch.weightKg}kg은 ${where}에서 ${gapKg(patch.weightKg, last)}kg 차이야. ` +
                  `장비 무게를 체중으로 잘못 읽은 게 아닌지 확인해줘. ` +
                  `맞다면 --force를 붙이고, 장비 무게라면 --memo에 적어.`,
              );
            }
          } else {
            // No measurement on record, which is exactly the state a newly added athlete is
            // in — and the state in which this guard used to do nothing at all. A first value
            // is not merely unchecked: it becomes the baseline, so an equipment load written
            // first makes the *correct* weight the thing refused afterwards, with a message
            // that tells the agent to suspect the correct number of being equipment. First
            // number wins, permanently, unless a human notices.
            //
            // The athlete's own declared goal weight settles it, and `loadSeason` has already
            // put it in this very object. It is a plan rather than a measurement, so the band
            // is wide — a season's worth of intended change and then some. 30kg of kettlebell
            // against a declared 100kg target is not within any of it.
            const nearest = nearestDeclaredTarget(season, player, patch.weightKg);
            if (nearest !== null && Math.abs(patch.weightKg - nearest) > FIRST_RECORD_GAP_KG) {
              return usage(
                `체중 ${patch.weightKg}kg은 ${playerNames()[player]}의 목표 체중(${nearest}kg)에서 ` +
                  `${gapKg(patch.weightKg, nearest)}kg 차이인데, 아직 잰 체중 기록이 없어서 비교할 직전 값이 없어. ` +
                  `장비 무게를 체중으로 잘못 읽은 게 아닌지 확인해줘. ` +
                  `맞다면 --force를 붙이고, 장비 무게라면 --memo에 적어.`,
              );
            }
          }
        }

        const saved = await saveLog(client, date, player, patch);
        // Re-read so the confirmation reflects what the sheet actually holds, including
        // the partner's status — not what we hoped we wrote.
        const after = await loadDay(client, date);
        if (!after) return failure(`${date} 기록은 저장했는데 다시 읽지 못했어.`);

        // Anything that changed the stored text in a way the athlete did not ask for. Both
        // of these used to happen at exit 0 with nothing said, which is the worst shape a
        // data loss can take: the athlete is told it saved.
        const notes: string[] = [];
        for (const c of clearedByOmission) {
          const before = saved.before[c.field];
          if (!before) continue;
          notes.push(
            `⚠️ --${c.flag} 뒤에 값이 없어서 ${c.label}를 지웠어: "${before}" — ` +
              `지울 생각이 아니었으면 다시 넣어줘 (일부러 비울 때는 --${c.flag} none).`,
          );
        }
        if (truncated.length > 0) {
          notes.push(`⚠️ ${truncated.join(", ")} 설명이 ${MAX_CELL_TEXT}자를 넘어서 뒤를 잘랐어.`);
        }
        // The 실체중/완료 cell is documented as hand-editable, so people leave notes in it —
        // "아침 공복으로 다시 잴 예정". A single `--weight` replaces the whole cell and the
        // note is gone with no way to recover it. The write still goes through, because a
        // session record must never be blocked by a note, but it is quoted back the way a
        // cleared memo already is, so it can be restored from the confirmation alone.
        const replacedStatusText = saved.beforeText.status;
        if (
          hasAuthoredStatusText(replacedStatusText) &&
          formatStatusCell({ done: saved.after.done, weightKg: saved.after.weightKg }) !==
            replacedStatusText.trim()
        ) {
          notes.push(
            `⚠️ 실체중/완료 칸에 사람이 쓴 내용이 있었는데 덮어썼어: "${replacedStatusText.trim()}" — ` +
              `살려야 하면 --memo로 옮겨줘.`,
          );
        }
        if (json) return ok(JSON.stringify({ ...after, notes }, null, 2));
        return ok(clampMessage([savedBrief(after, player), ...notes].join("\n")));
      }

      /**
       * Self-diagnosis. The one command whose job is to answer "왜 아무 일도 안 일어나?".
       *
       * It owns its exit code rather than inheriting one: the report already classifies every
       * failure as local (1) or sheet (2), and it must never throw — `runDoctor` turns an
       * exception inside any check into that check's FAIL line, so even a completely broken
       * environment still prints the twelve things that ARE known.
       */
      case "doctor": {
        const report = await runDoctor(client, today, {
          telegram: flagString(args, "telegram"),
          writeProbe: flagBool(args, "write-probe"),
        });
        const out = json ? JSON.stringify(report, null, 2) : renderDoctor(report);
        return { code: report.exitCode, out, stdout: true };
      }

      default:
        return usage(`모르는 명령이야: ${command}\n\n${helpText()}`);
    }
  } catch (err) {
    return failure(err instanceof Error ? err.message : String(err));
  }
}

function addDaysSafe(date: string, delta: number): string | null {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  const s = d.toISOString().slice(0, 10);
  return s < SEASON_START || s > RACE_DATE ? null : s;
}

/** Exported for the season-long eval, which needs the same status rendering. */
export { describeDay, statusLine, findByDate };
